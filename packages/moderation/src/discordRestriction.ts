import type postgres from "postgres";
import type { PublicChannelPolicy } from "../../bridge/src/discord/publicChannelPolicy";
import type { StoredDecision } from "./decisions";
import { providerRequest, RetryableDeliveryError, type VerifiedDiscordMappings } from "./discordActions";
import { lockLifecycleDecision } from "./lifecycle";
import { PolicyStore, policyLock } from "./policyStore";
import { controlState } from "./relayPolicy";
export async function restrictionProofKey(tx: postgres.TransactionSql, row: any): Promise<string | undefined> {
  await policyLock(tx, row.community_id, true);
  const policy = await new PolicyStore(tx as unknown as postgres.Sql).getPolicy(row.community_id);
  if (!policy || !policy.complete || policy.rekeyPending || policy.validUntil <= Date.now()) return;
  const state = controlState(policy); if (state.folded.incomplete.length) return;
  const [proof] = await tx`SELECT encode(sha256(convert_to(jsonb_build_array(
      c.payload->>'rootEpoch',
      (SELECT jsonb_agg(e.id ORDER BY e.id) FROM (SELECT value->>'id' AS id FROM jsonb_array_elements(c.payload->'controlEvents') UNION SELECT event->>'id' FROM moderation.accepted_control WHERE community_id = c.community_id) e),
      (SELECT to_jsonb(h) FROM moderation.member_order_heads h WHERE h.org_id = ${row.org_id} AND h.community_id = c.community_id AND h.author = ${row.author}),
      COALESCE((SELECT blocked FROM moderation.member_bans b WHERE b.community_id = c.community_id AND b.author = ${row.author}), false)
    )::text, 'UTF8')), 'hex') AS key FROM moderation.community_policy c WHERE c.community_id = ${row.community_id}`;
  return proof?.key;

}
export async function hasGuildHistory(tx: postgres.TransactionSql, row: any): Promise<boolean> {
  const [history] = await tx`SELECT 1 FROM moderation.decisions WHERE org_id = ${row.org_id} AND community_id = ${row.community_id} AND author = ${row.author} AND discord_guild_confirmed
    UNION ALL SELECT 1 FROM moderation.member_order_heads WHERE org_id = ${row.org_id} AND community_id = ${row.community_id} AND author = ${row.author} AND (latest_guild_revision IS NOT NULL OR guild_scope_known_after > 0) LIMIT 1`;
  return Boolean(history);
}
export async function observeDiscordRestriction(decision: StoredDecision, mappings: VerifiedDiscordMappings, policy: Pick<PublicChannelPolicy, "assertPublicChannel">, request: (method: string, path: string) => Promise<Response>, historicalGuild: boolean): Promise<{ state: "present" | "absent" | "unknown" | "not_applicable"; code: string; retryAfterSeconds?: number }> {
  try {
    const member = await mappings.member(decision);
    if (!member) return historicalGuild ? { state: "unknown", code: "discord_mapping_unavailable" } : { state: "not_applicable", code: "no_verified_discord_member" };
    if (![member.guildId, member.channelId, member.userId].every(id => /^[0-9]{17,20}$/.test(id))) return { state: "unknown", code: "discord_mapping_unavailable" };
    await policy.assertPublicChannel(member.guildId, member.channelId);
    const response = await providerRequest(request, "GET", `/guilds/${member.guildId}/bans/${member.userId}`);
    let result: { state: "present" | "absent" | "unknown"; code: string } = { state: "unknown", code: "discord_restriction_unverified" };
    const value = await response.json().catch(() => null) as { code?: number; user?: { id?: string } } | null;
    if (response.status === 200 && value?.user?.id === member.userId) result = { state: "present", code: "discord_restriction_present" };
    if (response.status === 404 && value?.code === 10026) result = { state: "absent", code: "discord_restriction_absent" };
    await policy.assertPublicChannel(member.guildId, member.channelId);
    return result;
  } catch (error) { return { state: "unknown", code: error instanceof RetryableDeliveryError ? error.code : "discord_observation_unavailable", ...(error instanceof RetryableDeliveryError && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }; }
}
export class DiscordRestrictionObserver {
  constructor(private readonly sql: postgres.Sql, private readonly mappings: VerifiedDiscordMappings, private readonly policy: Pick<PublicChannelPolicy, "assertPublicChannel">, private readonly request: (method: string, path: string) => Promise<Response>, private readonly communities: ReadonlyMap<string, string>) {}
  async refresh(decisionId: string): Promise<boolean> {
    const snapshot = await this.sql.begin(async tx => {
      const locked = await lockLifecycleDecision(tx, (await tx`SELECT org_id FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0]?.org_id ?? "", decisionId);
      const row = locked.decision, delivery = locked.deliveries.find(d => d.target === "discord");
      if (this.communities.get(row.community_id) !== row.org_id || row.action === "remove_message" || !delivery || delivery.lease_until?.getTime() > Date.now()) return;
      const key = await restrictionProofKey(tx, row); if (!key) return;
      return { row, delivery, key, guild: await hasGuildHistory(tx, row) };
    });
    if (!snapshot) return false;
    const row = snapshot.row;
    const observation = await observeDiscordRestriction({ decisionId: row.decision_id, orgId: row.org_id, caseId: row.case_id, target: { communityId: row.community_id, channelId: row.channel_id, rumorId: row.rumor_id }, author: row.author, action: row.action, discordGuildConfirmed: row.discord_guild_confirmed, expiresAt: row.expires_at }, this.mappings, this.policy, this.request, snapshot.guild);
    return this.sql.begin(async tx => {
      const { decision, deliveries } = await lockLifecycleDecision(tx, row.org_id, row.decision_id), delivery = deliveries.find(d => d.target === "discord");
      if (!delivery || delivery.lease_until?.getTime() > Date.now() || String(delivery.available_at) !== String(snapshot.delivery.available_at) || delivery.token !== snapshot.delivery.token || delivery.state !== snapshot.delivery.state || await restrictionProofKey(tx, decision) !== snapshot.key) return false;
      await tx`UPDATE moderation.deliveries SET discord_restriction_state = ${observation.state}, discord_restriction_code = ${observation.code}, discord_restriction_checked_at = clock_timestamp(), discord_restriction_proof_key = ${snapshot.key}, available_at = CASE WHEN ${observation.retryAfterSeconds ?? 0} > 0 THEN clock_timestamp() + (${observation.retryAfterSeconds ?? 0} * interval '1 second') ELSE available_at END WHERE decision_id = ${row.decision_id} AND target = 'discord'`;
      return true;
    }) as Promise<boolean>;
  }
  async tick(): Promise<void> {
    // A present/unknown restriction keeps expired audit due. Rotate by the last
    // observation so that record cannot monopolize the worker indefinitely.
    const [row] = await this.sql`SELECT c.decision_id FROM moderation.decisions c JOIN moderation.deliveries d USING (decision_id)
      WHERE c.community_id IN ${this.sql([...this.communities.keys()])} AND c.action IN ('ban_member','unban_member') AND d.target = 'discord' AND d.available_at <= clock_timestamp() AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
        AND (d.discord_restriction_checked_at IS NULL OR d.available_at > d.discord_restriction_checked_at OR (c.audit IS NOT NULL AND c.audit_delete_after <= clock_timestamp()))
      ORDER BY d.discord_restriction_checked_at NULLS FIRST, d.available_at, c.decision_id LIMIT 1`;
    if (row) await this.refresh(row.decision_id);
  }
}
