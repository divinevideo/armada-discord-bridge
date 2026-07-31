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
  controlGroups,
  effectivePermissions,
  foldControlState,
  isCommunityPublic,
  openControlWraps,
} from "@armada-bridge/concord-core";
import { resolveInvite } from "@armada-bridge/bridge/src/concord/client";
import type { RelayLike } from "@armada-bridge/bridge/src/concord/pool";
import * as nip19 from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";

import type { GuildSnapshot } from "./discordRest";
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
  baseUrl: "http://localhost",
  sealKeyHex: SEAL_KEY,
  discordClientId: "",
  discordClientSecret: "",
  discordBotToken: "",
  blossomServer: "",
  devLogin: false,
  inviteBaseUrl: "https://armada.example",
  importRelays: [],
};

/** Just enough of postgres.Sql for the importer's queries. */
function fakeSql(store: { imports: Map<string, Record<string, unknown>>; bridges: Array<Record<string, unknown>> }) {
  let bridgeSeq = 0;
  const fn = async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.raw.join("$P").replace(/\s+/g, " ").trim();
    let p = 0;
    const next = () => params[p++];

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

function wirePool(wire: NostrEvent[]): RelayLike {
  return {
    query: async (filters) =>
      wire.filter((e) =>
        filters.some(
          (f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)),
        ),
      ),
    publish: async (event) => {
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

describe("importer pipeline", () => {
  it("mints a community whose published editions fold back into the plan", async () => {
    const store = { imports: new Map<string, Record<string, unknown>>(), bridges: [] as Array<Record<string, unknown>> };
    const wire: NostrEvent[] = [];
    const activated: BridgeRow[] = [];
    const manager = { activateImported: async (row: BridgeRow) => void activated.push(row) };
    const importer = new Importer(fakeSql(store), env, manager as never, () => wirePool(wire));

    const plan = buildImportPlan(snapshot);
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
    const { community } = await resolveInvite(inviteUrl, wirePool(wire));
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

    // Channels: private skipped; voice suffixed + tagged; category recorded.
    const channels = [...fold.channels.values()].filter((c) => !c.deleted);
    expect(channels.map((c) => c.name).sort()).toEqual(["briefing", "general", "hangout-voice", "news"]);
    const briefing = channels.find((c) => c.name === "briefing")!;
    expect(briefing.metadata.custom?.category).toBe("Ops");
    const hangout = channels.find((c) => c.name === "hangout-voice")!;
    expect(hangout.metadata.custom?.kind).toBe("voice");
    const generalFolded = channels.find((c) => c.name === "general")!;
    expect(generalFolded.metadata.custom?.topic).toBe("plans, chaos, and everything else");
    expect(typeof generalFolded.metadata.custom?.position).toBe("number");

    // Roles: stock Admin at 1, then Chief (ADMINISTRATOR → ADMIN_ALL), then Mod.
    const byPosition = [...fold.roster.roles].sort((a, b) => a.position - b.position);
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

    // Idempotency: a re-run from checkpoints publishes nothing new.
    const wireLen = wire.length;
    await (importer as unknown as { run: (id: string) => Promise<void> }).run("imp1");
    expect(wire.length).toBe(wireLen);
    expect(activated.length).toBe(2);
    expect(row().status).toBe("done");
  });
});
