/** Divine bridges only explicit public channels, independently of the bot's permissions. */
export interface PublicChannelRules {
  guildId: string;
  channelIds: string[];
  excludedCategoryIds: string[];
}
const SNOWFLAKE = /^[0-9]{17,20}$/;
const VIEW_CHANNEL = 1n << 10n;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Discord visibility data unavailable");
  return value as Record<string, unknown>;
}
function bits(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]{1,24}$/.test(value)) throw new Error("Discord permissions unavailable");
  return BigInt(value);
}
export function parsePublicChannelRules(value?: string): PublicChannelRules {
  try {
    const rules = object(JSON.parse(value ?? "null"));
    const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length > 0 && ids.length <= 500 && ids.every((id) => typeof id === "string" && SNOWFLAKE.test(id)) && new Set(ids).size === ids.length;
    if (typeof rules.guildId !== "string" || !SNOWFLAKE.test(rules.guildId) || !validIds(rules.channelIds) || !validIds(rules.excludedCategoryIds)) throw new Error();
    return { guildId: rules.guildId, channelIds: rules.channelIds, excludedCategoryIds: rules.excludedCategoryIds };
  } catch {
    throw new Error("BRIDGE_PUBLIC_CHANNELS requires a guild ID, channel IDs and excluded category IDs");
  }
}
export class PublicChannelPolicy {
  constructor(
    readonly rules: PublicChannelRules,
    private readonly get: (path: string) => Promise<unknown>,
  ) {}

  async assertPublicChannel(guildId: string, channelId: string): Promise<void> {
    if (guildId !== this.rules.guildId || !this.rules.channelIds.includes(channelId)) throw new Error("Discord channel not allowlisted");
    // Do not use gateway caches: a permission change must apply to replay and the next effect.
    const channel = object(await this.get(`/channels/${channelId}`));
    if (channel.id !== channelId || channel.guild_id !== guildId || channel.type !== 0) throw new Error("Discord channel not public");
    if (channel.parent_id !== null) {
      if (typeof channel.parent_id !== "string" || !SNOWFLAKE.test(channel.parent_id)) throw new Error("Discord category unavailable");
      if (this.rules.excludedCategoryIds.includes(channel.parent_id)) throw new Error("Discord channel in excluded category");
      const parent = object(await this.get(`/channels/${channel.parent_id}`));
      if (parent.id !== channel.parent_id || parent.guild_id !== guildId || parent.type !== 4 || typeof parent.name !== "string") throw new Error("Discord category unavailable");
      if (parent.name.trim().toLowerCase() === "tickets") throw new Error("Discord channel in excluded category");
    }
    const roles = await this.get(`/guilds/${guildId}/roles`);
    if (!Array.isArray(roles)) throw new Error("Discord permissions unavailable");
    const everyone = roles.map(object).filter((role) => role.id === guildId);
    if (everyone.length !== 1 || !Array.isArray(channel.permission_overwrites)) throw new Error("Discord permissions unavailable");
    let permissions = bits(everyone[0].permissions);
    // Only the channel's own overwrites, never the category's. Discord does not
    // inherit category overwrites when it evaluates a channel: a synced channel
    // carries copies of them in its own list, and a desynced one stops following
    // its category entirely. Applying the parent's deny here would disagree with
    // what Discord shows members. importPlan's isPrivate is stricter on purpose:
    // it can only narrow what an import offers, never widen what is bridged.
    const overrides = channel.permission_overwrites.map(object).filter((o) => o.id === guildId);
    if (overrides.length > 1) throw new Error("Discord permissions unavailable");
    if (overrides.length) {
      const overwrite = overrides[0];
      if (overwrite.type !== 0) throw new Error("Discord permissions unavailable");
      permissions = (permissions & ~bits(overwrite.deny)) | bits(overwrite.allow);
    }
    if ((permissions & VIEW_CHANNEL) === 0n) throw new Error("Discord channel not public");
  }
}

export function discordPublicChannelPolicy(rules: PublicChannelRules, token: string): PublicChannelPolicy {
  return new PublicChannelPolicy(rules, async (path) => {
    if (!token) throw new Error("Discord bot not configured");
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Discord visibility data unavailable");
    return response.json();
  });
}
