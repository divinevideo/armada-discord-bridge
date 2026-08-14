/**
 * Minimal Discord REST helpers for the portal: OAuth exchange (user side)
 * and bot-token lookups (guild presence, channel lists). No gateway here;
 * the BridgeManager owns the gateway connection.
 */

const API = "https://discord.com/api/v10";

/** Manage Webhooks + View Channel + Send Messages + Read History + Add Reactions + Manage Messages. */
export const BOT_PERMISSIONS = "536947776";

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
  avatar?: string;
}

export interface OAuthGuild {
  id: string;
  name: string;
  icon?: string;
  permissions: string;
}

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

export function canManage(guild: OAuthGuild): boolean {
  const bits = BigInt(guild.permissions);
  return (bits & MANAGE_GUILD) !== 0n || (bits & ADMINISTRATOR) !== 0n;
}

export function oauthUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    // `guilds.members.read` is deliberately absent: the only thing that ever
    // needed a member's roles was the claim feature, and asking for a scope
    // nothing spends is a consent screen users are right to distrust.
    scope: "identify guilds",
    state,
  });
  return `${API}/oauth2/authorize?${q}`;
}

export function botInstallUrl(clientId: string, guildId: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    scope: "bot",
    permissions: BOT_PERMISSIONS,
    guild_id: guildId,
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<string> {
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  });
  if (!res.ok) throw new Error(`oauth token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

/** Longest single 429 wait we honor; Discord's global bans can claim hours. */
const MAX_RATELIMIT_WAIT_MS = 60_000;
/** Total 429 waiting per request before giving up and surfacing the 429. */
const RATELIMIT_BUDGET_MS = 5 * 60_000;

/**
 * fetch that waits out Discord 429s instead of failing: sleeps for the
 * `retry_after` the API reports (JSON body, falling back to the Retry-After
 * header) and retries, until the per-request budget runs out. History
 * backfill pages one route hundreds of times, so rate limits here are
 * routine, and imports used to die on the first one.
 */
async function discordFetch(path: string, headers: Record<string, string>): Promise<Response> {
  let waitedMs = 0;
  for (;;) {
    const res = await fetch(`${API}${path}`, { headers });
    if (res.status !== 429) return res;
    let retryAfterMs = Number(res.headers.get("Retry-After")) * 1000;
    try {
      const body = (await res.clone().json()) as { retry_after?: number };
      if (typeof body.retry_after === "number") retryAfterMs = body.retry_after * 1000;
    } catch {
      // non-JSON 429 (Cloudflare); the header value stands
    }
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) retryAfterMs = 5_000;
    retryAfterMs = Math.min(retryAfterMs, MAX_RATELIMIT_WAIT_MS);
    if (waitedMs + retryAfterMs > RATELIMIT_BUDGET_MS) return res;
    waitedMs += retryAfterMs;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
  }
}

async function userGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await discordFetch(path, { Authorization: `Bearer ${accessToken}` });
  if (!res.ok) throw new Error(`discord ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const fetchMe = (token: string) => userGet<DiscordUser>(token, "/users/@me");
export const fetchMyGuilds = (token: string) => userGet<OAuthGuild[]>(token, "/users/@me/guilds");

async function botGet<T>(botToken: string, path: string): Promise<T | undefined> {
  const res = await discordFetch(path, { Authorization: `Bot ${botToken}` });
  if (res.status === 403 || res.status === 404) return undefined;
  if (!res.ok) throw new Error(`discord bot ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Whether the bot can manage webhooks in a channel — the permission the live
 * bridge needs to mirror Armada messages into Discord as personas. A 403 is
 * the bot lacking it; anything else (200, or a 404 for a channel that has
 * since gone) is not flagged here, so the import preview only warns on a
 * genuine permission gap.
 */
export async function botCanManageWebhooks(botToken: string, channelId: string): Promise<boolean> {
  const res = await discordFetch(`/channels/${channelId}/webhooks`, { Authorization: `Bot ${botToken}` });
  return res.status !== 403;
}

export interface GuildChannel {
  id: string;
  name: string;
  type: number;
  position: number;
}

/** Text channels of a guild, or undefined when the bot is not a member yet. */
export async function botGuildTextChannels(
  botToken: string,
  guildId: string,
): Promise<GuildChannel[] | undefined> {
  const channels = await botGet<GuildChannel[]>(botToken, `/guilds/${guildId}/channels`);
  if (!channels) return undefined;
  return channels.filter((c) => c.type === 0).sort((a, b) => a.position - b.position);
}

// ── Full-guild snapshot (server import) ─────────────────────────────────────

/** One channel permission overwrite: role (type 0) or member (type 1). */
export interface ChannelOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

/** A guild channel with everything the import mapper reads. */
export interface SnapshotChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id?: string | null;
  topic?: string | null;
  permission_overwrites?: ChannelOverwrite[];
}

/** A guild role as returned inline on the guild object. */
export interface SnapshotRole {
  id: string;
  name: string;
  permissions: string;
  color: number;
  hoist: boolean;
  position: number;
  managed: boolean;
  tags?: Record<string, unknown>;
}

export interface SnapshotEmoji {
  id: string;
  name: string;
  animated?: boolean;
  managed?: boolean;
  available?: boolean;
}

export interface SnapshotGuild {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  banner?: string | null;
  splash?: string | null;
  owner_id?: string;
  approximate_member_count?: number;
  roles: SnapshotRole[];
  emojis?: SnapshotEmoji[];
}

export interface GuildSnapshot {
  guild: SnapshotGuild;
  channels: SnapshotChannel[];
}

/**
 * Read a guild's full structure (settings, roles, channels with overwrites)
 * with the bot token. Undefined when the bot is not installed in the guild.
 * Two REST calls; roles, emojis, and member counts arrive inline.
 */
export async function botGuildSnapshot(
  botToken: string,
  guildId: string,
): Promise<GuildSnapshot | undefined> {
  const guild = await botGet<SnapshotGuild>(botToken, `/guilds/${guildId}?with_counts=true`);
  if (!guild) return undefined;
  const channels = await botGet<SnapshotChannel[]>(botToken, `/guilds/${guildId}/channels`);
  if (!channels) return undefined;
  return { guild, channels };
}

// ── Message history (server import backfill) ─────────────────────────────────

export interface RestMessage {
  id: string;
  /** 0 = DEFAULT, 19 = REPLY; everything else is a system message. */
  type: number;
  content: string;
  timestamp: string;
  author: { id: string; username: string; global_name?: string | null; avatar?: string | null; bot?: boolean };
  attachments?: Array<{ url: string; filename: string }>;
  embeds?: Array<{
    url?: string;
    video?: { url?: string };
    image?: { url?: string };
    thumbnail?: { url?: string };
  }>;
  mentions?: Array<{ id: string; username: string; global_name?: string | null }>;
  message_reference?: { message_id?: string };
  webhook_id?: string;
  application_id?: string | null;
}

/**
 * One page of channel history, NEWEST first, strictly before `beforeId`
 * (omit for the newest page). Empty array when the channel has no more;
 * undefined when the bot cannot read the channel.
 */
export async function botChannelMessagesBefore(
  botToken: string,
  channelId: string,
  beforeId?: string,
  limit = 100,
): Promise<RestMessage[] | undefined> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (beforeId) q.set("before", beforeId);
  return botGet<RestMessage[]>(botToken, `/channels/${channelId}/messages?${q}`);
}
