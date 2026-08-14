/**
 * Cookie sessions backed by portal_sessions. The session carries the Discord
 * identity and the manageable-guild list captured at OAuth time; guild
 * authority is re-checked against this at mutation time and refreshed on
 * re-login.
 *
 * Nothing in the row is usable on its own. The session id is a bearer
 * credential — the cookie value and the API token are the same string — so
 * the table stores only its SHA-256, and the Discord OAuth bearer riding
 * along in `data` is sealed. A database-only compromise (backup, replica,
 * dump, an over-shared console) therefore yields no session to hijack and no
 * token to spend against Discord.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type postgres from "postgres";

import { seal, unseal } from "./seal";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = "portal_sid";

/** What the `sid` column holds for a given raw token. */
const hashSid = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");

export interface SessionGuild {
  id: string;
  name: string;
  icon?: string;
  canManage: boolean;
}

export interface SessionData {
  user: { id: string; username: string; avatarUrl?: string };
  guilds: SessionGuild[];
  /**
   * When `guilds` was last read from Discord (epoch ms). Authority to act on
   * a guild expires with it: see `guildAuthority` in index.ts, which re-reads
   * rather than trusting a snapshot indefinitely.
   */
  guildsFetchedAt?: number;
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
  /**
   * OAuth bearer, kept for claim-time member lookups (guilds.members.read).
   * Sealed on the way into the row; callers only ever see the plaintext.
   */
  accessToken?: string;
}

export class Sessions {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly sealKeyHex: string,
    /**
     * Mark the cookie `Secure`, so it never rides a plaintext request. Driven
     * by the deployment's own base URL rather than the request's scheme: the
     * portal sits behind a TLS proxy and sees plain HTTP on loopback, so
     * inferring it per-request would disable it exactly where it matters.
     */
    private readonly secureCookie = false,
  ) {}

  private cookieOptions(expires: Date) {
    return { httpOnly: true, sameSite: "Lax", path: "/", secure: this.secureCookie, expires } as const;
  }

  /** Creates the session, sets the cookie, and returns the raw session id. */
  async create(c: Context, data: SessionData): Promise<string> {
    const sid = randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    await this.sql`
      INSERT INTO portal_sessions (sid, data, expires_at)
      VALUES (${hashSid(sid)}, ${this.sql.json(this.toStored(data) as never)}, ${expires})`;
    setCookie(c, COOKIE, sid, this.cookieOptions(expires));
    return sid;
  }

  /**
   * Replace a session's id, returning the new raw token.
   *
   * Two jobs. It is the moment a pre-auth row becomes an authenticated
   * session, where rotating is the textbook defence against session fixation.
   * And because the table stores only hashes, rotation is the *only* way to
   * obtain a usable token for a session found by state or nonce rather than
   * by cookie — the callback has no other way to learn what to hand back.
   *
   * `handoff` additionally seals the new token into the row for the popup
   * poller to collect (see {@link collectHandoff}), so both legs of that flow
   * hand out the same token instead of racing to invalidate each other.
   */
  async rotate(sidHash: string, data: SessionData, handoff = false): Promise<string> {
    const sid = randomBytes(24).toString("hex");
    await this.sql`
      UPDATE portal_sessions
      SET sid = ${hashSid(sid)}, data = ${this.sql.json(this.toStored(data) as never)},
          handoff_sealed = ${handoff ? seal(this.sealKeyHex, sid) : null}
      WHERE sid = ${sidHash}`;
    return sid;
  }

  /**
   * Take the sealed token stashed by {@link rotate} for the nonce poller, and
   * spend it: a second collection finds nothing. Uncollected stashes expire
   * with their session.
   */
  async collectHandoff(sidHash: string, data: SessionData): Promise<string | undefined> {
    // RETURNING reports post-update values, so the stash is read from the
    // pre-update snapshot the FROM clause supplies.
    const [row] = await this.sql<{ handoff_sealed: Uint8Array | null }[]>`
      UPDATE portal_sessions s
      SET data = ${this.sql.json(this.toStored(data) as never)}, handoff_sealed = NULL
      FROM portal_sessions prev
      WHERE s.sid = ${sidHash} AND prev.sid = s.sid
      RETURNING prev.handoff_sealed`;
    if (!row?.handoff_sealed) return undefined;
    return unseal(this.sealKeyHex, row.handoff_sealed);
  }

  /** Row shape: everything as-is except the OAuth bearer, which is sealed. */
  private toStored(data: SessionData): SessionData {
    if (!data.accessToken) return data;
    return { ...data, accessToken: seal(this.sealKeyHex, data.accessToken).toString("hex") };
  }

  /**
   * Inverse of {@link toStored}. An unreadable bearer (key rotated out from
   * under the row) is dropped rather than fatal: it degrades a claim to "no
   * roles granted", exactly as an expired OAuth scope already does.
   */
  private fromStored(stored: SessionData | undefined): SessionData | undefined {
    if (!stored?.accessToken) return stored;
    try {
      return { ...stored, accessToken: unseal(this.sealKeyHex, Buffer.from(stored.accessToken, "hex")) };
    } catch {
      const { accessToken: _unreadable, ...rest } = stored;
      return rest as SessionData;
    }
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
      WHERE sid = ${hashSid(sid)} AND expires_at > now()`;
    return this.fromStored(row?.data as SessionData | undefined);
  }

  /**
   * The session that started the OAuth run named by `state`, for the callback.
   *
   * The callback deliberately does NOT identify the session by cookie: the
   * popup flow's cookie routinely fails to survive the round trip through
   * Discord (privacy modes that scope a popup's cookies to its opener, logins
   * that continue in a different window or the Discord app, a second click on
   * Connect overwriting the first popup's cookie), and the 128-bit
   * single-shot `oauthState` is the CSRF binding anyway. {@link rotate}
   * replaces the data without `oauthState`, so a state can never be spent
   * twice.
   *
   * Returns the *hashed* id, which is all the table has: it identifies the
   * row for a later write but cannot be handed to a browser. Use
   * {@link rotate} to mint a token for it.
   */
  async findByOauthState(state: string): Promise<{ sidHash: string; data: SessionData; expires: Date } | undefined> {
    const [row] = await this.sql`
      SELECT sid, data, expires_at FROM portal_sessions
      WHERE data->>'oauthState' = ${state} AND expires_at > now()`;
    if (!row) return undefined;
    return {
      sidHash: row.sid as string,
      data: this.fromStored(row.data as SessionData)!,
      expires: new Date(row.expires_at as string),
    };
  }

  /** The completed-or-pending OAuth run named by a claim nonce. */
  async findByClaimNonce(nonce: string): Promise<{ sidHash: string; data: SessionData } | undefined> {
    const [row] = await this.sql`
      SELECT sid, data FROM portal_sessions
      WHERE data->>'claimNonce' = ${nonce} AND expires_at > now()`;
    if (!row) return undefined;
    return { sidHash: row.sid as string, data: this.fromStored(row.data as SessionData)! };
  }

  /**
   * (Re)issue the cookie for an existing session. The callback uses this so
   * the redirect flow stays signed in even when the auth-start cookie was
   * lost or overwritten between the two legs.
   */
  adopt(c: Context, sid: string, expires: Date): void {
    setCookie(c, COOKIE, sid, this.cookieOptions(expires));
  }

  async update(c: Context, data: SessionData): Promise<void> {
    const sid = this.sid(c);
    if (!sid) return;
    await this.sql`
      UPDATE portal_sessions SET data = ${this.sql.json(this.toStored(data) as never)}
      WHERE sid = ${hashSid(sid)}`;
  }

  async destroy(c: Context): Promise<void> {
    const sid = this.sid(c);
    if (!sid) return;
    await this.sql`DELETE FROM portal_sessions WHERE sid = ${hashSid(sid)}`;
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
