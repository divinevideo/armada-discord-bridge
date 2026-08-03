/**
 * Cookie sessions backed by portal_sessions. The session carries the Discord
 * identity and the manageable-guild list captured at OAuth time; guild
 * authority is re-checked against this at mutation time and refreshed on
 * re-login.
 */

import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type postgres from "postgres";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = "portal_sid";

export interface SessionGuild {
  id: string;
  name: string;
  icon?: string;
  canManage: boolean;
}

export interface SessionData {
  user: { id: string; username: string; avatarUrl?: string };
  guilds: SessionGuild[];
  oauthState?: string;
  dev?: boolean;
  /**
   * Set when the OAuth run was started from a popup opened by an allow-listed
   * origin; the callback hands the session token back to that exact origin via
   * postMessage instead of redirecting. Validated against `allowedOrigins` at
   * both ends, so it can never name a site the operator didn't approve.
   */
  popupOrigin?: string;
  /**
   * Client-generated random nonce for the popup flow. Discord's pages carry
   * `Cross-Origin-Opener-Policy: same-origin-allow-popups`, which severs the
   * popup's `window.opener` the moment it navigates there — so the callback's
   * postMessage handoff cannot be relied on. The opener instead polls
   * `/api/auth/claim` with this nonce; the first claim after the callback
   * completes returns the session token and spends the nonce.
   */
  claimNonce?: string;
  /** OAuth bearer, kept for claim-time member lookups (guilds.members.read). */
  accessToken?: string;
}

export class Sessions {
  constructor(private readonly sql: postgres.Sql) {}

  /** Creates the session, sets the cookie, and returns the raw session id. */
  async create(c: Context, data: SessionData): Promise<string> {
    const sid = randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    await this.sql`
      INSERT INTO portal_sessions (sid, data, expires_at)
      VALUES (${sid}, ${this.sql.json(data as never)}, ${expires})`;
    setCookie(c, COOKIE, sid, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      expires,
    });
    return sid;
  }

  /**
   * The session id for this request: the cookie, or an `Authorization: Bearer`
   * token.
   *
   * The bearer path exists for clients on another origin (Armada running the
   * import wizard in-app), where the `SameSite=Lax` cookie is never sent and
   * relaxing it to `None` would put the session at the mercy of third-party
   * cookie blocking. A token is only ever handed to an origin the operator
   * allow-listed, and unlike a cookie it is not attached automatically, so a
   * hostile page cannot spend it just by making the browser issue a request.
   */
  /** The raw session id, for handing to an allow-listed origin as a token. */
  token(c: Context): string | undefined {
    return this.sid(c);
  }

  private sid(c: Context): string | undefined {
    const header = c.req.header("Authorization") ?? "";
    const bearer = /^Bearer\s+([0-9a-f]{48})$/i.exec(header.trim());
    return bearer ? bearer[1].toLowerCase() : getCookie(c, COOKIE);
  }

  async get(c: Context): Promise<SessionData | undefined> {
    const sid = this.sid(c);
    if (!sid) return undefined;
    const [row] = await this.sql`
      SELECT data FROM portal_sessions
      WHERE sid = ${sid} AND expires_at > now()`;
    return row?.data as SessionData | undefined;
  }

  /**
   * The session that started the OAuth run named by `state`, for the callback.
   *
   * The callback deliberately does NOT identify the session by cookie: the
   * popup flow's cookie routinely fails to survive the round trip through
   * Discord (privacy modes that scope a popup's cookies to its opener, logins
   * that continue in a different window or the Discord app, a second click on
   * Connect overwriting the first popup's cookie), and the 128-bit
   * single-shot `oauthState` is the CSRF binding anyway. `sessions.update`
   * replaces the data without `oauthState`, so a state can never be spent
   * twice.
   */
  async findByOauthState(state: string): Promise<{ sid: string; data: SessionData; expires: Date } | undefined> {
    const [row] = await this.sql`
      SELECT sid, data, expires_at FROM portal_sessions
      WHERE data->>'oauthState' = ${state} AND expires_at > now()`;
    if (!row) return undefined;
    return { sid: row.sid as string, data: row.data as SessionData, expires: new Date(row.expires_at as string) };
  }

  /** The completed-or-pending OAuth run named by a claim nonce. */
  async findByClaimNonce(nonce: string): Promise<{ sid: string; data: SessionData } | undefined> {
    const [row] = await this.sql`
      SELECT sid, data FROM portal_sessions
      WHERE data->>'claimNonce' = ${nonce} AND expires_at > now()`;
    if (!row) return undefined;
    return { sid: row.sid as string, data: row.data as SessionData };
  }

  /** Update a session found by {@link findByOauthState} (no cookie in hand). */
  async updateBySid(sid: string, data: SessionData): Promise<void> {
    await this.sql`
      UPDATE portal_sessions SET data = ${this.sql.json(data as never)} WHERE sid = ${sid}`;
  }

  /**
   * (Re)issue the cookie for an existing session. The callback uses this so
   * the redirect flow stays signed in even when the auth-start cookie was
   * lost or overwritten between the two legs.
   */
  adopt(c: Context, sid: string, expires: Date): void {
    setCookie(c, COOKIE, sid, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      expires,
    });
  }

  async update(c: Context, data: SessionData): Promise<void> {
    const sid = this.sid(c);
    if (!sid) return;
    await this.sql`
      UPDATE portal_sessions SET data = ${this.sql.json(data as never)} WHERE sid = ${sid}`;
  }

  async destroy(c: Context): Promise<void> {
    const sid = this.sid(c);
    if (!sid) return;
    await this.sql`DELETE FROM portal_sessions WHERE sid = ${sid}`;
    setCookie(c, COOKIE, "", { path: "/", expires: new Date(0) });
  }

  async sweep(): Promise<void> {
    await this.sql`DELETE FROM portal_sessions WHERE expires_at <= now()`;
  }
}

/** 401-guarding helper: returns the session or writes the error response. */
export async function requireSession(c: Context, sessions: Sessions): Promise<SessionData | undefined> {
  const session = await sessions.get(c);
  if (!session) {
    c.status(401);
    return undefined;
  }
  return session;
}
