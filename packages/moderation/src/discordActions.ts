import type postgres from "postgres";
import { derivePuppet } from "../../bridge/src/puppets";
import type { PublicChannelPolicy } from "../../bridge/src/discord/publicChannelPolicy";
import type { StoredDecision } from "./decisions";
import type { DeliveryState } from "./contracts";
async function unknownResource(response: Response, code: number): Promise<boolean> {
  if (response.status !== 404) { await response.body?.cancel(); return false; }
  try { return (await response.json() as { code?: number }).code === code; } catch { return false; }
}
interface MessageCopy { guildId: string; channelId: string; messageId: string }
interface MemberCopy { guildId: string; channelId: string; userId: string }
export interface VerifiedDiscordMappings { messages(decision: StoredDecision): Promise<MessageCopy[]>; member(decision: StoredDecision): Promise<MemberCopy | undefined> }
export class BridgeMappingResolver implements VerifiedDiscordMappings {
  constructor(private readonly sql: postgres.Sql, private readonly tenantId: string, private readonly guildId: string, private readonly puppetMaster: string) {}
  async messages(decision: StoredDecision): Promise<MessageCopy[]> {
    const rows = await this.sql`SELECT discord_message_id, discord_channel_id FROM messages WHERE tenant_id = ${this.tenantId}
      AND community_id = ${decision.target.communityId} AND concord_channel_id = ${decision.target.channelId} AND concord_rumor_id = ${decision.target.rumorId}`;
    return rows.map((row) => ({ guildId: this.guildId, channelId: row.discord_channel_id, messageId: row.discord_message_id }));
  }
  async member(decision: StoredDecision): Promise<MemberCopy | undefined> {
    const rows = await this.sql`SELECT author_ref, discord_channel_id FROM messages WHERE tenant_id = ${this.tenantId}
      AND community_id = ${decision.target.communityId} AND concord_channel_id = ${decision.target.channelId} AND concord_rumor_id = ${decision.target.rumorId} AND origin = 'discord'`;
    for (const row of rows) {
      if (!/^[0-9]{17,20}$/.test(row.author_ref)) continue;
      if (derivePuppet(this.puppetMaster, row.author_ref).pk === decision.author) return { guildId: this.guildId, channelId: row.discord_channel_id, userId: row.author_ref };
    }
    return undefined;
  }
}
export interface DeliveryAttempt { state: DeliveryState; code: string; retryAfterSeconds?: number }
export class RetryableDeliveryError extends Error {
  constructor(readonly code: string, readonly retryAfterSeconds?: number) { super(code); }
}
async function providerRequest(request: (method: string, path: string) => Promise<Response>, method: string, path: string): Promise<Response> {
  let response: Response;
  try { response = await request(method, path); }
  catch { throw new RetryableDeliveryError("discord_transport_unavailable"); }
  if (response.status === 429) {
    let delay = Number(response.headers.get("retry-after"));
    try { const body = await response.json() as { retry_after?: unknown }; if (typeof body.retry_after === "number") delay = body.retry_after; } catch {}
    throw new RetryableDeliveryError("discord_rate_limited", Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : undefined);
  }
  if (response.status >= 500) { await response.body?.cancel(); throw new RetryableDeliveryError("discord_service_unavailable"); }
  return response;
}
export class DiscordActions {
  constructor(private readonly mappings: VerifiedDiscordMappings, private readonly policy: Pick<PublicChannelPolicy, "assertPublicChannel">, private readonly request: (method: string, path: string) => Promise<Response>, private readonly assertCurrent: () => Promise<void> = async () => {}) {}
  async execute(decision: StoredDecision): Promise<DeliveryAttempt> {
    try {
      if (decision.action === "remove_message") {
        const copies = await this.mappings.messages(decision);
        if (!copies.length) return { state: "not_applicable", code: "no_discord_mapping" };
        for (const copy of copies) {
          if (![copy.guildId, copy.channelId, copy.messageId].every((id) => /^[0-9]{17,20}$/.test(id))) throw new Error("Invalid Discord mapping");
          await this.policy.assertPublicChannel(copy.guildId, copy.channelId);
          await this.assertCurrent();
          const response = await providerRequest(this.request, "DELETE", `/channels/${copy.channelId}/messages/${copy.messageId}`);
          const deleted = response.status === 204 || await unknownResource(response, 10008);
          if (!deleted) return { state: "failed", code: response.status === 429 ? "discord_rate_limited" : "discord_delete_failed" };
          const verification = await providerRequest(this.request, "GET", `/channels/${copy.channelId}/messages/${copy.messageId}`);
          if (!await unknownResource(verification, 10008)) return { state: "failed", code: "discord_delete_unverified" };
        }
      } else {
        if (!decision.discordGuildConfirmed) return { state: "not_applicable", code: "guild_scope_not_requested" };
        const member = await this.mappings.member(decision);
        if (!member) return { state: "not_applicable", code: "no_verified_discord_member" };
        if (![member.guildId, member.channelId, member.userId].every((id) => /^[0-9]{17,20}$/.test(id))) throw new Error("Invalid Discord mapping");
        await this.policy.assertPublicChannel(member.guildId, member.channelId);
        await this.assertCurrent();
        const path = `/guilds/${member.guildId}/bans/${member.userId}`;
        const response = await providerRequest(this.request, decision.action === "ban_member" ? "PUT" : "DELETE", path);
        const applied = response.status === 204 || (decision.action === "unban_member" && await unknownResource(response, 10026));
        if (!applied) return { state: "failed", code: response.status === 429 ? "discord_rate_limited" : "discord_member_action_failed" };
        const verification = await providerRequest(this.request, "GET", path);
        const verified = decision.action === "ban_member" ? verification.status === 200 && (await verification.json() as { user?: { id?: string } }).user?.id === member.userId : await unknownResource(verification, 10026);
        if (!verified) return { state: "failed", code: "discord_member_action_unverified" };
      }
      return { state: "verified", code: "discord_enforcement_verified" };
    } catch (error) {
      if (error instanceof RetryableDeliveryError) return { state: "pending", code: error.code, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) };
      return { state: "failed", code: "discord_authority_or_delivery_unavailable" };
    }
  }
}
export function discordRequest(token: string) {
  return (method: string, path: string) => fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(5000), redirect: "error" });
}
