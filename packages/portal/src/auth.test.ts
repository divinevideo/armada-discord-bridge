/**
 * Sessions at rest: the row must not contain anything a database reader could
 * spend — not the session token, not the Discord OAuth bearer. Runs against
 * the local Postgres (skipped when unreachable); rows are cleaned up.
 */

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { migrate } from "@armada-bridge/bridge/src/db/migrate";
import { Hono } from "hono";
import postgres from "postgres";

import { Sessions } from "./auth";
import type { SessionData } from "./auth";

const DB_URL = process.env.DATABASE_URL ?? "postgres://bridge:bridge@localhost:5432/bridge";
const SEAL_KEY = "ab".repeat(32);
const USER = "test-sessions-42";

const sql = postgres(DB_URL, { max: 2, onnotice: () => {}, connect_timeout: 3 });
const dbUp = await sql`SELECT 1`.then(() => true).catch(() => false);
if (!dbUp) await sql.end();

const TOKEN = "discord-oauth-bearer-value";
const data = (extra: Partial<SessionData> = {}): SessionData => ({
  user: { id: USER, username: "tester" },
  guilds: [],
  accessToken: TOKEN,
  ...extra,
});

/** What the sid column is expected to hold for a given token. */
const hashOf = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");

/** The row as a database-only attacker would see it; keyed by the hash. */
async function rowFor(raw: string) {
  const [row] = await sql<{ sid: string; data: SessionData; handoff_sealed: Uint8Array | null }[]>`
    SELECT sid, data, handoff_sealed FROM portal_sessions WHERE sid = ${hashOf(raw)}`;
  return row;
}

/** Drives Sessions through a real Hono context. */
function harness(sessions: Sessions) {
  const app = new Hono();
  app.get("/create", async (c) => c.json({ sid: await sessions.create(c, data()) }));
  app.get("/me", async (c) => c.json({ session: (await sessions.get(c)) ?? null }));
  app.get("/logout", async (c) => {
    await sessions.destroy(c);
    return c.json({ ok: true });
  });
  const me = async (headers: Record<string, string>) =>
    ((await (await app.request("/me", { headers })).json()) as { session: SessionData | null }).session;
  return {
    create: async (): Promise<string> => ((await (await app.request("/create")).json()) as { sid: string }).sid,
    me: (sid: string) => me({ Authorization: `Bearer ${sid}` }),
    meByCookie: (sid: string) => me({ Cookie: `portal_sid=${sid}` }),
    logout: (sid: string) => app.request("/logout", { headers: { Authorization: `Bearer ${sid}` } }),
  };
}

describe.skipIf(!dbUp)("Sessions", () => {
  const sessions = new Sessions(sql, SEAL_KEY);
  const h = harness(sessions);

  beforeAll(async () => {
    await migrate(DB_URL);
    await sql`DELETE FROM portal_sessions WHERE data->'user'->>'id' = ${USER}`;
  });

  afterAll(async () => {
    if (dbUp) await sql`DELETE FROM portal_sessions WHERE data->'user'->>'id' = ${USER}`;
    await sql.end();
  });

  it("stores the hash of the token, never the token", async () => {
    const sid = await h.create();
    expect(sid).toMatch(/^[0-9a-f]{48}$/);
    // The row is found by the hash: that IS the stored form.
    expect((await rowFor(sid)).sid).toBe(hashOf(sid));
    expect(await h.me(sid)).not.toBeNull();
  });

  it("does not accept the stored id as a token", async () => {
    const sid = await h.create();
    expect(await h.meByCookie(hashOf(sid))).toBeNull();
  });

  it("seals the Discord bearer, and hands it back in plaintext", async () => {
    const sid = await h.create();
    const row = await rowFor(sid);
    expect(row.data.accessToken).not.toBe(TOKEN);
    expect(JSON.stringify(row.data)).not.toContain(TOKEN);
    expect((await h.me(sid))?.accessToken).toBe(TOKEN);
  });

  it("drops an unreadable bearer instead of failing the session", async () => {
    const sid = await h.create();
    const otherKey = new Sessions(sql, "cd".repeat(32));
    const app = new Hono().get("/me", async (c) => c.json({ s: (await otherKey.get(c)) ?? null }));
    const { s } = (await (
      await app.request("/me", { headers: { Authorization: `Bearer ${sid}` } })
    ).json()) as { s: SessionData | null };
    expect(s?.user.id).toBe(USER);
    expect(s?.accessToken).toBeUndefined();
  });

  it("rotate mints a working token and kills the old one", async () => {
    const sid = await h.create();
    const next = await sessions.rotate(hashOf(sid), data({ user: { id: USER, username: "rotated" } }));
    expect(next).not.toBe(sid);
    expect(await h.me(sid)).toBeNull();
    expect((await h.me(next))?.user.username).toBe("rotated");
  });

  it("hands the popup poller the same token the callback minted, once", async () => {
    const sid = await h.create();
    const pending = data({ claimNonce: "feedface", user: { id: USER, username: "pending" } });
    const minted = await sessions.rotate(hashOf(sid), pending, true);

    const found = await sessions.findByClaimNonce("feedface");
    expect(found?.sidHash).toBe(hashOf(minted));
    // Stashed sealed: the portal can read it back, the row does not show it.
    const stash = (await rowFor(minted)).handoff_sealed!;
    expect(Buffer.from(stash).toString("utf8")).not.toContain(minted);

    const { claimNonce: _spent, ...rest } = found!.data;
    expect(await sessions.collectHandoff(found!.sidHash, rest as SessionData)).toBe(minted);
    // Single-use, and the nonce goes with it.
    expect(await sessions.collectHandoff(found!.sidHash, rest as SessionData)).toBeUndefined();
    expect(await sessions.findByClaimNonce("feedface")).toBeUndefined();
    expect((await h.me(minted))?.user.username).toBe("pending");
  });

  it("destroy removes the row", async () => {
    const sid = await h.create();
    await h.logout(sid);
    expect(await h.me(sid)).toBeNull();
    expect(await rowFor(sid)).toBeUndefined();
  });
});
