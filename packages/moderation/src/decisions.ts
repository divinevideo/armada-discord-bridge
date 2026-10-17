import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { DeliveryState, DeliveryTarget, RoomTarget } from "./contracts";
import { EvidenceCipher } from "./evidence";
export type RoomAction = "remove_message" | "ban_member" | "unban_member";
export interface VerifiedCoopActor { orgId: string; actorId: string; permissions: string[] }
export interface ModerationDecision { caseId: string; executionId: string; action: RoomAction; reason: string; scope: "message" | "community"; discordGuildConfirmed: boolean }
/** `supersededBy` names the newer ban or unban for the same member that took
 * over this decision's undelivered targets (each reads failed /
 * superseded_by_newer_decision); null when nothing was superseded. */
export interface DecisionStatus { decisionId: string; target: RoomTarget; action: RoomAction; discordGuildConfirmed: boolean; supersededBy: string | null; deliveries: { target: DeliveryTarget; state: DeliveryState; attempts: number; resultCode: string | null }[] }
export interface StoredDecision { decisionId: string; orgId: string; caseId: string; target: RoomTarget; author: string; action: RoomAction; discordGuildConfirmed: boolean; expiresAt: Date }
export interface DeliveryClaim { decision: StoredDecision; target: DeliveryTarget; token: string; attempts: number; signedEvents: unknown[] | null; publicationAttempted?: boolean }
/** Refusals staff can act on. The API returns `code` instead of the generic rejection. */
export type DecisionRefusal = "member_decision_superseded";
export class DecisionRefusedError extends Error {
  constructor(readonly code: DecisionRefusal, message: string) { super(message); }
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
    AND (${d}.signed_events IS NOT NULL OR COALESCE(${d}.result_code = 'concord_recovery_requires_operator', false))))`;
const sameMember = (other: string, c: string) => `${c}.action IN ('ban_member', 'unban_member') AND ${other}.action IN ('ban_member', 'unban_member')
  AND ${other}.community_id = ${c}.community_id AND ${other}.author = ${c}.author`;
// Acceptance order is (created_at, decision_id). The member lock below makes it
// the commit order too: created_at is stamped after the lock is held.
const newerThan = (other: string, c: string) => `${sameMember(other, c)} AND (${other}.created_at, ${other}.decision_id) > (${c}.created_at, ${c}.decision_id)`;
const olderThan = (other: string, c: string) => `${sameMember(other, c)} AND (${other}.created_at, ${other}.decision_id) < (${c}.created_at, ${c}.decision_id)`;
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
  constructor(private readonly sql: postgres.Sql, private readonly cipher: EvidenceCipher | undefined, private readonly communities: ReadonlyMap<string, string>) {}
  async acceptDecision(input: ModerationDecision, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    const cipher = this.cipher;
    if (!cipher) throw new Error("Decision acceptance disabled for this process");
    if (!input || Object.keys(input).sort().join(",") !== "action,caseId,discordGuildConfirmed,executionId,reason,scope" || !uuid.test(input.caseId) || !uuid.test(input.executionId) || !actions.has(input.action) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2048 || typeof input.discordGuildConfirmed !== "boolean" || input.scope !== (input.action === "remove_message" ? "message" : "community")) throw new Error("Invalid decision or scope confirmation");
    assertActor(actor, input.action);
    if (input.discordGuildConfirmed) assertActor(actor, "discord_guild_ban");
    const fingerprint = createHash("sha256").update(JSON.stringify([actor.orgId, actor.actorId, input.caseId, input.executionId, input.action, input.reason, input.scope, input.discordGuildConfirmed])).digest("hex");
    const id = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.orgId + ":" + input.executionId}, 483213))`;
      const [prior] = await tx`SELECT decision_id, fingerprint FROM moderation.decisions WHERE org_id = ${actor.orgId} AND execution_id = ${input.executionId}`;
      if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("Decision replay conflict"); return prior.decision_id as string; }
      const [evidence] = await tx`SELECT * FROM moderation.cases WHERE case_id = ${input.caseId} AND org_id = ${actor.orgId} AND expires_at > clock_timestamp() FOR SHARE`;
      if (!evidence || this.communities.get(evidence.community_id) !== actor.orgId) throw new Error("Case unavailable");
      // Never refused for an earlier decision: superseding it happens in the outbox.
      if (membership(input.action)) await lockMember(tx, evidence.community_id, evidence.author);
      const decisionId = crypto.randomUUID();
      const audit = cipher.seal(`${actor.orgId}:${decisionId}`, { actorId: actor.actorId, reason: input.reason });
      await tx`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, audit, expires_at)
        VALUES (${decisionId}, ${actor.orgId}, ${input.executionId}, ${fingerprint}, ${input.caseId}, ${evidence.community_id}, ${evidence.channel_id}, ${evidence.rumor_id}, ${evidence.author}, ${input.action}, ${input.discordGuildConfirmed}, ${audit}, ${evidence.expires_at})`;
      for (const target of ["divine_relay", "concord", "discord"]) await tx`INSERT INTO moderation.deliveries (decision_id, target) VALUES (${decisionId}, ${target})`;
      return decisionId;
    });
    return this.get(id, actor);
  }
  async get(decisionId: string, actor: VerifiedCoopActor): Promise<DecisionStatus> {
    assertActor(actor);
    if (!uuid.test(decisionId)) throw new Error("Decision unavailable");
    const [row] = await this.sql`SELECT * FROM moderation.decisions WHERE decision_id = ${decisionId} AND org_id = ${actor.orgId}`;
    if (!row || this.communities.get(row.community_id) !== actor.orgId || (!actor.permissions.includes("view") && !actor.permissions.includes(row.action))) throw new Error("Decision unavailable");
    const deliveries = await this.sql`SELECT target, state, attempts, result_code, superseded_by FROM moderation.deliveries WHERE decision_id = ${decisionId} ORDER BY target`;
    const supersededBy = deliveries.find((d) => d.superseded_by)?.superseded_by ?? null;
    return { decisionId, target: stored(row).target, action: row.action, discordGuildConfirmed: row.discord_guild_confirmed, supersededBy, deliveries: deliveries.map((d) => ({ target: d.target as DeliveryTarget, state: d.state as DeliveryState, attempts: d.attempts, resultCode: d.result_code })) };
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
      if (membership(status.action)) {
        await lockMember(tx, scope.community_id, scope.author);
        // Restarting an older decision would undo the newer one for this member.
        const [newer] = await tx`SELECT 1 FROM moderation.decisions c, moderation.decisions n
          WHERE c.decision_id = ${decisionId} AND ${tx.unsafe(newerThan("n", "c"))} LIMIT 1`;
        if (newer) throw new DecisionRefusedError("member_decision_superseded", "A newer ban or unban for this member supersedes this decision");
      }
      return tx`UPDATE moderation.deliveries SET state = 'pending', available_at = clock_timestamp(), token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        WHERE decision_id = ${decisionId} AND state = 'failed' AND attempts < 8 AND (${guildRetryAllowed} OR target <> 'discord')
          AND result_code IS DISTINCT FROM 'concord_recovery_requires_operator'
          AND decision_id IN (SELECT decision_id FROM moderation.decisions WHERE expires_at > clock_timestamp()) RETURNING target`;
    });
    if (!retried.length) throw new Error("No retryable delivery; escalate expired or exhausted decisions");
    return this.get(decisionId, actor);
  }
  async claim(): Promise<DeliveryClaim | undefined> {
    await this.sql`UPDATE moderation.deliveries SET state = 'failed', result_code = 'retry_budget_exhausted', token = NULL, lease_until = NULL, updated_at = clock_timestamp()
      WHERE state IN ('pending', 'acknowledged') AND attempts >= 8 AND (lease_until IS NULL OR lease_until <= clock_timestamp())`;
    // The superseded decision keeps its record; its unsent signed bytes have
    // no further use. superseded_by is the next decision accepted for the
    // member, so the chain reads in staff order whenever this sweep runs.
    await this.sql`UPDATE moderation.deliveries d SET state = 'failed', result_code = 'superseded_by_newer_decision', signed_events = NULL, token = NULL, lease_until = NULL, updated_at = clock_timestamp(),
        superseded_by = (SELECT n.decision_id FROM moderation.decisions n WHERE ${this.sql.unsafe(newerThan("n", "c"))} ORDER BY n.created_at, n.decision_id LIMIT 1)
      FROM moderation.decisions c
      WHERE c.decision_id = d.decision_id AND d.state IN ('pending', 'acknowledged') AND NOT ${this.sql.unsafe(inFlight("d"))}
        AND EXISTS (SELECT 1 FROM moderation.decisions n WHERE ${this.sql.unsafe(newerThan("n", "c"))})`;
    return this.sql.begin(async (tx) => {
      // A membership target waits, without spending attempts, while an older
      // decision's same target is in flight. An older row that a newer decision
      // committed just after the sweep may still be claimed here; it is then the
      // one in flight, and the newer target applies on top once it completes.
      // Execution is serialized per community (ModerationWorker), so a claim
      // that loses that lock defers and meets this check again.
      const [job] = await tx`SELECT d.* FROM moderation.deliveries d JOIN moderation.decisions c USING (decision_id)
        WHERE d.state IN ('pending', 'acknowledged') AND d.available_at <= clock_timestamp() AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
          AND d.attempts < 8 AND c.expires_at > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM moderation.decisions o JOIN moderation.deliveries od USING (decision_id)
            WHERE ${tx.unsafe(olderThan("o", "c"))} AND od.target = d.target AND ${tx.unsafe(inFlight("od"))})
        ORDER BY d.available_at, d.decision_id, d.target FOR UPDATE OF d SKIP LOCKED LIMIT 1`;
      if (!job) return undefined;
      const token = crypto.randomUUID();
      await tx`UPDATE moderation.deliveries SET token = ${token}, attempts = attempts + 1, lease_until = clock_timestamp() + interval '60 seconds', updated_at = clock_timestamp()
        WHERE decision_id = ${job.decision_id} AND target = ${job.target}`;
      const [row] = await tx`SELECT * FROM moderation.decisions WHERE decision_id = ${job.decision_id}`;
      return { decision: stored(row), target: job.target as DeliveryTarget, token, attempts: job.attempts + 1, signedEvents: job.signed_events, publicationAttempted: job.publication_attempted };
    });
  }
  async defer(claim: DeliveryClaim): Promise<void> {
    const rows = await this.sql`UPDATE moderation.deliveries SET state = 'pending', attempts = attempts - 1, token = NULL, lease_until = NULL, available_at = clock_timestamp() + interval '1 second'
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
      WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target} AND token = ${claim.token} AND lease_until > clock_timestamp() RETURNING signed_events, publication_attempted`;
    if (!rows.length) throw new Error("Delivery lease lost");
    claim.signedEvents = rows[0].signed_events;
    claim.publicationAttempted = rows[0].publication_attempted;
    return rows[0].signed_events;
  }
  async replaceUnattemptedEvents(claim: DeliveryClaim, previous: unknown[], events: unknown[]): Promise<unknown[]> {
    // Only the exact generation proved never sent may be replaced. A stale
    // lease or a publisher that won this CAS must leave its signed bytes intact.
    const rows = await this.sql`UPDATE moderation.deliveries SET signed_events = ${this.sql.json(events as never)}, updated_at = clock_timestamp()
      WHERE decision_id = ${claim.decision.decisionId} AND target = 'concord' AND target = ${claim.target}
        AND token = ${claim.token} AND lease_until > clock_timestamp() AND publication_attempted = false
        AND signed_events = ${this.sql.json(previous as never)} RETURNING signed_events`;
    if (!rows.length) throw new Error("Delivery lease or unattempted generation lost");
    claim.signedEvents = rows[0].signed_events;
    claim.publicationAttempted = false;
    return rows[0].signed_events;
  }
  async markPublicationAttempted(claim: DeliveryClaim, events: unknown[]): Promise<void> {
    // Commit this BEFORE network I/O: a crash or timeout is not proof that a
    // relay did not receive the edition. Such generations remain replay-only.
    const rows = await this.sql`UPDATE moderation.deliveries SET publication_attempted = true, updated_at = clock_timestamp()
      WHERE decision_id = ${claim.decision.decisionId} AND target = 'concord' AND target = ${claim.target}
        AND token = ${claim.token} AND lease_until > clock_timestamp()
        AND signed_events = ${this.sql.json(events as never)} RETURNING target`;
    if (!rows.length) throw new Error("Delivery lease or generation lost");
    claim.publicationAttempted = true;
  }
  async complete(claim: DeliveryClaim, state: DeliveryState, resultCode: string, retryAfterSeconds = 0): Promise<void> {
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0 || !/^[a-z_]{1,64}$/.test(resultCode)) throw new Error("Invalid delivery result code");
    if (claim.attempts >= 8 && (state === "pending" || state === "acknowledged")) { state = "failed"; resultCode = "retry_budget_exhausted"; }
    const rows = await this.sql`UPDATE moderation.deliveries SET state = ${state}, result_code = ${resultCode}, lease_until = NULL, token = NULL, updated_at = clock_timestamp(),
      available_at = clock_timestamp() + (${Math.max(retryAfterSeconds, Math.min(300, 2 ** claim.attempts))} * interval '1 second')
      WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target} AND token = ${claim.token} AND lease_until > clock_timestamp() RETURNING target`;
    if (!rows.length) throw new Error("Delivery lease lost");
  }
  async expire(): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`UPDATE moderation.deliveries SET state = 'failed',
        result_code = CASE WHEN target = 'concord' AND signed_events IS NOT NULL AND publication_attempted
          AND decision_id IN (SELECT decision_id FROM moderation.decisions WHERE action IN ('ban_member', 'unban_member'))
          THEN 'concord_recovery_requires_operator' ELSE 'decision_expired' END,
        signed_events = NULL, token = NULL, lease_until = NULL
        WHERE decision_id IN (SELECT decision_id FROM moderation.decisions WHERE expires_at <= clock_timestamp()) AND state IN ('pending', 'acknowledged')`;
      await tx`UPDATE moderation.decisions SET audit = NULL WHERE expires_at <= clock_timestamp() AND audit IS NOT NULL`;
    });
  }
}
