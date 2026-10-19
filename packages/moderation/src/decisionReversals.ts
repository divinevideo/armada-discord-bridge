import type { ReversalContext, ReversalInput } from "./lifecycleContracts";
export function validateReversalInput(input: ReversalInput): void {
  const order = input?.sourceOrder;
  if (!input || Object.keys(input).sort().join(",") !== "action,discordGuildConfirmed,executionId,reason,scope,sourceOrder" || input.action !== "unban_member" || input.scope !== "community" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.executionId) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2048 || typeof input.discordGuildConfirmed !== "boolean" || !order || Object.keys(order).sort().join(",") !== "revision,version" || order.version !== 1 || typeof order.revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(order.revision) || BigInt(order.revision) > 9223372036854775807n) throw new Error("Invalid reversal");
}
/** A retained decision supplies identity, never recreated report bytes or a caller target. */
export function reversalContext(row: any, deliveries: any[], communities: ReadonlyMap<string, string>): ReversalContext | undefined {
  if (!row || row.action !== "ban_member" || communities.get(row.community_id) !== row.org_id || !["concord", "divine_relay"].every(target => deliveries.some(d => d.target === target && d.state === "verified"))) return;
  return { decisionId: row.decision_id, caseId: row.case_id, communityId: row.community_id, channelId: row.channel_id, rumorId: row.rumor_id, author: row.author, action: "ban_member", discordGuildConfirmed: row.discord_guild_confirmed };
}
