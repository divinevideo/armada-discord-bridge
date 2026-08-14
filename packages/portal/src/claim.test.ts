/**
 * /claim identity binding. The bot answers /claim with a PUBLIC channel
 * reply, so the code is visible to everyone in the channel; what makes that
 * safe is that spending it requires being signed in as the Discord account it
 * was issued to. Whoever passes this gate receives that account's imported
 * roles and its puppet key, so the binding is tested here directly.
 *
 * Runs against the local Postgres (skipped when unreachable); rows use
 * test-only ids and are cleaned up.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { migrate } from "@armada-bridge/bridge/src/db/migrate";
import { derivePuppet } from "@armada-bridge/bridge/src/puppets";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as nip19 from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import postgres from "postgres";

import type { PortalEnv } from "./env";
import { Importer, claimChallenge } from "./importer";
import { claimCodeDigest, seal } from "./seal";

const DB_URL = process.env.DATABASE_URL ?? "postgres://bridge:bridge@localhost:5432/bridge";
const SEAL_KEY = "ab".repeat(32);
const COMMUNITY = `test-claim-${process.pid}`;
const GUILD = `guild-${process.pid}`;
// Real snowflakes: derivePuppet only accepts numeric Discord ids.
const OWNER = "100000000000000001";
const MEMBER = "100000000000000002";
const BYSTANDER = "100000000000000003";
const MASTER_SECRET = "cd".repeat(32);

const sql = postgres(DB_URL, { max: 2, onnotice: () => {}, connect_timeout: 3 });
const dbUp = await sql`SELECT 1`.then(() => true).catch(() => false);
if (!dbUp) await sql.end();

const env = { sealKeyHex: SEAL_KEY, baseUrl: "http://localhost" } as PortalEnv;
/** No relay is reachable in this test; touching one is a failure, not a skip. */
const noPools = () => {
  throw new Error("claim must not open a relay pool in this test");
};
const importer = new Importer(sql, env, {} as never, noPools as never);

/** A claimant: their own Armada key, and a proof for the given Discord id. */
function claimant(discordUserId: string) {
  const sk = generateSecretKey();
  const npub = getPublicKey(sk);
  return {
    npub,
    body: (code: string) => ({
      npub,
      code,
      levels: { link: false, roles: false, key: true },
      signedProof: finalizeEvent(
        {
          kind: 30078,
          content: claimChallenge(COMMUNITY, discordUserId),
          tags: [["p", npub]],
          created_at: Math.floor(Date.now() / 1000),
        },
        sk,
      ) as never,
    }),
  };
}

const session = (id: string) => ({ user: { id } });

async function issueCode(code: string, discordUserId: string): Promise<void> {
  await sql`
    INSERT INTO claim_codes (code, community_id, discord_guild_id, discord_user_id)
    VALUES (${claimCodeDigest(SEAL_KEY, code)}, ${COMMUNITY}, ${GUILD}, ${discordUserId})`;
}

const consumed = async (code: string): Promise<boolean> => {
  const [row] = await sql<{ consumed_at: string | null }[]>`
    SELECT consumed_at FROM claim_codes WHERE code = ${claimCodeDigest(SEAL_KEY, code)}`;
  return row?.consumed_at !== null;
};

describe.skipIf(!dbUp)("claim identity binding", () => {
  beforeAll(async () => {
    await migrate(DB_URL);
    await sql`
      INSERT INTO guild_community_secrets (community_id, discord_guild_id, master_secret_sealed)
      VALUES (${COMMUNITY}, ${GUILD}, ${seal(SEAL_KEY, MASTER_SECRET)})`;
    // invite_url_sealed is deliberately unparseable: it leaves the claim with
    // no relays, so Level 1 publishes nothing and no pool is opened.
    await sql`
      INSERT INTO bridges (owner_discord_id, status, community_id, discord_guild_id,
                           invite_url_sealed, master_secret_sealed)
      VALUES (${OWNER}, 'active', ${COMMUNITY}, ${GUILD},
              ${seal(SEAL_KEY, "not-an-invite")}, ${seal(SEAL_KEY, MASTER_SECRET)})`;
  });

  afterAll(async () => {
    if (dbUp) {
      await sql`DELETE FROM claims WHERE community_id = ${COMMUNITY}`;
      await sql`DELETE FROM claim_codes WHERE community_id = ${COMMUNITY}`;
      await sql`DELETE FROM bridges WHERE community_id = ${COMMUNITY}`;
      await sql`DELETE FROM guild_community_secrets WHERE community_id = ${COMMUNITY}`;
    }
    await sql.end();
  });

  it("refuses a code issued to someone else, and does not consume it", async () => {
    await issueCode("aaaa1111", MEMBER);
    const thief = claimant(MEMBER); // proof names the victim, as a thief's would

    expect(importer.claim(COMMUNITY, session(BYSTANDER), thief.body("aaaa1111"))).rejects.toThrow(
      /different Discord account/,
    );
    // The victim can still use it: a failed theft must not burn the code.
    expect(await consumed("aaaa1111")).toBe(false);
  });

  it("refuses even when the thief signs a proof for their own account", async () => {
    await issueCode("bbbb2222", MEMBER);
    const thief = claimant(BYSTANDER);

    expect(importer.claim(COMMUNITY, session(BYSTANDER), thief.body("bbbb2222"))).rejects.toThrow(
      /different Discord account/,
    );
    expect(await consumed("bbbb2222")).toBe(false);
  });

  it("lets the account the code was issued to claim its own puppet", async () => {
    await issueCode("cccc3333", MEMBER);
    const owner = claimant(MEMBER);

    const result = await importer.claim(COMMUNITY, session(MEMBER), owner.body("cccc3333"));

    // Level 3 hands back the puppet key derived for THAT Discord id.
    const expected = derivePuppet(MASTER_SECRET, MEMBER);
    expect(result.puppetNsec).toBe(nip19.nsecEncode(expected.sk));
    expect(bytesToHex(expected.sk)).toBe(bytesToHex(nip19.decode(result.puppetNsec!).data as Uint8Array));
    expect(await consumed("cccc3333")).toBe(true);

    const [row] = await sql<{ npub: string; discord_user_id: string }[]>`
      SELECT npub, discord_user_id FROM claims WHERE community_id = ${COMMUNITY}`;
    expect(row.discord_user_id).toBe(MEMBER);
    expect(row.npub).toBe(owner.npub);
  });

  it("rejects a proof signed for a different Discord identity", async () => {
    await issueCode("dddd4444", BYSTANDER);
    // Right account, but the challenge names someone else.
    const wrong = claimant(MEMBER);

    expect(importer.claim(COMMUNITY, session(BYSTANDER), wrong.body("dddd4444"))).rejects.toThrow(
      /invalid ownership proof/,
    );
  });

  it("rejects an unknown code without leaking whose it might be", async () => {
    const someone = claimant(MEMBER);
    expect(importer.claim(COMMUNITY, session(MEMBER), someone.body("eeee5555"))).rejects.toThrow(
      /wrong, used, or expired/,
    );
  });
});
