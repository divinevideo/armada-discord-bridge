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

async function userGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`discord ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const fetchMe = (token: string) => userGet<DiscordUser>(token, "/users/@me");
export const fetchMyGuilds = (token: string) => userGet<OAuthGuild[]>(token, "/users/@me/guilds");

async function botGet<T>(botToken: string, path: string): Promise<T | undefined> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${botToken}` } });
  if (res.status === 403 || res.status === 404) return undefined;
  if (!res.ok) throw new Error(`discord bot ${path} failed: ${res.status}`);
  return (await res.json()) as T;
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
