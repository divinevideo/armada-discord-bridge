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
  STOCK_RELAYS,
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
import { BridgeLeaseUnavailableError } from "@armada-bridge/bridge/src/db/leases";
import { intakeDirectInviteKeys } from "@armada-bridge/bridge/src/concord/keyIntake";
import { ConcordClient, resolveInvite } from "@armada-bridge/bridge/src/concord/client";
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
import type { SignedSeal } from "./importPlan";
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

describe("legacy importer pipeline", () => {
  it("mints a community whose published editions fold back into the plan", async () => {
    const store = { imports: new Map<string, Record<string, unknown>>(), bridges: [] as Array<Record<string, unknown>> };
    const wire: NostrEvent[] = [];
    const activated: BridgeRow[] = [];
    const bridgeKeys = new Map<string, Uint8Array>();
    const routed: Array<{ channelId: string; id: string; timestampMs?: number }> = [];
    const manager = {
      activateImported: async (row: BridgeRow) => void activated.push(row),
      // The wiring step provisions the identity, admits the bridge to any
      // private channel, then starts it — so the stub hands back a row with a
      // primary_pk, the way the real manager does.
      provisionImported: async (row: BridgeRow) => {
        const sk = generateSecretKey();
        bridgeKeys.set(row.bridge_id, sk);
        return { ...row, primary_pk: getPublicKey(sk) };
      },
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
    const dialed: string[][] = [];
    let inboxLookupFails = false;
    const importer = new Importer(
      fakeSql(store),
      env,
      manager as never,
      (relays) => {
        dialed.push(relays);
        const pool = wirePool(wire), query = pool.query;
        pool.query = async (filters, options) => {
          if (inboxLookupFails && filters.some((filter) => filter.kinds?.includes(10050))) throw new Error("synthetic inbox lookup unavailable");
          return query(filters, options);
        };
        return pool;
      },
      historyFetch,
      // The relay guard resolves every host and refuses what it cannot resolve,
      // so a fixture relay would otherwise be a DNS lookup in a unit test. The
      // owner-inbox filter calls the real guard, hence IP-literal inbox fixtures.
      async () => {},
      undefined,
      async (_id, work) => work(),
    );

    const plan = buildImportPlan(snapshot);
    const privateChoice = plan.channels.find(c => c.private)!;
    privateChoice.bridge = true;
    privateChoice.bridgeable = true;
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

    // Channels: voice suffixed + tagged; the private one imported, gated.
    const channels = [...fold.channels.values()].filter((c) => !c.deleted);
    expect(channels.map((c) => c.name).sort()).toEqual([
      "briefing",
      "general",
      "hangout-voice",
      "mods-only",
      "news",
    ]);
    const briefing = channels.find((c) => c.name === "briefing")!;
    const hangout = channels.find((c) => c.name === "hangout-voice")!;
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
    ).toEqual(["general", "news", "hangout-voice", "mods-only", "briefing"]);

    // Discord-only facts ride our own namespace, not `armada.*`.
    const discordOf = (m: { custom?: Record<string, unknown> }) =>
      m.custom?.["discord.import"] as { topic?: string; type?: string } | undefined;
    expect(discordOf(hangout.metadata)?.type).toBe("voice");
    expect(discordOf(generalFolded.metadata)?.topic).toBe("plans, chaos, and everything else");

    // The private channel: @everyone was denied VIEW_CHANNEL on Discord, so it
    // imports as a CORD-03 Private Channel — `private: true`, and a Role scoped
    // to it that is its access list (CORD-04 §2). It is NOT in the public
    // bundle: a key every joiner reads gates nothing.
    const modsOnly = channels.find((c) => c.name === "mods-only")!;
    expect(modsOnly.metadata.private).toBe(true);
    expect(channelRoles(fold.roster, modsOnly.channelIdHex).map((r) => r.name)).toEqual(["mods-only"]);
    expect(bundle.channels).toEqual([]);
    // Only the owner is entitled at import time (position 0, supreme); nobody
    // else has an npub yet.
    expect(isEntitled(fold.roster, fold.ownerHex, userPk, modsOnly.channelIdHex)).toBe(true);
    expect(
      isEntitled(fold.roster, fold.ownerHex, row().plan.checkpoints.opPkHex!, modsOnly.channelIdHex),
    ).toBe(false);

    // ...and the owner is handed its key as a Direct Invite (CORD-05 §6),
    // giftwrapped to them and indexable by the `k` tag.
    const directInvite = wire.find(
      (e) => e.kind === 1059 && e.tags.some(([n, v]) => n === "k" && v === "3313"),
    )!;
    expect(directInvite).toBeDefined();
    expect(directInvite.tags).toContainEqual(["p", userPk]);
    const delivered = await unwrapDirectInvite(directInvite, localIdentity(userSk).signer);
    expect(delivered?.sender).toBe(row().plan.checkpoints.opPkHex!);
    const keyBundle = parseDirectInviteRumor(delivered!.rumor.kind, delivered!.rumor.content)!;
    expect(keyBundle.channels.map((c) => [c.id, c.name])).toEqual([[modsOnly.channelIdHex, "mods-only"]]);
    // A real 32-byte secret, independent of the community root (CORD-03 §1).
    expect(keyBundle.channels[0].key).toMatch(/^[0-9a-f]{64}$/);
    expect(keyBundle.channels[0].key).not.toBe(bundle.community_root);

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

    // The private text channel is bridged only after its explicit opt-in.
    expect(activated.length).toBe(3);
    const planNow = row().plan;
    const general = planNow.channels.find((c) => c.name === "general")!;
    expect(activated.map((b) => b.concord_channel_id)).toContain(general.channelIdHex!);
    expect(activated.every((b) => b.discord_guild_id === "100")).toBe(true);
    expect(planNow.channels.filter((c) => c.bridgeId).length).toBe(3);
    const privatePlan = planNow.channels.find(c => c.private)!;
    const privateBridge = activated.find(b => b.concord_channel_id === privatePlan.channelIdHex)!;
    const bridgeIdentity = localIdentity(bridgeKeys.get(privateBridge.bridge_id)!);
    const recovered = await intakeDirectInviteKeys([wirePool(wire)], bridgeIdentity, community, {
      isAuthorizedSender: pk => pk === opPk,
    });
    expect(recovered.learned).toContain(modsOnly.channelIdHex);
    const privateClient = new ConcordClient(recovered.community, wirePool(wire), bridgeIdentity);
    await privateClient.syncControl();
    expect(privateClient.channel(modsOnly.channelIdHex)?.isPrivate).toBe(true);
    expect(isEntitled(fold.roster, community.owner, bridgeIdentity.pk, modsOnly.channelIdHex)).toBe(true);


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

    // Both restored private publication paths remain subject to worker ownership.
    const internal = importer as any;
    const prepared = await internal.load("imp1");
    const sentAt = prepared.plan.checkpoints.ownerChannelKeysSentAt;
    delete prepared.plan.checkpoints.ownerChannelKeysSentAt;
    const beforeLoss = wire.length;
    internal.importGuards.set("imp1", async () => { throw new BridgeLeaseUnavailableError("private lease lost"); });
    await expect(internal.publishEditions("imp1", prepared.community, prepared.opSk, prepared.plan)).rejects.toThrow("private lease lost");
    await expect(internal.admitBridgeToPrivateChannel("imp1", prepared.community, prepared.opSk, prepared.plan, privatePlan, bridgeIdentity.pk)).rejects.toThrow("private lease lost");
    expect(wire.length).toBe(beforeLoss);
    internal.importGuards.delete("imp1");

    // The owner's inbox list is the owner's own signed event, so it names
    // whatever host they like; it is dialed only after the same vetting as
    // every other untrusted relay list. A curated list that vets to nothing
    // is not delivered to the stock relays either: the owner's client scans
    // their list, so a stock delivery would read as sent and never arrive.
    const inboxList = (tags: string[][], created_at: number) =>
      finalizeEvent({ kind: 10050, created_at, tags, content: "" }, userSk) as unknown as NostrEvent;
    const hosts = (lists: string[][]) => lists.flat().map((relay) => new URL(relay).hostname);
    const keyDeliveries = () => wire.filter((e) => e.kind === 1059 && e.tags.some(([n, v]) => n === "k" && v === "3313")).length;
    // Unknown inboxes remain retryable; only a confirmed absent list uses stock.
    const beforeFailedLookup = keyDeliveries();
    inboxLookupFails = true;
    delete prepared.plan.checkpoints.ownerChannelKeysSentAt;
    dialed.length = 0;
    await internal.publishEditions("imp1", prepared.community, prepared.opSk, prepared.plan);
    expect(keyDeliveries()).toBe(beforeFailedLookup);
    for (const relay of STOCK_RELAYS) expect(dialed.flat()).not.toContain(relay);
    expect(prepared.plan.checkpoints.ownerChannelKeysSentAt).toBeUndefined();
    expect(prepared.plan.checkpoints.ownerChannelKeysError).toMatch(/owner inbox lookup unavailable/);
    const failedCheckpoint = (await internal.load("imp1")).plan.checkpoints;
    expect(failedCheckpoint.ownerChannelKeysSentAt).toBeUndefined();
    expect(failedCheckpoint.ownerChannelKeysError).toMatch(/owner inbox lookup unavailable/);
    inboxLookupFails = false;
    delete prepared.plan.checkpoints.ownerChannelKeysError;
    dialed.length = 0;
    await internal.publishEditions("imp1", prepared.community, prepared.opSk, prepared.plan);
    expect(keyDeliveries()).toBe(beforeFailedLookup + 1);
    for (const relay of STOCK_RELAYS) expect(dialed.flat()).toContain(relay);
    expect(prepared.plan.checkpoints.ownerChannelKeysSentAt).toBeDefined();
    const now = Math.floor(Date.now() / 1000);
    wire.push(inboxList([["relay", "wss://1.1.1.1/"], ["relay", "ws://127.0.0.1:6379/"]], now));
    delete prepared.plan.checkpoints.ownerChannelKeysSentAt;
    dialed.length = 0;
    const sentBefore = keyDeliveries();
    await internal.publishEditions("imp1", prepared.community, prepared.opSk, prepared.plan);
    expect(hosts(dialed)).toContain("1.1.1.1");
    expect(hosts(dialed)).not.toContain("127.0.0.1");
    for (const relay of STOCK_RELAYS) expect(dialed.flat()).not.toContain(relay);
    expect(keyDeliveries()).toBe(sentBefore + 1);
    expect(prepared.plan.checkpoints.ownerChannelKeysSentAt).toBeDefined();
    wire.push(inboxList([["relay", "ws://127.0.0.1:6379/"], ["relay", "ws://10.0.0.5/"]], now + 1));
    delete prepared.plan.checkpoints.ownerChannelKeysSentAt;
    delete prepared.plan.checkpoints.ownerChannelKeysError;
    dialed.length = 0;
    const sentBeforeRefusal = keyDeliveries();
    await internal.publishEditions("imp1", prepared.community, prepared.opSk, prepared.plan);
    expect(hosts(dialed)).not.toContain("127.0.0.1");
    expect(hosts(dialed)).not.toContain("10.0.0.5");
    for (const relay of STOCK_RELAYS) expect(dialed.flat()).not.toContain(relay);
    expect(keyDeliveries()).toBe(sentBeforeRefusal);
    expect(prepared.plan.checkpoints.ownerChannelKeysSentAt).toBeUndefined();
    expect(prepared.plan.checkpoints.ownerChannelKeysError).toMatch(/not publicly reachable/);
    delete prepared.plan.checkpoints.ownerChannelKeysError;
    prepared.plan.checkpoints.ownerChannelKeysSentAt = sentAt;

    // Idempotency: a re-run from checkpoints publishes nothing new.
    const wireLen = wire.length;
    await (importer as unknown as { runOwned: (id: string) => Promise<void> }).runOwned("imp1");
    expect(wire.length).toBe(wireLen);
    expect(activated.length).toBe(3);
    expect(row().status).toBe("done");
  });

});
