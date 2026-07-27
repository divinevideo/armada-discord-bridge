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
