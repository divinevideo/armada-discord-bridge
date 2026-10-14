/**
 * End-to-end importer pipeline test: fake DB + in-memory relay wire. Runs
 * confirm() through the whole pipeline, then verifies the published events
 * the way a real Armada client would — resolve the minted invite, fold the
 * control plane, and check channels, roles, the admin grant, and the public
 * invite registry all came out as the plan promised.
 */

import { describe, expect, it } from "bun:test";

import {
  ADMIN_ALL,
  Permissions,
  base64ToBytes,
  bytesToHex,
  canWriteControl,
  controlSignerGroupKey,
  decodeControlWrap,
  grantLocator,
  hex32,
  channelCategory,
  channelRoles,
  isEntitled,
  channelPosition,
  compareChannelOrder,
  controlGroups,
  effectivePermissions,
  foldControlState,
  isCommunityPublic,
  openControlWraps,
  parseDirectInviteRumor,
  unwrapDirectInvite,
} from "@armada-bridge/concord-core";
import { resolveInvite } from "@armada-bridge/bridge/src/concord/client";
import { localIdentity } from "@armada-bridge/bridge/src/concord/signer";
import type { RelayLike } from "@armada-bridge/bridge/src/concord/pool";
import * as nip19 from "nostr-tools/nip19";
import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";

import type { GuildSnapshot, RestMessage } from "./discordRest";
import type { PortalEnv } from "./env";
import { buildImportPlan } from "./importPlan";
import type { SignedSeal, ImportPlan, PlannedChannel } from "./importPlan";
import { Importer, parseAdminPubkey } from "./importer";
import type { ImportRow } from "./importer";
import type { BridgeRow } from "./manager";
import { unseal } from "./seal";

const SEAL_KEY = "0123456789abcdef".repeat(4);

const env: PortalEnv = {
  databaseUrl: "",
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost",
  sealKeyHex: SEAL_KEY,
  discordClientId: "",
  discordClientSecret: "",
  discordBotToken: "",
  blossomServer: "",
  klipyApiKey: "",
  devLogin: false,
  inviteBaseUrl: "https://armada.example",
  importRelays: [],
  allowedOrigins: [],
};

/** Just enough of postgres.Sql for the importer's queries. */
function fakeSql(store: { imports: Map<string, Record<string, unknown>>; bridges: Array<Record<string, unknown>> }) {
  let bridgeSeq = 0;
  const fn = async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.raw.join("$P").replace(/\s+/g, " ").trim();
    let p = 0;
    const next = () => params[p++];

    if (text.startsWith("SELECT 1 FROM messages")) {
      return []; // nothing pre-imported in tests
    }
    // One live bridge per Discord channel: wireBridges skips a channel someone
    // already bridged rather than tripping the unique index mid-import.
    if (text.startsWith("SELECT bridge_id FROM bridges")) {
      const channelId = next();
      return store.bridges.filter(
        (b) =>
          b.discord_channel_id === channelId && (b.status === "active" || b.status === "pending_confirm"),
      );
    }
    if (text.startsWith("SELECT status FROM bridges")) {
      const guildId = next();
      const communityId = next();
      return store.bridges.filter(
        (b) =>
          b.discord_guild_id === guildId &&
          (b.status === "active" || b.status === "pending_confirm") &&
          b.community_id !== communityId,
      );
    }
    if (text.startsWith("SELECT import_id, updated_at FROM imports")) {
      const inFlight = ["minting", "publishing", "wiring", "history"];
      return [...store.imports.values()].filter((r) => inFlight.includes(r.status as string));
    }
    if (text.startsWith("SELECT * FROM imports")) {
      const row = store.imports.get(next() as string);
      if (!row) return [];
      if (text.includes("owner_discord_id") && next() !== row.owner_discord_id) return [];
      return [row];
    }
    if (text.startsWith("UPDATE imports SET")) {
      const body = text.slice("UPDATE imports SET".length, text.indexOf(" WHERE "));
      const sets: Array<[string, unknown]> = [];
      for (const [, col, val] of body.matchAll(/(\w+)\s*=\s*(\$P|'[^']*'|NULL|now\(\))/g)) {
        if (val === "$P") sets.push([col, next()]);
        else if (val === "NULL") sets.push([col, null]);
        else if (val.startsWith("'")) sets.push([col, val.slice(1, -1)]);
      }
      const row = store.imports.get(next() as string);
      if (row) for (const [col, val] of sets) row[col] = val;
      return row ? [row] : [];
    }
    if (text.startsWith("INSERT INTO bridges")) {
      const cols = text.match(/\(([^)]+)\)/)![1].split(",").map((s) => s.trim());
      const values = text.slice(text.indexOf("VALUES"));
      const tokens = [...values.matchAll(/\$P|'[^']*'|NULL/g)].map((m) => m[0]);
      const row: Record<string, unknown> = { bridge_id: `bridge-${++bridgeSeq}` };
      cols.forEach((col, i) => {
        const t = tokens[i];
        row[col] = t === "$P" ? next() : t === "NULL" ? null : t.slice(1, -1);
      });
      store.bridges.push(row);
      return [row];
    }
    throw new Error(`fake sql: unhandled query: ${text}`);
  };
  (fn as unknown as { json: (x: unknown) => unknown }).json = (x: unknown) => x;
  return fn as never;
}

function wirePool(wire: NostrEvent[], opts: { drop?: (event: NostrEvent) => boolean } = {}): RelayLike {
  return {
    query: async (filters) =>
      wire.filter((e) =>
        filters.some(
          (f) =>
            (!f.ids || f.ids.includes(e.id)) &&
            (!f.kinds || f.kinds.includes(e.kind)) &&
            (!f.authors || f.authors.includes(e.pubkey)),
        ),
      ),
    publish: async (event) => {
      // `drop` models the any-accept hazard the importer's read-back guards
      // against: a relay that ACKs a publish (this resolves) but never
      // actually persists it, so a later query never returns it.
      if (opts.drop?.(event)) return;
      wire.push(event);
    },
    subscribe: () => () => {},
    close: async () => {},
  };
}

const snapshot: GuildSnapshot = {
  guild: {
    id: "100",
    name: "Test Fleet",
    description: "hello",
    icon: null,
    approximate_member_count: 42,
    emojis: [{ id: "7777", name: "blob", animated: false }],
    roles: [
      { id: "100", name: "@everyone", permissions: "0", color: 0, hoist: false, position: 0, managed: false },
      { id: "r1", name: "Chief", permissions: (1n << 3n).toString(), color: 1, hoist: true, position: 5, managed: false },
      { id: "r2", name: "Mod", permissions: (1n << 1n).toString(), color: 2, hoist: false, position: 1, managed: false },
    ],
  },
  channels: [
    { id: "1", name: "general", type: 0, position: 0, topic: "plans, chaos, and everything else" },
    { id: "2", name: "news", type: 5, position: 1 },
    { id: "9", name: "Ops", type: 4, position: 2 },
    { id: "3", name: "briefing", type: 0, position: 0, parent_id: "9" },
    { id: "4", name: "hangout", type: 2, position: 3 },
    {
      id: "5",
      name: "mods-only",
      type: 0,
      position: 4,
      permission_overwrites: [{ id: "100", type: 0, allow: "0", deny: (1n << 10n).toString() }],
    },
  ],
};

function restMsg(id: string, timestamp: string): RestMessage {
  return {
    id,
    type: 0,
    content: `history message ${id}`,
    timestamp,
    author: { id: "80351110224678912", username: "mk" },
  };
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for pipeline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("parseAdminPubkey", () => {
  it("accepts npub and bare hex, rejects garbage", () => {
    const pk = getPublicKey(generateSecretKey());
    expect(parseAdminPubkey(nip19.npubEncode(pk))).toBe(pk);
    expect(parseAdminPubkey(pk.toUpperCase())).toBe(pk);
    expect(parseAdminPubkey("nsec1notanpub")).toBeUndefined();
    expect(parseAdminPubkey("hello")).toBeUndefined();
  });
});

describe("import dedupe guard", () => {
  it("refuses to prepare a second community for an already-bridged guild", async () => {
    const store = {
      imports: new Map<string, Record<string, unknown>>(),
      // A prior import already went live for guild "100".
      bridges: [
        { bridge_id: "b-existing", discord_guild_id: "100", community_id: "prior-community", status: "active" },
      ] as Array<Record<string, unknown>>,
    };
    const importer = new Importer(fakeSql(store), env, {} as never, () => wirePool([]), undefined, undefined, undefined, async (_id, work) => work());
    store.imports.set("imp2", {
      import_id: "imp2",
      owner_discord_id: "user1",
      discord_guild_id: "100",
      discord_guild_name: "Test Fleet",
      status: "previewed",
      status_detail: null,
      plan: buildImportPlan(snapshot),
      owner_sk_sealed: null,
      community_sealed: null,
      community_id: null,
      invite_url_sealed: null,
      link_signer_sk_sealed: null,
    });
    const userPk = getPublicKey(generateSecretKey());
    await expect(
      importer.prepare("imp2", "user1", { ownerNpub: nip19.npubEncode(userPk) }),
    ).rejects.toThrow(/already bridged/);
    // Nothing minted: the import stays previewed, no key material written.
    expect(store.imports.get("imp2")!.status).toBe("previewed");
    expect(store.imports.get("imp2")!.community_id).toBeNull();
  });
});

describe("resuming imports a restart interrupted", () => {
  function row(importId: string, status: string, updatedAgoMs: number): Record<string, unknown> {
    return {
      import_id: importId,
      owner_discord_id: "user1",
      discord_guild_id: "100",
      status,
      status_detail: null,
      plan: buildImportPlan(snapshot),
      owner_sk_sealed: null,
      community_sealed: null,
      updated_at: new Date(Date.now() - updatedAgoMs),
    };
  }

  it("relaunches a recent one and hands a stale one back to its owner as retryable", async () => {
    const store = { imports: new Map<string, Record<string, unknown>>(), bridges: [] as Array<Record<string, unknown>> };
    store.imports.set("recent", row("recent", "wiring", 60_000));
    store.imports.set("stale", row("stale", "history", 30 * 24 * 60 * 60 * 1000));
    store.imports.set("finished", row("finished", "done", 60_000));
    const importer = new Importer(fakeSql(store), env, {} as never, () => wirePool([]), undefined, undefined, undefined, async (_id, work) => work());

    await importer.resumeInterrupted();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the relaunch settle

    // Relaunched: the pipeline ran (and, with no genesis material in this
    // fixture, failed on its first step rather than sitting in `wiring`).
    expect(store.imports.get("recent")!.status).toBe("failed");
    expect(String(store.imports.get("recent")!.status_detail)).toMatch(/never prepared/);
    // Not relaunched on its own, but no longer stranded: retry accepts it.
    expect(store.imports.get("stale")!.status).toBe("failed");
    expect(String(store.imports.get("stale")!.status_detail)).toMatch(/interrupted by a portal restart/);
    expect(store.imports.get("finished")!.status).toBe("done");
  });
});

describe("importer pipeline", () => {
  it("mints a community whose published editions fold back into the plan", async () => {
    const store = { imports: new Map<string, Record<string, unknown>>(), bridges: [] as Array<Record<string, unknown>> };
    const wire: NostrEvent[] = [];
    const activated: BridgeRow[] = [];
    const routed: Array<{ channelId: string; id: string; timestampMs?: number }> = [];
    const manager = {
      assertPublicChannel: async () => {},
      activateImported: async (row: BridgeRow) => void activated.push(row),
      // The wiring step provisions the identity, admits the bridge to any
      // private channel, then starts it — so the stub hands back a row with a
      // primary_pk, the way the real manager does.
      provisionImported: async (row: BridgeRow) => ({ ...row, primary_pk: `pk-${row.bridge_id}` }),
      startImported: async (row: BridgeRow) => void activated.push(row),
      resyncFor: async () => {},
      channelKnown: () => true,
      routerFor: (discordChannelId: string) => ({
        router: {
          onDiscordMessage: async (m: { channelId: string; id: string; timestampMs?: number }) => {
            routed.push({ channelId: m.channelId, id: m.id, timestampMs: m.timestampMs });
            return `rumor-${m.id}`;
          },
        },
        link: {
          discordGuildId: "100",
          discordChannelId,
          communityId: "",
          concordChannelIdHex: "",
          enabled: true,
        },
      }),
    };
    // Two pages of history for #general (id "1"), newest first; none elsewhere.
    const historyPages = new Map<string, RestMessage[][]>([
      ["1", [
        [restMsg("1005", "2023-04-02T10:00:00Z"), restMsg("1004", "2023-04-01T10:00:00Z")],
        [restMsg("1003", "2023-03-02T10:00:00Z"), restMsg("1002", "2023-03-01T10:00:00Z")],
        [],
      ]],
    ]);
    const pageIndex = new Map<string, number>();
    const historyFetch = async (channelId: string) => {
      const pages = historyPages.get(channelId) ?? [[]];
      const i = pageIndex.get(channelId) ?? 0;
      pageIndex.set(channelId, i + 1);
      return pages[Math.min(i, pages.length - 1)];
    };
    // The relay guard resolves every host and refuses what it cannot resolve,
    // so a fixture relay would otherwise be a DNS lookup in a unit test.
    const importer = new Importer(
      fakeSql(store),
      env,
      manager as never,
      () => wirePool(wire),
      historyFetch,
      async () => {},
      undefined,
      async (_id, work) => work(),
    );

    const plan = buildImportPlan(snapshot);
    plan.channels = plan.channels.filter((c) => !c.private && c.discordType === 0);
    store.imports.set("imp1", {
      import_id: "imp1",
      owner_discord_id: "user1",
      discord_guild_id: "100",
      discord_guild_name: "Test Fleet",
      status: "previewed",
      status_detail: null,
      plan,
      owner_sk_sealed: null,
      community_sealed: null,
      community_id: null,
      invite_url_sealed: null,
      link_signer_sk_sealed: null,
    });

    // The user's Armada key: signs the genesis templates like the browser would.
    const userSk = generateSecretKey();
    const userPk = getPublicKey(userSk);
    const prep = await importer.prepare("imp1", "user1", {
      ownerNpub: nip19.npubEncode(userPk),
      relays: ["wss://relay.example"],
    });
    expect(prep.ownerPk).toBe(userPk);
    expect(prep.templates.map((t) => t.purpose)).toEqual([
      "admin-role",
      "op-grant",
      "invite-registry",
      "owner-join",
    ]);
    const signedEvents = prep.templates.map(
      (t) => finalizeEvent(t.template as EventTemplate, userSk) as unknown as SignedSeal,
    );
    await importer.confirm("imp1", "user1", { signedEvents });

    const row = () => store.imports.get("imp1")! as unknown as ImportRow;
    await waitFor(() => row().status === "done" || row().status === "failed");
    expect(row().status_detail).toBeNull();
    expect(row().status).toBe("done");

    // Join through the minted invite exactly like a client (or the bridge) would.
    const inviteUrl = unseal(SEAL_KEY, row().invite_url_sealed!);
    const { community, bundle } = await resolveInvite(inviteUrl, wirePool(wire));
    expect(community.idHex).toBe(row().community_id!);
    // The USER's key is the proven owner, baked into the community id.
    expect(community.owner).toBe(userPk);

    // Fold the control plane from the wire.
    const fold = foldControlState(
      openControlWraps(wire, controlGroups(community)),
      community.id,
      community.owner,
    );
    expect(fold.metadata?.name).toBe("Test Fleet");
    expect(fold.metadata?.description).toBe("hello");

    // Only the public text channels are imported.
    const channels = [...fold.channels.values()].filter((c) => !c.deleted);
    expect(channels.map((c) => c.name).sort()).toEqual([
      "briefing",
      "general",
    ]);
    const briefing = channels.find((c) => c.name === "briefing")!;
    const generalFolded = channels.find((c) => c.name === "general")!;

    // The sidebar arrangement has to land where ARMADA reads it, so these go
    // through the client's own accessors rather than poking at `custom`: the
    // importer computed a category and an order for years while writing them
    // under key names (`custom.category`, `custom.position`) that
    // channelCategory/channelOrder never look at, so every imported server
    // rendered as a flat alphabetical list.
    expect(channelCategory(briefing.metadata)).toBe("Ops");
    expect(channelCategory(generalFolded.metadata)).toBeUndefined();
    // Discord order (category position, then channel position), preserved.
    expect(
      channels
        .slice()
        .sort((a, b) =>
          compareChannelOrder(
            { position: channelPosition(a.metadata), name: a.name },
            { position: channelPosition(b.metadata), name: b.name },
          ),
        )
        .map((c) => c.name),
    ).toEqual(["general", "briefing"]);

    // Discord-only facts ride our own namespace, not `armada.*`.
    const discordOf = (m: { custom?: Record<string, unknown> }) =>
      m.custom?.["discord.import"] as { topic?: string; type?: string } | undefined;
    expect(discordOf(generalFolded.metadata)?.topic).toBe("plans, chaos, and everything else");

    expect(channels.every((c) => !c.metadata.private)).toBe(true);
    expect(bundle.channels).toEqual([]);
    expect(wire.some((e) => e.tags.some(([name, value]) => name === "k" && value === "3313"))).toBe(false);

    // Roles: stock Admin at 1, then Chief (ADMINISTRATOR → ADMIN_ALL), then Mod.
    // The channel-access Role sits below them all and is scoped, not server-wide.
    const byPosition = [...fold.roster.roles]
      .filter((r) => r.scope.kind === "server")
      .sort((a, b) => a.position - b.position);
    expect(byPosition.map((r) => [r.name, r.position])).toEqual([
      ["Admin", 1],
      ["Chief", 2],
      ["Mod", 3],
    ]);
    expect(byPosition[1].permissions).toBe(ADMIN_ALL);
    expect(byPosition[2].permissions).toBe(Permissions.KICK);

    // The portal's operational key holds the stock Admin role via the
    // owner-signed grant — and every op-authored edition above folded, which
    // proves the vac citations resolve.
    const opPk = row().plan.checkpoints.opPkHex!;
    expect(effectivePermissions(fold.roster, opPk)).toBe(ADMIN_ALL);

    // The Control Plane is SPLIT (CORD-02 §2): its address is the
    // control_root-derived signer's, the invite hands joiners that address,
    // and a joiner holding only `community_root` can read but not write.
    expect(community.controlPk).toBe(bundle.control_pk!);
    expect(canWriteControl(community)).toBe(false);

    // The owner must still be able to ADMINISTER from Armada — including
    // revoking the op grant — so the op delivers them the staff write key
    // inside a Grant (CORD-04 §3). Replay exactly what Armada's staff-key
    // watcher does: find my folded Grant head, decrypt its `control_wrap`
    // under the granter↔me pairwise key, and adopt only if the secret derives
    // to the `control_pk` I already hold at this epoch.
    const ownerGrantEid = bytesToHex(grantLocator(community.id, hex32(userPk)));
    const ownerHead = fold.headEditions.get(ownerGrantEid);
    expect(ownerHead?.author).toBe(opPk);
    const ownerGrant = fold.roster.grants.find((g) => g.member === userPk);
    expect(ownerGrant?.controlWrap).toBeDefined();
    const decoded = decodeControlWrap(
      base64ToBytes(nip44Decrypt(ownerGrant!.controlWrap!, getConversationKey(userSk, ownerHead!.author))),
    );
    expect(decoded.epoch).toBe(community.rootEpoch);
    expect(controlSignerGroupKey(decoded.controlRoot, community.id, decoded.epoch).pk).toBe(community.controlPk!);
    // Having adopted it, the owner can publish.
    expect(canWriteControl({ ...community, controlRoot: decoded.controlRoot })).toBe(true);

    // The public invite registry is live under the OWNER's name.
    expect(isCommunityPublic(fold)).toBe(true);
    expect(fold.registriesByCreator.has(userPk)).toBe(true);

    // Bridges wired for both text channels, none for announcement/voice/private.
    expect(activated.length).toBe(2);
    const planNow = row().plan;
    const general = planNow.channels.find((c) => c.name === "general")!;
    expect(activated.map((b) => b.concord_channel_id)).toContain(general.channelIdHex!);
    expect(activated.every((b) => b.discord_guild_id === "100")).toBe(true);
    expect(planNow.channels.filter((c) => c.bridgeId).length).toBe(2);

    // History: #general backfilled oldest -> newest with original timestamps,
    // via the same router the live bridge uses.
    expect(routed.map((m) => m.id)).toEqual(["1002", "1003", "1004", "1005"]);
    expect(routed.every((m) => m.channelId === "1")).toBe(true);
    expect(routed[0].timestampMs).toBe(Date.parse("2023-03-01T10:00:00Z"));
    const generalPlan = planNow.channels.find((c) => c.name === "general")!;
    expect(generalPlan.historyImported).toBe(4);
    expect(generalPlan.historyDoneAt).toBeDefined();

    // Guild emoji: one kind 30030 pack signed by the op key, CDN image URLs,
    // and the metadata points at it.
    const pack = wire.find((e) => e.kind === 30030)!;
    expect(pack).toBeDefined();
    expect(pack.pubkey).toBe(opPk);
    expect(pack.tags).toContainEqual(["d", "discord-import"]);
    expect(pack.tags).toContainEqual(["emoji", "blob", "https://cdn.discordapp.com/emojis/7777.png"]);
    expect((fold.metadata?.custom?.["discord.import"] as { emojiPack?: string })?.emojiPack).toBe(
      `30030:${opPk}:discord-import`,
    );

    // Idempotency: a re-run from checkpoints publishes nothing new.
    const wireLen = wire.length;
    await (importer as unknown as { run: (id: string) => Promise<void> }).run("imp1");
    expect(wire.length).toBe(wireLen);
    expect(activated.length).toBe(2);
    expect(row().status).toBe("done");
  });

  it("fails the import when an edition is ACKed but never persists, instead of half-succeeding", async () => {
    // The bug this guards: `pool.publish` resolves on the first relay's ACK,
    // so an edition that never actually landed used to be checkpointed as
    // published — minting bridge rows that point at a channel absent from
    // every member's fold and a bridge that can never start. A relay that
    // accepts the write and drops it must now FAIL the import (recoverable via
    // retry), never mark it done.
    const store = { imports: new Map<string, Record<string, unknown>>(), bridges: [] as Array<Record<string, unknown>> };
    const wire: NostrEvent[] = [];
    const manager = {
      assertPublicChannel: async () => {},
      activateImported: async () => {},
      provisionImported: async (row: BridgeRow) => ({ ...row, primary_pk: `pk-${row.bridge_id}` }),
      startImported: async () => {},
      resyncFor: async () => {},
      channelKnown: () => true,
    };
    // A pool that ACKs every publish but persists nothing: publish resolves,
    // the subsequent read-back finds nothing.
    const importer = new Importer(
      fakeSql(store),
      env,
      manager as never,
      () => wirePool(wire, { drop: () => true }),
      async () => [],
      async () => {},
      1, // publishRetryMs: don't sleep out the retry budget in a unit test
      async (_id, work) => work(),
    );

    const plan = buildImportPlan(snapshot);
    plan.channels = plan.channels.filter((c) => !c.private && c.discordType === 0);
    store.imports.set("impDrop", {
      import_id: "impDrop",
      owner_discord_id: "user1",
      discord_guild_id: "100",
      discord_guild_name: "Test Fleet",
      status: "previewed",
      status_detail: null,
      plan,
      owner_sk_sealed: null,
      community_sealed: null,
      community_id: null,
      invite_url_sealed: null,
      link_signer_sk_sealed: null,
    });

    const userSk = generateSecretKey();
    const userPk = getPublicKey(userSk);
    const prep = await importer.prepare("impDrop", "user1", {
      ownerNpub: nip19.npubEncode(userPk),
      relays: ["wss://relay.example"],
    });
    const signedEvents = prep.templates.map(
      (t) => finalizeEvent(t.template as EventTemplate, userSk) as unknown as SignedSeal,
    );
    await importer.confirm("impDrop", "user1", { signedEvents });

    const row = () => store.imports.get("impDrop")! as unknown as ImportRow;
    await waitFor(() => row().status === "done" || row().status === "failed", 30000);

    // Failed, not done — and the reason names the read-back, not a silent stop.
    expect(row().status).toBe("failed");
    expect(row().status_detail).toContain("did not become readable");
    // Nothing was wired: no bridge row points at a channel that never landed.
    expect(store.bridges.length).toBe(0);
  });
});

describe("public-only import boundary", () => {
  it("rejects an old preview containing a selected private channel before genesis", async () => {
    const store = { imports: new Map<string, Record<string, unknown>>(), bridges: [] as Array<Record<string, unknown>> };
    store.imports.set("private-preview", {
      import_id: "private-preview", owner_discord_id: "user1", discord_guild_id: "100",
      status: "previewed", plan: buildImportPlan(snapshot), community_id: null,
    });
    const manager = { assertPublicChannel: async () => {} };
    const importer = new Importer(fakeSql(store), env, manager as never, () => wirePool([]), async () => [], async () => {});
    await expect(importer.prepare("private-preview", "user1", { ownerNpub: getPublicKey(generateSecretKey()) })).rejects.toThrow(/public/i);
    expect(store.imports.get("private-preview")!.community_id).toBeNull();
  });

  it("stops history fetching and forwarding when visibility changes during replay", async () => {
    let allowed = true;
    let fetched = 0;
    let sent = 0;
    const manager = {
      assertPublicChannel: async () => { if (!allowed) throw new Error("visibility denied"); },
      resyncFor: async () => {},
      routerFor: () => ({ router: { onDiscordMessage: async () => { sent++; } }, link: {} }),
    };
    const importer = new Importer(fakeSql({ imports: new Map(), bridges: [] }), env, manager as never, () => wirePool([]), async () => {
      fetched++;
      allowed = false;
      return fetched === 1 ? [restMsg("1005", "2023-04-02T10:00:00Z")] : [];
    });
    const plan = buildImportPlan(snapshot);
    plan.channels = plan.channels.filter((c) => !c.private && c.discordType === 0);
    const channel = plan.channels.find((c) => c.discordId === "1")!;
    await expect((importer as unknown as { backfillChannel(id: string, plan: ImportPlan, channel: PlannedChannel): Promise<void> }).backfillChannel("test", plan, channel)).rejects.toThrow("visibility denied");
    expect(fetched).toBe(1);
    expect(sent).toBe(0);
  });
});
