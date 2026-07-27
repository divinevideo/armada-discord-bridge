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
}

export class Sessions {
  constructor(private readonly sql: postgres.Sql) {}

  async create(c: Context, data: SessionData): Promise<void> {
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
  }

  async get(c: Context): Promise<SessionData | undefined> {
    const sid = getCookie(c, COOKIE);
    if (!sid) return undefined;
    const [row] = await this.sql`
      SELECT data FROM portal_sessions
      WHERE sid = ${sid} AND expires_at > now()`;
    return row?.data as SessionData | undefined;
  }

  async update(c: Context, data: SessionData): Promise<void> {
    const sid = getCookie(c, COOKIE);
    if (!sid) return;
    await this.sql`
      UPDATE portal_sessions SET data = ${this.sql.json(data as never)} WHERE sid = ${sid}`;
  }

  async destroy(c: Context): Promise<void> {
    const sid = getCookie(c, COOKIE);
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
