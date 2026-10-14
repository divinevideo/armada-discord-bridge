/**
 * Shared puppet secret: one master secret per (community, guild) pairing so a
 * Discord user derives the same npub in every channel bridged between the
 * same server and community. Runs against the local Postgres (skipped when
 * unreachable); rows use a test-only community id and are cleaned up.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { derivePuppet } from "@armada-bridge/bridge/src/puppets";
import { migrate } from "@armada-bridge/bridge/src/db/migrate";
import postgres from "postgres";

import type { PortalEnv } from "./env";
import { BridgeManager } from "./manager";
import { unseal } from "./seal";

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
  const env = { sealKeyHex: SEAL_KEY } as PortalEnv;
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
