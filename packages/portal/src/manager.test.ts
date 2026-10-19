/**
 * Shared puppet secret: one master secret per (community, guild) pairing so a
 * Discord user derives the same npub in every channel bridged between the
 * same server and community. Runs against the local Postgres (skipped when
 * unreachable); rows use a test-only community id and are cleaned up.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  buildBanlistEdition,
  controlGroups,
  currentControlWriteGroup,
  foldControlState,
  mintCommunity,
  openControlWraps,
  sealEdition,
} from "@armada-bridge/concord-core";
import { derivePuppet } from "@armada-bridge/bridge/src/puppets";
import { migrate } from "@armada-bridge/bridge/src/db/migrate";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import postgres from "postgres";

import type { PortalEnv } from "./env";
import { BridgeManager } from "./manager";
import { unseal } from "./seal";
import { detectSeverance, severanceDetail, type SeveranceVerdict } from "./severance";

const DB_URL = process.env.DATABASE_URL ?? "postgres://bridge:bridge@localhost:5432/bridge";
const SEAL_KEY = "ab".repeat(32);
const COMMUNITY = `test-shared-secret-${process.pid}`;

const sql = postgres(DB_URL, { max: 2, onnotice: () => {}, connect_timeout: 3 });
const dbUp = await sql`SELECT 1`.then(() => true).catch(() => false);
if (!dbUp) await sql.end();

/** Calls the private helper; the manager needs no gateway for this path. */
function secretFor(mgr: BridgeManager, communityId: string, guildId: string): Promise<Uint8Array> {
  return (mgr as unknown as {
    sharedMasterSecret(c: string, g: string): Promise<Uint8Array>;
  }).sharedMasterSecret(communityId, guildId);
}

describe.skipIf(!dbUp)("sharedMasterSecret", () => {
  const env = { databaseUrl: DB_URL, sealKeyHex: SEAL_KEY } as PortalEnv;
  const mgr = new BridgeManager(sql, env);

  beforeAll(async () => {
    await migrate(DB_URL);
  });

  afterAll(async () => {
    if (dbUp) await sql`DELETE FROM guild_community_secrets WHERE community_id = ${COMMUNITY}`;
    await sql.end();
  });

  it("reuses one secret per (community, guild), so one npub per user", async () => {
    const first = await secretFor(mgr, COMMUNITY, "100000000000000001");
    const second = await secretFor(mgr, COMMUNITY, "100000000000000001");
    const a = unseal(SEAL_KEY, first);
    const b = unseal(SEAL_KEY, second);
    expect(b).toBe(a);
    expect(derivePuppet(b, "200000000000000002").pk).toBe(derivePuppet(a, "200000000000000002").pk);
  });

  it("a different guild in the same community gets a different secret", async () => {
    const one = await secretFor(mgr, COMMUNITY, "100000000000000001");
    const other = await secretFor(mgr, COMMUNITY, "100000000000000009");
    expect(unseal(SEAL_KEY, other)).not.toBe(unseal(SEAL_KEY, one));
  });

  it("uses the provisioned worker puppet root and rejects drift on relink", async () => {
    const provisioned = { communityId: COMMUNITY, guildId: "100000000000000043", key: "cd".repeat(32) };
    const manager = new BridgeManager(sql, { ...env, puppetMaster: provisioned });
    const sealed = await secretFor(manager, COMMUNITY, provisioned.guildId);
    expect(derivePuppet(unseal(SEAL_KEY, sealed), "200000000000000002").pk).toBe(derivePuppet(provisioned.key, "200000000000000002").pk);
    const changed = new BridgeManager(sql, { ...env, puppetMaster: { ...provisioned, key: "ef".repeat(32) } });
    await expect(secretFor(changed, COMMUNITY, provisioned.guildId)).rejects.toThrow();
    await expect(secretFor(manager, COMMUNITY, "100000000000000044")).rejects.toThrow();
  });

  it("concurrent first activations converge on one secret", async () => {
    const [x, y] = await Promise.all([
      secretFor(mgr, COMMUNITY, "100000000000000042"),
      secretFor(mgr, COMMUNITY, "100000000000000042"),
    ]);
    expect(unseal(SEAL_KEY, y)).toBe(unseal(SEAL_KEY, x));
  });
});

describe("activate preconditions", () => {
  it("refuses a bridge that is not linked yet", async () => {
    const mgr = new BridgeManager(sql, { sealKeyHex: SEAL_KEY } as PortalEnv);
    const draft = { bridge_id: "b", community_id: null, discord_guild_id: null };
    await expect(mgr.activate(draft as never)).rejects.toThrow(/linked/);
  });
});

/**
 * Regression for 2026-08-27: a boot that raced a Discord API outage found no
 * gateway and severed every active bridge on the spot (~378 of them). An
 * active bridge with no gateway must DEFER — a distinct, retryable condition
 * that never reaches a sever — and the guard must not touch a pending_confirm
 * bridge, which does not route to Discord. No gateway and no DB is needed:
 * the guard fires before any relay or Postgres work.
 */
describe("a down gateway defers, never severs", () => {
  const mgr = new BridgeManager(sql, { sealKeyHex: SEAL_KEY } as PortalEnv);
  const start = (row: unknown) =>
    (mgr as unknown as { start(r: unknown): Promise<void> }).start(row);

  it("an active bridge with no gateway defers (does not sever)", async () => {
    await expect(start({ bridge_id: "no-gw", status: "active" })).rejects.toThrow(
      /gateway not connected/i,
    );
  });

  it("the guard is scoped to active — a pending_confirm bridge falls through it", async () => {
    // Past the gateway guard it hits the ordinary key-material precondition,
    // proving a missing gateway did not short-circuit the non-routing path.
    await expect(start({ bridge_id: "pc", status: "pending_confirm" })).rejects.toThrow(
      /sealed key material/i,
    );
  });
});

describe("public policy at manager boundaries", () => {
  const env = { mode: "public", sealKeyHex: SEAL_KEY } as PortalEnv;
  const denied = { assertPublicChannel: async () => { throw new Error("test visibility denied"); } };
  const row = {
    bridge_id: "public-boundary", community_id: "cd".repeat(32),
    discord_guild_id: "100000000000000001", discord_channel_id: "100000000000000002",
    status: "pending_confirm", invite_url_sealed: new Uint8Array([1]),
    master_secret_sealed: new Uint8Array([1]), primary_sk_sealed: new Uint8Array([1]),
  };
  it("checks visibility before decoding keys or opening relay connections on restart", async () => {
    const manager = new BridgeManager(sql, env, denied);
    await expect(manager.startImported(row as never)).rejects.toThrow("Public channel visibility could not be verified");
  });
  it("checks visibility before minting keys or changing activation state", async () => {
    const manager = new BridgeManager(sql, env, denied);
    await expect(manager.activate(row as never)).rejects.toThrow("Public channel visibility could not be verified");
    await expect(manager.provisionImported(row as never)).rejects.toThrow("Public channel visibility could not be verified");
  });
});

it("legacy channel admission accepts multiple guilds without invoking public visibility", async () => {
  const denied = { assertPublicChannel: async () => { throw new Error("visibility denied"); } };
  const manager = new BridgeManager({} as never, { mode: "legacy" } as PortalEnv, denied);
  await manager.assertChannelPolicy("guild-a", "private-a");
  await manager.assertChannelPolicy("guild-b", "private-b");
  await expect(manager.assertPublicChannel("guild-a", "private-a")).rejects.toThrow(/visibility/);
  const publicManager = new BridgeManager({} as never, { mode: "public" } as PortalEnv, denied);
  await expect(publicManager.assertChannelPolicy("guild-a", "private-a")).rejects.toThrow(/visibility/);
});

/**
 * The severance ACTION: whatever ./severance.ts detects, the bridge stops
 * forwarding and the record says why — bridges.status 'severed' +
 * status_detail (the dashboard's surface) and communities.severed_reason
 * (schema.sql's 'banned' | 'refounded' | 'dissolved' column). Own connection:
 * the shared-puppet-secret suite above ends the shared one in its afterAll.
 */
const SEVERED_COMMUNITY = `test-severance-${process.pid}`;
const sevSql = postgres(DB_URL, { max: 1, onnotice: () => {}, connect_timeout: 3 });

describe.skipIf(!dbUp)("severance action (stop forwarding, surface, record)", () => {
  const env = { sealKeyHex: SEAL_KEY } as PortalEnv;
  const mgr = new BridgeManager(sevSql, env);
  const community = { idHex: SEVERED_COMMUNITY, relays: ["wss://relay.example"], name: "Severance Test" };
  const apply = (bridgeId: string, verdict: SeveranceVerdict) =>
    (mgr as unknown as {
      applySeverance(id: string, v: SeveranceVerdict, c: typeof community): Promise<void>;
    }).applySeverance(bridgeId, verdict, community);

  beforeAll(async () => {
    await migrate(DB_URL);
  });

  afterAll(async () => {
    if (dbUp) {
      await sevSql`DELETE FROM bridges WHERE community_id = ${SEVERED_COMMUNITY}`;
      await sevSql`DELETE FROM communities WHERE community_id = ${SEVERED_COMMUNITY}`;
    }
    await sevSql.end();
  });

  async function newBridge(): Promise<string> {
    const [row] = await sevSql<{ bridge_id: string }[]>`
      INSERT INTO bridges (owner_discord_id, status, community_id)
      VALUES ('severance-test', 'active', ${SEVERED_COMMUNITY})
      RETURNING bridge_id`;
    return row.bridge_id;
  }

  async function readState(bridgeId: string) {
    const [bridge] = await sevSql<{ status: string; status_detail: string | null }[]>`
      SELECT status, status_detail FROM bridges WHERE bridge_id = ${bridgeId}`;
    const [comm] = await sevSql<{ severed_reason: string | null }[]>`
      SELECT severed_reason FROM communities WHERE community_id = ${SEVERED_COMMUNITY}`;
    return { bridge, comm };
  }

  it("a ban severs the link and records severed_reason 'banned'", async () => {
    const bridgeId = await newBridge();
    await apply(bridgeId, { reason: "banned", pubkey: "cd".repeat(32), bannedAtMs: 1000 });
    const { bridge, comm } = await readState(bridgeId);
    expect(bridge.status).toBe("severed");
    expect(bridge.status_detail).toMatch(/banned/);
    expect(comm.severed_reason).toBe("banned");
  });

  it("a refounding severs the link, names the epoch, and records 'refounded'", async () => {
    const bridgeId = await newBridge();
    await apply(bridgeId, {
      reason: "refounded",
      newEpoch: 3n,
      refounder: "ab".repeat(32),
      rotatedAtMs: Date.now(),
      carried: true,
      excluded: false,
    });
    const { bridge, comm } = await readState(bridgeId);
    expect(bridge.status).toBe("severed");
    expect(bridge.status_detail).toMatch(/refounded at epoch 3/);
    expect(bridge.status_detail).toMatch(/resume/);
    expect(comm.severed_reason).toBe("refounded");
  });

  it("a dissolution severs the link and records 'dissolved'", async () => {
    const bridgeId = await newBridge();
    await apply(bridgeId, { reason: "dissolved" });
    const { bridge, comm } = await readState(bridgeId);
    expect(bridge.status).toBe("severed");
    expect(bridge.status_detail).toMatch(/dissolved/);
    expect(comm.severed_reason).toBe("dissolved");
  });

  it("a clean start clears the recorded reason", async () => {
    const bridgeId = await newBridge();
    await apply(bridgeId, { reason: "dissolved" });
    await (mgr as unknown as { clearSeveredReason(r: { community_id: string }): Promise<void> }).clearSeveredReason({
      community_id: SEVERED_COMMUNITY,
    });
    const { comm } = await readState(bridgeId);
    expect(comm.severed_reason).toBeNull();
  });

  it("detection fires and the bridge takes the documented action, end to end", async () => {
    // The same chain the live watchers run: mint a community whose Banlist
    // names the bridge's npub, fold it, classify it, apply it — and the row
    // says 'severed' with the ban as the reason.
    const ownerSk = generateSecretKey();
    const ownerPk = getPublicKey(ownerSk);
    const owner = {
      async signEvent(template: EventTemplate) {
        return finalizeEvent(template, ownerSk);
      },
    };
    const { community: minted } = mintCommunity("Severance E2E", ownerPk, ["wss://relay.example"]);
    const mePk = getPublicKey(generateSecretKey());
    const banlist = await sealEdition(
      buildBanlistEdition(minted.id, [mePk], { actorPubkey: ownerPk, version: 1n }),
      currentControlWriteGroup(minted),
      owner,
    );
    const folded = foldControlState(
      openControlWraps([banlist], controlGroups(minted)),
      minted.id,
      minted.owner,
    );
    const verdict = detectSeverance({ wraps: [], community: minted, me: mePk, folded });
    expect(verdict?.reason).toBe("banned");

    const bridgeId = await newBridge();
    await (mgr as unknown as {
      applySeverance(id: string, v: SeveranceVerdict, c: { idHex: string; relays: string[]; name: string }): Promise<void>;
    }).applySeverance(bridgeId, verdict!, minted);
    const [bridge] = await sevSql<{ status: string; status_detail: string | null }[]>`
      SELECT status, status_detail FROM bridges WHERE bridge_id = ${bridgeId}`;
    expect(bridge.status).toBe("severed");
    expect(bridge.status_detail).toBe(severanceDetail(verdict!));
  });
});
