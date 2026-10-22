import { publicationBlockers } from "./publicationRecovery";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { DeliveryState, DeliveryTarget, RoomTarget } from "./contracts";
import { EvidenceCipher } from "./evidence";
import { Lifecycle, lockLifecycleCase, lockLifecycleDecision } from "./lifecycle";
import type { LifecyclePolicyConfig } from "./apiReadiness";
import { reversalContext, validateReversalInput } from "./decisionReversals";
import { resolvedConcordReceipt } from "./concordDelivery";
import type { ReversalInput, ReversalContext } from "./lifecycleContracts";
import type { DiscordRestriction } from "./lifecycleContracts";
export type RoomAction = "remove_message" | "ban_member" | "unban_member";
export interface VerifiedCoopActor { orgId: string; actorId: string; permissions: string[] }
export interface SourceOrder { version: 1; revision: string }
export interface ModerationDecision { sourceOrder?: SourceOrder; caseId: string; executionId: string; action: RoomAction; reason: string; scope: "message" | "community"; discordGuildConfirmed: boolean }
/** `supersededBy` names the newer ban or unban for the same member that took
 * over this decision's undelivered targets (each reads failed /
 * superseded_by_newer_decision); null when nothing was superseded. */
export interface DecisionStatus { publicationBlockers?: Awaited<ReturnType<typeof publicationBlockers>>; auditAvailable?: boolean; discordRestriction?: DiscordRestriction; executionId: string; sourceOrder: SourceOrder | null; decisionId: string; target: RoomTarget; action: RoomAction; discordGuildConfirmed: boolean; supersededBy: string | null; deliveries: { target: DeliveryTarget; state: DeliveryState; attempts: number; resultCode: string | null }[] }
export interface StoredDecision { decisionId: string; orgId: string; caseId: string; target: RoomTarget; author: string; action: RoomAction; discordGuildConfirmed: boolean; expiresAt: Date }
export interface DeliveryClaim { decision: StoredDecision; target: DeliveryTarget; token: string; attempts: number; signedEvents: unknown[] | null; publicationEventIds?: string[] | null; publicationAttempted?: boolean; reconcileOnly?: boolean; publicationProofOnly?: boolean; claimedState?: DeliveryState }
/** Refusals staff can act on. The API returns `code` instead of the generic rejection. */
export type DecisionRefusal = "member_decision_superseded" | "member_intent_superseded" | "member_intent_order_conflict" | "member_intent_order_required" | "guild_scope_order_requires_operator" | "decision_source_unavailable";
export class DecisionRefusedError extends Error {
  constructor(readonly code: DecisionRefusal, message: string, readonly details: { executionId?: string; currentRevision?: string; supersededByExecutionId?: string } = {}) { super(message); }
}
const membership = (action: string) => action === "ban_member" || action === "unban_member";
// Bans and unbans for one member must take effect in the order staff decided
// them, and the newest one wins. Delivery alone cannot provide that: the outbox
// claims by available_at, and Concord prepares against the fold current at
// delivery, so an older decision backing off would land after a newer opposite
// one and win, with both rows reading verified. So a newer decision supersedes
// an older one's undelivered targets, and a newer target waits for an older one
// that is still in flight rather than racing it.
//
// "In flight" is a held lease (mid-send), or a Concord edition whose
// publication was attempted but not settled: the relay may already hold it, and
// a newer edition built beside it would fork the banlist at the same version,
// where the fold's tiebreak, not staff order, picks the winner. Such a row is
// read back to a result instead of superseded, and the newer one builds on top.
// A terminal retry/authority failure does not establish publication outcome.
// Keep its successor waiting for recovery even after expiry clears the bytes.
// NULL-safe on purpose: these are negated, and a NULL lease must read "not in flight".
const inFlight = (d: string) => `(((${d}.state IN ('pending', 'acknowledged')) AND COALESCE(${d}.lease_until > clock_timestamp(), false))
  OR (${d}.target = 'concord' AND ${d}.publication_attempted AND ${d}.state NOT IN ('verified', 'not_applicable')
    AND (${d}.signed_events IS NOT NULL OR ${d}.publication_event_ids IS NOT NULL OR COALESCE(${d}.result_code = 'concord_recovery_requires_operator', false))))`;
// Membership editions share one banlist head across every member and org
// mapping. Claim serialization below makes a committed lease/publication
// visible before another worker can select a different member's generation.
const sameCommunity = (other: string, c: string) => `${c}.action IN ('ban_member', 'unban_member') AND ${other}.action IN ('ban_member', 'unban_member')
  AND ${other}.community_id = ${c}.community_id AND ${other}.decision_id <> ${c}.decision_id`;
const sameMember = (other: string, c: string) => `${c}.action IN ('ban_member', 'unban_member') AND ${other}.action IN ('ban_member', 'unban_member')
  AND ${other}.org_id = ${c}.org_id AND ${other}.community_id = ${c}.community_id AND ${other}.author = ${c}.author`;
// Source revisions define intent order, regardless of HTTP acceptance time.
// All fenced decisions follow the legacy generation; legacy pairs retain their
// historical order. Explicit NULL branches keep uncertain legacy sends blocking.
const orderedAfter = (a: string, b: string) => `((${a}.source_revision IS NOT NULL AND ${b}.source_revision IS NULL)
  OR (${a}.source_revision IS NOT NULL AND ${b}.source_revision IS NOT NULL AND ${a}.source_revision > ${b}.source_revision)
  OR (${a}.source_revision IS NULL AND ${b}.source_revision IS NULL AND (${a}.created_at, ${a}.decision_id) > (${b}.created_at, ${b}.decision_id)))`;
const newerThan = (other: string, c: string) => `${sameMember(other, c)} AND ${orderedAfter(other, c)}`;
const olderThan = (other: string, c: string) => `${sameMember(other, c)} AND ${orderedAfter(c, other)}`;
// Community intent can replace community effects, but only another explicitly
// confirmed Guild action can replace a Guild effect. A no-op Discord row has
// no external effect to preserve or wait behind.
const newerForTarget = (other: string, c: string, d: string) => `${newerThan(other, c)}
  AND (${d}.target <> 'discord' OR NOT ${c}.discord_guild_confirmed OR ${other}.discord_guild_confirmed)`;
const olderForTarget = (other: string, c: string, d: string) => `${olderThan(other, c)}
  AND (${d}.target <> 'discord' OR (${c}.discord_guild_confirmed AND ${other}.discord_guild_confirmed))`;
const newerHead = (c: string, d?: string) => `${c}.action IN ('ban_member', 'unban_member') AND EXISTS (
  SELECT 1 FROM moderation.member_order_heads h WHERE h.org_id = ${c}.org_id AND h.community_id = ${c}.community_id AND h.author = ${c}.author
    AND (${d ? `CASE WHEN ${d}.target = 'discord' AND ${c}.discord_guild_confirmed THEN h.latest_guild_revision ELSE h.latest_revision END` : "h.latest_revision"} > COALESCE(${c}.source_revision, 0)))`;
const unknownGuildOrder = (c: string) => `${c}.action IN ('ban_member', 'unban_member') AND ${c}.discord_guild_confirmed
  AND (${c}.source_revision IS NULL OR EXISTS (SELECT 1 FROM moderation.member_order_heads h
    WHERE h.org_id = ${c}.org_id AND h.community_id = ${c}.community_id AND h.author = ${c}.author AND h.guild_scope_known_after > ${c}.source_revision
      AND (h.latest_guild_revision IS NULL OR h.latest_guild_revision <= ${c}.source_revision)))`;
const memberOrder = (alias: string) => `${alias}.source_revision NULLS FIRST, ${alias}.created_at, ${alias}.decision_id`;
// Pre-upgrade workers could leave two attempted community generations live.
// Their sends must not pass each other, but read-only reconciliation must not
// inherit that mutual wait. Missing proof still leaves both fences intact.
// A failed unban's own waiting relay leg also needs readback before expiry;
// no unrelated member decision should be required to discover its receipt.
const publicationRecovery = (d: string, c: string) => `${d}.target = 'concord' AND ${d}.publication_attempted
  AND (${d}.signed_events IS NOT NULL OR ${d}.publication_event_ids IS NOT NULL) AND ${c}.action IN ('ban_member', 'unban_member')
  AND ((${d}.state IN ('pending', 'acknowledged') AND EXISTS (SELECT 1 FROM moderation.decisions o JOIN moderation.deliveries od USING (decision_id)
    WHERE ${sameCommunity("o", c)} AND od.target = 'concord' AND ${inFlight("od")}))
  OR (${d}.state = 'failed' AND (${c}.expires_at <= clock_timestamp() OR ${c}.appeal_state = 'open'
    OR (${c}.action = 'unban_member' AND EXISTS (SELECT 1 FROM moderation.deliveries rd WHERE rd.decision_id = ${c}.decision_id AND rd.target = 'divine_relay' AND rd.state IN ('pending','acknowledged')))
    OR EXISTS (SELECT 1 FROM moderation.decisions n JOIN moderation.deliveries nd USING (decision_id)
    WHERE ${sameCommunity("n", c)} AND nd.target = 'concord' AND nd.state IN ('pending', 'acknowledged')
      AND n.expires_at > clock_timestamp() AND nd.available_at <= clock_timestamp()
      AND (nd.lease_until IS NULL OR nd.lease_until <= clock_timestamp())))))`;
// Relay unbans cannot execute before their own Concord outcome is proved.
// Waiting on another destination is not a delivery attempt: spending this
// budget while a community publication is fenced can strand a later unban.
// The SQL receipt states/codes must match settledConcordReceipt.
const relayAwaitingConcord = (d: string, c: string) => `${d}.target = 'divine_relay' AND ${c}.action = 'unban_member' AND NOT EXISTS (
  SELECT 1 FROM moderation.deliveries cd WHERE cd.decision_id = ${d}.decision_id AND cd.target = 'concord'
    AND (cd.state = 'verified' OR (cd.state = 'not_applicable' AND cd.result_code IN ('concord_publication_settled', 'concord_superseded_publication_settled'))))`;
// Acceptance and Retry serialize per member, so a Retry cannot restart a
// decision that a concurrently accepted newer one supersedes.
function lockMember(tx: postgres.TransactionSql, communityId: string, author: string) {
  return tx`SELECT pg_advisory_xact_lock(hashtextextended(${communityId + ":" + author}, 483216))`;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const actions = new Set(["remove_message", "ban_member", "unban_member"]);
function assertActor(actor: VerifiedCoopActor, permission?: string) {
  if (!actor.orgId || actor.orgId.length > 128 || !actor.actorId || actor.actorId.length > 128 || !Array.isArray(actor.permissions) || (permission && !actor.permissions.includes(permission))) throw new Error("Staff authorization required");
}
function stored(row: any): StoredDecision {
  return { decisionId: row.decision_id, orgId: row.org_id, caseId: row.case_id, target: { communityId: row.community_id, channelId: row.channel_id, rumorId: row.rumor_id }, author: row.author, action: row.action, discordGuildConfirmed: row.discord_guild_confirmed, expiresAt: row.expires_at };
}
export class Decisions {
  constructor(private readonly sql: postgres.Sql, private readonly cipher: EvidenceCipher | undefined, private readonly communities: ReadonlyMap<string, string>, policy: LifecyclePolicyConfig = {}, private readonly lifecycle = new Lifecycle(sql, cipher, communities, policy)) {}
  async acceptDecision(input: ModerationDecision, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    const cipher = this.cipher;
    if (!cipher) throw new Error("Decision acceptance disabled for this process");
    if (!input || Object.keys(input).filter((key) => key !== "sourceOrder").sort().join(",") !== "action,caseId,discordGuildConfirmed,executionId,reason,scope" || !uuid.test(input.caseId) || !uuid.test(input.executionId) || !actions.has(input.action) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2048 || typeof input.discordGuildConfirmed !== "boolean" || input.scope !== (input.action === "remove_message" ? "message" : "community")) throw new Error("Invalid decision or scope confirmation");
    assertActor(actor, input.action);
    if (input.discordGuildConfirmed) assertActor(actor, "discord_guild_ban");
    const order = input.sourceOrder;
    if ("sourceOrder" in input && (!order || !membership(input.action) || Object.keys(order).sort().join(",") !== "revision,version" || order.version !== 1 || typeof order.revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(order.revision) || BigInt(order.revision) > 9223372036854775807n)) throw new Error("Invalid source order");
    const fingerprintVersion = order ? 2 : 1;
    const fingerprintFields: (string | number | boolean)[] = [actor.orgId, actor.actorId, input.caseId, input.executionId, input.action, input.reason, input.scope, input.discordGuildConfirmed];
    if (order) fingerprintFields.push(order.version, order.revision);
    const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintFields)).digest("hex");
    const id = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.orgId + ":" + input.executionId}, 483213))`;
      const [prior] = await tx`SELECT decision_id, fingerprint, fingerprint_version FROM moderation.decisions WHERE org_id = ${actor.orgId} AND execution_id = ${input.executionId}`;
      if (prior) { if ((prior.fingerprint_version !== fingerprintVersion && !(input.action === "remove_message" && !order && prior.fingerprint_version === 2)) || prior.fingerprint !== fingerprint) throw new Error("Decision replay conflict"); return prior.decision_id as string; }
      this.lifecycle.requirePolicy();
      await lockLifecycleCase(tx, actor.orgId, input.caseId);
      if (membership(input.action) && !order) throw new DecisionRefusedError("member_intent_order_required", "Membership source order required", { executionId: input.executionId });
      const [evidence] = await tx`SELECT * FROM moderation.cases WHERE case_id = ${input.caseId} AND org_id = ${actor.orgId} AND expires_at > clock_timestamp() FOR UPDATE`;
      if (!evidence || this.communities.get(evidence.community_id) !== actor.orgId) throw new DecisionRefusedError("decision_source_unavailable", "Decision source unavailable", { executionId: input.executionId });
      return this.enqueueAcceptedDecision(tx, input, actor, evidence, fingerprint, fingerprintVersion);
    });
    return this.get(id, actor);
  }
  private async enqueueAcceptedDecision(tx: postgres.TransactionSql, input: ModerationDecision, actor: VerifiedCoopActor, evidence: any, fingerprint: string, fingerprintVersion: number, reversesDecisionId: string | null = null): Promise<string> {
      if (membership(input.action)) {
        await lockMember(tx, evidence.community_id, evidence.author);
        const order = input.sourceOrder;
        const [head] = await tx`SELECT latest_revision::text AS revision, latest_execution_id FROM moderation.member_order_heads
          WHERE org_id = ${actor.orgId} AND community_id = ${evidence.community_id} AND author = ${evidence.author} FOR UPDATE`;
        if (head && BigInt(order!.revision) <= BigInt(head.revision)) {
          throw new DecisionRefusedError(BigInt(order!.revision) < BigInt(head.revision) ? "member_intent_superseded" : "member_intent_order_conflict", "Membership source order refused",
            { executionId: input.executionId, currentRevision: head.revision, supersededByExecutionId: head.latest_execution_id });
        }
        await tx`INSERT INTO moderation.member_order_heads (org_id, community_id, author, latest_revision, latest_execution_id, latest_guild_revision)
          VALUES (${actor.orgId}, ${evidence.community_id}, ${evidence.author}, ${order!.revision}, ${input.executionId}, ${input.discordGuildConfirmed ? order!.revision : null})
          ON CONFLICT (org_id, community_id, author) DO UPDATE SET latest_revision = EXCLUDED.latest_revision, latest_execution_id = EXCLUDED.latest_execution_id,
            latest_guild_revision = COALESCE(EXCLUDED.latest_guild_revision, moderation.member_order_heads.latest_guild_revision)`;
      }
      const decisionId = crypto.randomUUID();
      const audit = this.cipher!.seal(`${actor.orgId}:${decisionId}`, { actorId: actor.actorId, reason: input.reason });
      await tx`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, audit, expires_at, fingerprint_version, source_order_version, source_revision, reverses_decision_id)
        VALUES (${decisionId}, ${actor.orgId}, ${input.executionId}, ${fingerprint}, ${input.caseId}, ${evidence.community_id}, ${evidence.channel_id}, ${evidence.rumor_id}, ${evidence.author}, ${input.action}, ${input.discordGuildConfirmed}, ${audit}, ${evidence.expires_at}, ${fingerprintVersion}, ${input.sourceOrder?.version ?? null}, ${input.sourceOrder?.revision ?? null}, ${reversesDecisionId})`;
      for (const target of ["divine_relay", "concord", "discord"]) await tx`INSERT INTO moderation.deliveries (decision_id, target) VALUES (${decisionId}, ${target})`;
      return decisionId;
  }
  async getReversalContext(decisionId: string, actor: VerifiedCoopActor): Promise<ReversalContext> {
    assertActor(actor, "unban_member");
    if (!uuid.test(decisionId)) throw new Error("Decision unavailable");
    const [row] = await this.sql`SELECT * FROM moderation.decisions WHERE org_id = ${actor.orgId} AND decision_id = ${decisionId}`;
    const deliveries = await this.sql`SELECT target, state, result_code FROM moderation.deliveries WHERE decision_id = ${decisionId}`;
    const context = reversalContext(row, deliveries, this.communities);
    if (!context) throw new Error("Decision unavailable");
    return context;
  }
  async acceptReversal(priorDecisionId: string, input: ReversalInput, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    validateReversalInput(input); assertActor(actor, "unban_member");
    if (!uuid.test(priorDecisionId)) throw new Error("Invalid prior decision");
    if (input.discordGuildConfirmed) assertActor(actor, "discord_guild_ban");
    if (!this.cipher) throw new Error("Decision acceptance disabled for this process");
    const fingerprint = createHash("sha256").update(JSON.stringify([actor.orgId, actor.actorId, priorDecisionId, input.executionId, input.action, input.reason, input.scope, input.discordGuildConfirmed, input.sourceOrder.version, input.sourceOrder.revision])).digest("hex");
    const id = await this.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.orgId + ":" + input.executionId}, 483213))`;
      const [accepted] = await tx`SELECT decision_id, fingerprint, fingerprint_version FROM moderation.decisions WHERE org_id = ${actor.orgId} AND execution_id = ${input.executionId}`;
      if (accepted) { if (accepted.fingerprint_version !== 3 || accepted.fingerprint !== fingerprint) throw new Error("Decision replay conflict"); return accepted.decision_id as string; }
      this.lifecycle.requirePolicy();
      const [scope] = await tx`SELECT case_id FROM moderation.decisions WHERE org_id = ${actor.orgId} AND decision_id = ${priorDecisionId}`;
      const unavailable = () => new DecisionRefusedError("decision_source_unavailable", "Decision source unavailable", { executionId: input.executionId });
      if (!scope) throw unavailable();
      const { decision, deliveries } = await lockLifecycleDecision(tx, actor.orgId, priorDecisionId);
      const context = reversalContext(decision, deliveries, this.communities);
      if (!context) throw unavailable();
      const source = { ...decision, expires_at: new Date(Date.now() + this.cipher!.retentionSeconds * 1000) };
      return this.enqueueAcceptedDecision(tx, { ...input, caseId: context.caseId }, actor, source, fingerprint, 3, priorDecisionId);
    });
    return this.get(id as string, actor);
  }
  async get(decisionId: string, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    assertActor(actor);
    if (!uuid.test(decisionId)) throw new Error("Decision unavailable");
    const [row] = await this.sql`SELECT * FROM moderation.decisions WHERE decision_id = ${decisionId} AND org_id = ${actor.orgId}`;
    if (!row || this.communities.get(row.community_id) !== actor.orgId || (!actor.permissions.includes("view") && !actor.permissions.includes(row.action))) throw new Error("Decision unavailable");
    const deliveries = await this.sql`SELECT target, state, attempts, result_code, superseded_by, discord_restriction_state, discord_restriction_checked_at, discord_restriction_code FROM moderation.deliveries WHERE decision_id = ${decisionId} ORDER BY target`;
    const supersededBy = deliveries.find((d) => d.superseded_by)?.superseded_by ?? null;
    return { publicationBlockers: membership(row.action) ? (await publicationBlockers(this.sql, row.community_id)).filter(blocker => blocker.orgId === actor.orgId) : [], auditAvailable: row.audit !== null, discordRestriction: (() => { const d = deliveries.find(d => d.target === "discord"); return { state: d?.discord_restriction_state ?? "unknown", checkedAt: d?.discord_restriction_checked_at?.toISOString() ?? null, code: d?.discord_restriction_code ?? "not_checked" }; })(), executionId: row.execution_id, sourceOrder: row.source_revision == null ? null : { version: 1, revision: String(row.source_revision) }, decisionId, target: stored(row).target, action: row.action, discordGuildConfirmed: row.discord_guild_confirmed, supersededBy, deliveries: deliveries.map((d) => ({ target: d.target as DeliveryTarget, state: d.state as DeliveryState, attempts: d.attempts, resultCode: d.result_code })) };
  }
  async getByExecution(executionId: string, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    assertActor(actor);
    if (!uuid.test(executionId)) throw new Error("Decision unavailable");
    const [row] = await this.sql`SELECT decision_id FROM moderation.decisions WHERE org_id = ${actor.orgId} AND execution_id = ${executionId}`;
    if (!row) throw new Error("Decision unavailable");
    return this.get(row.decision_id, actor);
  }
  async forCase(caseId: string, actor: VerifiedCoopActor): Promise<DecisionStatus[]> {
    assertActor(actor, "view");
    if (!uuid.test(caseId)) throw new Error("Invalid case");
    const rows = await this.sql`SELECT decision_id FROM moderation.decisions WHERE org_id = ${actor.orgId} AND case_id = ${caseId} ORDER BY created_at DESC LIMIT 100`;
    return Promise.all(rows.map((row) => this.get(row.decision_id, actor)));
  }
  async retry(decisionId: string, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    assertActor(actor, "retry");
    const status = await this.get(decisionId, actor);
    assertActor(actor, status.action);
    // A guild-scoped decision reaches the whole Discord server. Restarting that
    // delivery takes the same admin authority acceptance did, or a community
    // moderator could re-fire a guild ban they could never have requested. Without
    // it the retry still covers the community targets.
    const [scope] = await this.sql`SELECT discord_guild_confirmed, community_id, author FROM moderation.decisions WHERE decision_id = ${decisionId}`;
    const guildRetryAllowed = !scope?.discord_guild_confirmed || actor.permissions.includes("discord_guild_ban");
    const retried = await this.sql.begin(async (tx) => {
      const { decision } = await lockLifecycleDecision(tx, actor.orgId, decisionId);
      if (decision.lifecycle_closed_at) throw new Error("Lifecycle closed");
      if (membership(status.action)) {
        await lockMember(tx, scope.community_id, scope.author);
        // Restarting an older decision would undo the newer one for this member.
        const [newer] = await tx`SELECT 1 FROM moderation.decisions c
          WHERE c.decision_id = ${decisionId} AND (EXISTS (SELECT 1 FROM moderation.decisions n WHERE ${tx.unsafe(newerThan("n", "c"))}) OR ${tx.unsafe(newerHead("c"))}) LIMIT 1`;
        if (newer) {
          // This can only resume the exact attempted Concord generation while
          // its original authority/expiry and send budget still permit replay.
          // An independently surviving Guild target can also retry, with the
          // original Guild authority; this never restarts superseded community work.
          const recoverable = await tx`UPDATE moderation.deliveries d SET state = 'pending', available_at = clock_timestamp(), token = NULL, lease_until = NULL, updated_at = clock_timestamp()
            FROM moderation.decisions c WHERE c.decision_id = d.decision_id AND d.decision_id = ${decisionId} AND d.state = 'failed' AND d.attempts < 8
              AND d.result_code IS DISTINCT FROM 'concord_recovery_requires_operator' AND c.expires_at > clock_timestamp()
              AND ((d.target = 'concord' AND d.publication_attempted AND d.signed_events IS NOT NULL)
                OR (d.target = 'discord' AND c.discord_guild_confirmed AND ${guildRetryAllowed} AND NOT (${tx.unsafe(unknownGuildOrder("c"))})
                  AND NOT EXISTS (SELECT 1 FROM moderation.decisions n WHERE ${tx.unsafe(newerForTarget("n", "c", "d"))}) AND NOT (${tx.unsafe(newerHead("c", "d"))}))) RETURNING d.target`;
          if (recoverable.length) return recoverable;
          const [unknown] = await tx`SELECT 1 FROM moderation.decisions c WHERE c.decision_id = ${decisionId} AND ${tx.unsafe(unknownGuildOrder("c"))}`;
          if (unknown) throw new DecisionRefusedError("guild_scope_order_requires_operator", "Historical Guild intent requires reconciliation or a new staff decision");
          throw new DecisionRefusedError("member_decision_superseded", "A newer ban or unban for this member supersedes this decision");
        }
      }
      return tx`UPDATE moderation.deliveries d SET state = 'pending', available_at = clock_timestamp(), token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        FROM moderation.decisions c WHERE c.decision_id = d.decision_id AND d.decision_id = ${decisionId} AND d.state = 'failed' AND d.attempts < 8 AND (${guildRetryAllowed} OR d.target <> 'discord')
          AND d.result_code IS DISTINCT FROM 'concord_recovery_requires_operator'
          AND (d.target <> 'discord' OR NOT (${tx.unsafe(unknownGuildOrder("c"))})) AND c.expires_at > clock_timestamp() RETURNING d.target`;
    });
    if (!retried.length) {
      const [unknown] = await this.sql`SELECT 1 FROM moderation.decisions c WHERE c.decision_id = ${decisionId} AND ${this.sql.unsafe(unknownGuildOrder("c"))}`;
      if (unknown) throw new DecisionRefusedError("guild_scope_order_requires_operator", "Historical Guild intent requires reconciliation or a new staff decision");
      throw new Error("No retryable delivery; escalate expired or exhausted decisions");
    }
    return this.get(decisionId, actor);
  }
  async claim(): Promise<DeliveryClaim | undefined> {
    return this.sql.begin(async (tx) => {
      // Claiming is a short database-only transaction. Serializing its sweep
      // and lease write makes every later claimer observe either supersession
      // or the earlier lease, including a decision accepted between the sweep
      // and selection. The community execution lock alone cannot order claims
      // that have already committed. This lock is never taken by acceptance,
      // Retry or execution, so their member/community locks cannot invert it.
      await tx`SELECT pg_advisory_xact_lock(483217, 1)`;
      // Earlier maintenance acquisition wrote pending before it completed.
      // Once that abandoned lease passes, its operator marker still owns the
      // disposition; do not reinterpret an interrupted recovery as a retry.
      await tx`UPDATE moderation.deliveries SET state = 'failed', token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        WHERE target = 'concord' AND state IN ('pending','acknowledged') AND result_code = 'concord_recovery_requires_operator'
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())`;
      await tx`UPDATE moderation.deliveries SET state = 'failed', result_code = 'retry_budget_exhausted', token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        WHERE state IN ('pending', 'acknowledged') AND attempts >= 8 AND (lease_until IS NULL OR lease_until <= clock_timestamp())`;
      // The superseded decision keeps its record; its unsent signed bytes have
      // no further use. superseded_by is the next decision accepted for the
      // member, so the chain reads in staff order whenever this sweep runs.
      await tx`UPDATE moderation.deliveries d SET state = 'failed', result_code = 'superseded_by_newer_decision', signed_events = NULL, token = NULL, lease_until = NULL, updated_at = clock_timestamp(),
          superseded_by = (SELECT n.decision_id FROM moderation.decisions n WHERE ${tx.unsafe(newerForTarget("n", "c", "d"))} ORDER BY ${tx.unsafe(memberOrder("n"))} LIMIT 1)
        FROM moderation.decisions c
        WHERE c.decision_id = d.decision_id AND d.state IN ('pending', 'acknowledged') AND NOT ${tx.unsafe(inFlight("d"))}
          AND (EXISTS (SELECT 1 FROM moderation.decisions n WHERE ${tx.unsafe(newerForTarget("n", "c", "d"))}) OR ${tx.unsafe(newerHead("c", "d"))})`;
      // An old global head cannot reveal a pruned decision's Guild scope.
      // Preserve that uncertainty explicitly rather than cancel or send old intent.
      await tx`UPDATE moderation.deliveries d SET state = 'failed', result_code = 'guild_scope_order_requires_operator', token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        FROM moderation.decisions c WHERE c.decision_id = d.decision_id AND d.target = 'discord' AND d.state IN ('pending', 'acknowledged')
          AND NOT ${tx.unsafe(inFlight("d"))} AND ${tx.unsafe(unknownGuildOrder("c"))}`;
      await tx`UPDATE moderation.deliveries d SET result_code = 'concord_waiting_on_prior_publication'
        FROM moderation.decisions c WHERE c.decision_id = d.decision_id AND d.target = 'concord' AND d.state = 'pending'
          AND d.result_code IS NULL AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM moderation.decisions o JOIN moderation.deliveries od USING (decision_id)
            WHERE ${tx.unsafe(sameCommunity("o", "c"))} AND od.target = 'concord' AND ${tx.unsafe(inFlight("od"))})`;
      await tx`UPDATE moderation.deliveries d SET result_code = 'relay_awaiting_concord_state'
        FROM moderation.decisions c WHERE c.decision_id = d.decision_id AND d.state IN ('pending', 'acknowledged')
          AND d.result_code IS NULL AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
          AND ${tx.unsafe(relayAwaitingConcord("d", "c"))}`;
      // Concord sends wait across members while the shared generation is
      // unsettled. Read-only receipts may still resolve that uncertainty.
      // Other destinations retain their own membership/Guild ordering.
      // A membership target waits, without spending attempts, while an older
      // decision's same target is in flight. An older row that a newer decision
      // committed just after the sweep may still be claimed here; it is then the
      // one in flight, and the newer target applies on top once it completes.
      const [job] = await tx`SELECT d.*, (${tx.unsafe(publicationRecovery("d", "c"))}) AS reconcile_only, NOT EXISTS (SELECT 1 FROM moderation.decisions n WHERE ${tx.unsafe(newerThan("n", "c"))}) AS proof_only FROM moderation.deliveries d JOIN moderation.decisions c USING (decision_id)
        WHERE ((d.state IN ('pending', 'acknowledged') AND d.attempts < 8 AND c.expires_at > clock_timestamp()) OR (${tx.unsafe(publicationRecovery("d", "c"))}))
          AND d.available_at <= clock_timestamp() AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
          AND NOT (${tx.unsafe(relayAwaitingConcord("d", "c"))})
          AND ((${tx.unsafe(publicationRecovery("d", "c"))}) OR d.target <> 'concord' OR NOT EXISTS (
            SELECT 1 FROM moderation.decisions o JOIN moderation.deliveries od USING (decision_id)
              WHERE ${tx.unsafe(sameCommunity("o", "c"))} AND od.target = 'concord' AND ${tx.unsafe(inFlight("od"))}))
          AND NOT EXISTS (SELECT 1 FROM moderation.decisions o JOIN moderation.deliveries od USING (decision_id)
            WHERE ${tx.unsafe(olderForTarget("o", "c", "d"))} AND od.target = d.target AND ${tx.unsafe(inFlight("od"))})
        ORDER BY d.available_at, d.decision_id, d.target FOR UPDATE OF d SKIP LOCKED LIMIT 1`;
      if (!job) return undefined;
      const token = crypto.randomUUID();
      await tx`UPDATE moderation.deliveries SET token = ${token}, attempts = attempts + ${job.reconcile_only ? 0 : 1}, lease_until = clock_timestamp() + interval '60 seconds', updated_at = clock_timestamp(),
        result_code = CASE WHEN result_code IN ('concord_waiting_on_prior_publication', 'relay_awaiting_concord_state') THEN NULL ELSE result_code END
        WHERE decision_id = ${job.decision_id} AND target = ${job.target}`;
      const [row] = await tx`SELECT * FROM moderation.decisions WHERE decision_id = ${job.decision_id}`;
      return { decision: stored(row), target: job.target as DeliveryTarget, token, attempts: job.attempts + (job.reconcile_only ? 0 : 1), signedEvents: job.signed_events, publicationEventIds: job.publication_event_ids, publicationAttempted: job.publication_attempted, reconcileOnly: Boolean(job.reconcile_only), publicationProofOnly: Boolean(job.reconcile_only && job.proof_only), claimedState: job.state as DeliveryState };
    });
  }
  async defer(claim: DeliveryClaim): Promise<void> {
    // Contention is not a failed observation. Upgrade readback can start from
    // pending/acknowledged as well as failed; keep its eligibility unchanged
    // until the worker actually gets the execution lock and observes proof.
    const rows = await this.sql`UPDATE moderation.deliveries SET state = ${claim.reconcileOnly ? claim.claimedState ?? "failed" : "pending"}, attempts = attempts - ${claim.reconcileOnly ? 0 : 1}, token = NULL, lease_until = NULL, available_at = clock_timestamp() + interval '1 second'
      WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target} AND token = ${claim.token} AND lease_until > clock_timestamp() RETURNING target`;
    if (!rows.length) throw new Error("Delivery lease lost");
  }
  async renew(claim: DeliveryClaim): Promise<void> {
    const rows = await this.sql`UPDATE moderation.deliveries SET lease_until = clock_timestamp() + interval '60 seconds' WHERE decision_id = ${claim.decision.decisionId}
      AND target = ${claim.target} AND token = ${claim.token} AND lease_until > clock_timestamp() RETURNING token`;
    if (!rows.length) throw new Error("Delivery lease lost");
  }
  async saveEvents(claim: DeliveryClaim, events: unknown[]): Promise<unknown[]> {
    const rows = await this.sql`UPDATE moderation.deliveries SET signed_events = COALESCE(signed_events, ${this.sql.json(events as never)}),
      publication_attempted = CASE WHEN signed_events IS NULL THEN false ELSE publication_attempted END
      WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target} AND token = ${claim.token} AND lease_until > clock_timestamp()
        AND NOT (signed_events IS NULL AND publication_event_ids IS NOT NULL) RETURNING signed_events, publication_attempted, publication_event_ids`;
    if (!rows.length) throw new Error("Delivery lease lost");
    claim.signedEvents = rows[0].signed_events;
    claim.publicationAttempted = rows[0].publication_attempted;
    claim.publicationEventIds = rows[0].publication_event_ids;
    return rows[0].signed_events;
  }
  async replaceUnattemptedEvents(claim: DeliveryClaim, previous: unknown[], events: unknown[]): Promise<unknown[]> {
    // Only the exact generation proved never sent may be replaced. A stale
    // lease or a publisher that won this CAS must leave its signed bytes intact.
    const rows = await this.sql`UPDATE moderation.deliveries SET signed_events = ${this.sql.json(events as never)}, publication_event_ids = NULL, updated_at = clock_timestamp()
      WHERE decision_id = ${claim.decision.decisionId} AND target = 'concord' AND target = ${claim.target}
        AND token = ${claim.token} AND lease_until > clock_timestamp() AND publication_attempted = false
        AND signed_events = ${this.sql.json(previous as never)} RETURNING signed_events`;
    if (!rows.length) throw new Error("Delivery lease or unattempted generation lost");
    claim.signedEvents = rows[0].signed_events;
    claim.publicationAttempted = false;
    claim.publicationEventIds = null;
    return rows[0].signed_events;
  }
  async markPublicationAttempted(claim: DeliveryClaim, events: unknown[], metadata?: import("./concordActions").PublicationMetadata): Promise<void> {
    // Commit this BEFORE network I/O: a crash or timeout is not proof that a
    // relay did not receive the edition. Such generations remain replay-only.
    const member = membership(claim.decision.action);
    const id = (events[0] as { id?: unknown } | undefined)?.id;
    if (member && (events.length !== 1 || typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id))) throw new Error("Invalid publication identity");
    const ids = member ? [id as string] : null;
    const rows = await this.sql`UPDATE moderation.deliveries SET publication_attempted = true, publication_event_ids = ${ids}, publication_metadata = COALESCE(publication_metadata, ${metadata ? this.sql.json({ ...metadata }) : null}), updated_at = clock_timestamp()
      WHERE decision_id = ${claim.decision.decisionId} AND target = 'concord' AND target = ${claim.target}
        AND token = ${claim.token} AND lease_until > clock_timestamp()
        AND signed_events = ${this.sql.json(events as never)} RETURNING target`;
    if (!rows.length) throw new Error("Delivery lease or generation lost");
    claim.publicationAttempted = true;
    claim.publicationEventIds = ids;
  }
  async complete(claim: DeliveryClaim, state: DeliveryState, resultCode: string, retryAfterSeconds = 0, connection: postgres.Sql | postgres.TransactionSql = this.sql): Promise<void> {
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0 || !/^[a-z_]{1,64}$/.test(resultCode)) throw new Error("Invalid delivery result code");
    // An inconclusive upgrade readback is not cancellation of the original
    // retryable send. Retain its state so the next observation remains due
    // while its peer is unsettled, or normal guarded retry can resume later.
    if (claim.reconcileOnly && state === "failed" && resultCode === "concord_recovery_awaiting_proof" && (claim.claimedState === "pending" || claim.claimedState === "acknowledged")) state = claim.claimedState;
    if (claim.attempts >= 8 && (state === "pending" || state === "acknowledged")) { state = "failed"; resultCode = "retry_budget_exhausted"; }
    // Failed observation cannot downgrade an operator-only outcome into a
    // Retry-able transport failure. Only the worker's proved resolution clears
    // it; preserve both marker and terminal state in this lease-fenced write.
    // Ordinary marked rows only observe proof. Explicit maintenance recovery
    // can also verify an exact replay; neither path may clear the marker on a
    // transport/ownership failure or an unproved not-applicable outcome.
    const resolvedConcord = (state === "verified" && resultCode === "concord_enforcement_verified") ||
      resolvedConcordReceipt(state, resultCode);
    const rows = await connection`UPDATE moderation.deliveries SET
      state = CASE WHEN target = 'concord' AND result_code = 'concord_recovery_requires_operator' AND NOT ${resolvedConcord} THEN 'failed' ELSE ${state} END,
      result_code = CASE WHEN target = 'concord' AND result_code = 'concord_recovery_requires_operator' AND NOT ${resolvedConcord} THEN result_code ELSE ${resultCode} END,
      lease_until = NULL, token = NULL, updated_at = clock_timestamp(),
      available_at = clock_timestamp() + (${Math.max(retryAfterSeconds, Math.min(300, 2 ** claim.attempts))} * interval '1 second')
      WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target} AND token = ${claim.token} AND lease_until > clock_timestamp() RETURNING target`;
    if (!rows.length) throw new Error("Delivery lease lost");
  }
  async refreshDiscordRestriction(decisionId: string, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    await this.get(decisionId, actor);
    await this.sql.begin(async tx => {
      await lockLifecycleDecision(tx, actor.orgId, decisionId);
      // Observation only. For an unsettled delivery available_at is the send
      // schedule: moving it up would let any viewing staff member cancel a
      // Discord Retry-After or backoff and spend the send budget. Such a row
      // needs no refresh anyway: its next completion moves available_at past
      // the last check, which already makes the observer due again.
      await tx`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${decisionId} AND target = 'discord'
        AND state NOT IN ('pending', 'acknowledged') AND (lease_until IS NULL OR lease_until <= clock_timestamp())`;
    });
    return this.get(decisionId, actor);
  }
  async refreshPublicationProof(decisionId: string, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    await this.get(decisionId, actor);
    await this.sql.begin(async tx => {
      const { decision } = await lockLifecycleDecision(tx, actor.orgId, decisionId);
      if (this.communities.get(decision.community_id) !== actor.orgId) throw new Error("Decision unavailable");
      // Wake the existing operator-owned readback path without changing state,
      // consuming a send attempt, disturbing a lease or reopening Retry.
      // Pending upgrade reads keep the original send schedule: advancing it
      // here could accelerate a normal resend if its peer settled meanwhile.
      await tx`UPDATE moderation.deliveries d SET available_at = clock_timestamp() FROM moderation.decisions c
        WHERE c.decision_id = d.decision_id AND d.decision_id = ${decisionId} AND d.state = 'failed' AND (${tx.unsafe(publicationRecovery("d", "c"))})
          AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())`;
    });
    return this.get(decisionId, actor);
  }
  async expire(): Promise<void> {
    // Decisions are never deleted, so every expired one would otherwise be
    // re-locked on every worker pass forever. Select only those with a row one
    // of the two UPDATEs below still changes: the predicate is theirs, exactly
    // (an unsettled delivery, or retained signed bytes), and both clear it, so
    // a processed decision drops out and the bounded batch always advances.
    // Widen this if either UPDATE's WHERE ever widens, or expiry silently stops.
    const rows = await this.sql`SELECT c.org_id, c.decision_id FROM moderation.decisions c WHERE c.expires_at <= clock_timestamp()
        AND EXISTS (SELECT 1 FROM moderation.deliveries d WHERE d.decision_id = c.decision_id AND (d.state IN ('pending', 'acknowledged') OR d.signed_events IS NOT NULL))
      ORDER BY c.org_id, c.case_id, c.decision_id LIMIT 100`;
    for (const row of rows) await this.sql.begin(async (tx) => {
      await lockLifecycleDecision(tx, row.org_id, row.decision_id);
      await tx`UPDATE moderation.deliveries SET state = 'failed',
        result_code = CASE WHEN target = 'concord' AND (signed_events IS NOT NULL OR publication_event_ids IS NOT NULL) AND publication_attempted
          AND decision_id IN (SELECT decision_id FROM moderation.decisions WHERE action IN ('ban_member', 'unban_member'))
          THEN 'concord_recovery_requires_operator' ELSE 'decision_expired' END,
        signed_events = NULL, token = NULL, lease_until = NULL
        WHERE decision_id = ${row.decision_id} AND state IN ('pending', 'acknowledged')`;
      // Terminal delivery state does not extend the byte lifetime. A legacy
      // attempted generation without IDs still needs an explicit unknown marker
      // after erasure, or its successor could incorrectly infer no publication.
      await tx`UPDATE moderation.deliveries SET signed_events = NULL,
        result_code = CASE WHEN target = 'concord' AND publication_attempted AND publication_event_ids IS NULL
          AND state NOT IN ('verified', 'not_applicable')
          AND decision_id IN (SELECT decision_id FROM moderation.decisions WHERE action IN ('ban_member', 'unban_member'))
          THEN 'concord_recovery_requires_operator' ELSE result_code END
        WHERE decision_id = ${row.decision_id} AND signed_events IS NOT NULL`;
    });
  }
}
