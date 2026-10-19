import type postgres from "postgres";
import type { VerifiedCoopActor } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { requireLifecyclePolicy, type LifecyclePolicyConfig } from "./apiReadiness";
import type { HoldStatus, LifecycleStatus } from "./lifecycleContracts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Case identity survives evidence expiry, and precedes member/decision locks. */
export async function lifecycleCaseBoundary(tx: postgres.TransactionSql, org: string, caseId: string) {
  if (!uuid.test(caseId)) throw new Error("Invalid lifecycle case identity");
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([org, caseId])}, 483217))`;
}
export async function lockLifecycleCase(tx: postgres.TransactionSql, org: string, caseId: string) {
  await lifecycleCaseBoundary(tx, org, caseId);
  const [row] = await tx`SELECT * FROM moderation.cases WHERE org_id = ${org} AND case_id = ${caseId} FOR UPDATE`;
  return row;
}
export async function lockLifecycleDecision(tx: postgres.TransactionSql, org: string, decisionId: string) {
  const [scope] = await tx`SELECT case_id, community_id, author FROM moderation.decisions WHERE org_id = ${org} AND decision_id = ${decisionId}`;
  if (!scope) throw new Error("Decision unavailable");
  const evidence = await lockLifecycleCase(tx, org, scope.case_id);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.community_id + ":" + scope.author}, 483216))`;
  const [decision] = await tx`SELECT * FROM moderation.decisions WHERE org_id = ${org} AND decision_id = ${decisionId} FOR UPDATE`;
  const deliveries = await tx`SELECT * FROM moderation.deliveries WHERE decision_id = ${decisionId} ORDER BY target FOR UPDATE`;
  return { decision, evidence, deliveries };
}
/** The caller already owns the case boundary. Existing targets are locked in
 * stable order before evidence/audit deletion; no execution lock is acquired. */
async function lockCaseRecords(tx: postgres.TransactionSql, org: string, caseId: string) {
  const members = await tx`SELECT DISTINCT community_id, author FROM moderation.decisions WHERE org_id = ${org} AND case_id = ${caseId} ORDER BY community_id, author`;
  for (const member of members) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${member.community_id + ":" + member.author}, 483216))`;
  const decisions = await tx`SELECT decision_id FROM moderation.decisions WHERE org_id = ${org} AND case_id = ${caseId} ORDER BY decision_id FOR UPDATE`;
  for (const decision of decisions) await tx`SELECT target FROM moderation.deliveries WHERE decision_id = ${decision.decision_id} ORDER BY target FOR UPDATE`;
}
const holdStatus = (r: any): HoldStatus => ({ holdId: r.hold_id, caseId: r.case_id, holdUntil: r.hold_until.toISOString(), releasedAt: r.released_at?.toISOString() ?? null });
const status = (r: any): LifecycleStatus => ({ decisionId: r.decision_id, appealState: r.appeal_state, closedAt: r.lifecycle_closed_at?.toISOString() ?? null, auditDeleteAfter: r.audit_delete_after?.toISOString() ?? null, auditAvailable: r.audit !== null });
export class Lifecycle {
  constructor(private readonly sql: postgres.Sql, private readonly cipher: EvidenceCipher | undefined, private readonly communities: ReadonlyMap<string, string>, private readonly config: LifecyclePolicyConfig) {}
  requirePolicy() { return requireLifecyclePolicy(this.config); }
  private authorize(actor: VerifiedCoopActor, permission: string, id: string, reason: string) {
    if (!actor.orgId || !actor.actorId || !actor.permissions.includes(permission) || !uuid.test(id) || typeof reason !== "string" || !reason.trim() || reason.length > 2048) throw new Error("Lifecycle authorization required");
  }
  private current(row: any, org: string) { if (!row || this.communities.get(row.community_id) !== org) throw new Error("Lifecycle source unavailable"); }
  private async event(tx: postgres.TransactionSql, actor: VerifiedCoopActor, reason: string, kind: string, caseId: string, decisionId: string | null = null, holdId: string | null = null) {
    if (!this.cipher) throw new Error("Lifecycle audit encryption unavailable");
    const id = crypto.randomUUID(), audit = this.cipher.seal(`${actor.orgId}:${id}`, { actorId: actor.actorId, reason });
    await tx`INSERT INTO moderation.lifecycle_events (event_id, org_id, case_id, decision_id, hold_id, kind, encrypted_audit) VALUES (${id}, ${actor.orgId}, ${caseId}, ${decisionId}, ${holdId}, ${kind}, ${audit})`;
  }
  async placeEvidenceHold(input: { caseId: string; reason: string; holdUntil: string }, actor: VerifiedCoopActor): Promise<HoldStatus> {
    this.authorize(actor, "manage_moderation_records", input.caseId, input.reason);
    const policy = this.requirePolicy(), until = new Date(input.holdUntil);
    if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now() || until.getTime() > Date.now() + policy.holdMaxSeconds * 1000) throw new Error("Invalid hold deadline");
    return this.sql.begin(async tx => {
      const row = await lockLifecycleCase(tx, actor.orgId, input.caseId); this.current(row, actor.orgId);
      const [existing] = await tx`SELECT * FROM moderation.evidence_holds WHERE org_id = ${actor.orgId} AND case_id = ${input.caseId} AND released_at IS NULL AND hold_until > clock_timestamp() ORDER BY created_at, hold_id LIMIT 1`;
      if (existing) return holdStatus(existing);
      if (row.expires_at.getTime() <= Date.now()) throw new Error("Evidence expired");
      if (!this.cipher) throw new Error("Lifecycle audit encryption unavailable");
      const holdId = crypto.randomUUID();
      const [held] = await tx`INSERT INTO moderation.evidence_holds (hold_id, org_id, case_id, hold_until, encrypted_audit, audit_retention_seconds, case_expires_at) VALUES (${holdId}, ${actor.orgId}, ${input.caseId}, ${until}, ${this.cipher.seal(`${actor.orgId}:${holdId}`, { actorId: actor.actorId, reason: input.reason })}, ${policy.auditRetentionSeconds}, ${row.expires_at}) RETURNING *`;
      await this.event(tx, actor, input.reason, "hold_created", input.caseId, null, holdId); return holdStatus(held);
    }) as Promise<HoldStatus>;
  }
  async releaseEvidenceHold(input: { holdId: string; reason: string }, actor: VerifiedCoopActor): Promise<HoldStatus> {
    this.authorize(actor, "manage_moderation_records", input.holdId, input.reason);
    return this.sql.begin(async tx => {
      const [scope] = await tx`SELECT case_id FROM moderation.evidence_holds WHERE org_id = ${actor.orgId} AND hold_id = ${input.holdId}`;
      if (!scope) throw new Error("Hold unavailable");
      const row = await lockLifecycleCase(tx, actor.orgId, scope.case_id);
      if (row) this.current(row, actor.orgId);
      const [held] = await tx`SELECT * FROM moderation.evidence_holds WHERE org_id = ${actor.orgId} AND hold_id = ${input.holdId} FOR UPDATE`;
      if (held.released_at) return holdStatus(held);
      await this.event(tx, actor, input.reason, "hold_released", held.case_id, null, held.hold_id);
      const [released] = await tx`UPDATE moderation.evidence_holds SET released_at = clock_timestamp() WHERE hold_id = ${held.hold_id} RETURNING *`;
      await this.eraseCase(tx, actor.orgId, held.case_id); return holdStatus(released);
    }) as Promise<HoldStatus>;
  }
  async readHeldEvidence(input: { caseId: string; reason: string }, actor: VerifiedCoopActor) {
    this.authorize(actor, "view_held_evidence", input.caseId, input.reason);
    // Decrypt only after the transaction containing the access audit commits.
    const row = await this.sql.begin(async tx => {
      const row = await lockLifecycleCase(tx, actor.orgId, input.caseId); this.current(row, actor.orgId);
      const [held] = await tx`SELECT audit_retention_seconds::text AS retention FROM moderation.evidence_holds WHERE org_id = ${actor.orgId} AND case_id = ${input.caseId} AND released_at IS NULL AND hold_until > clock_timestamp() AND audit_retention_seconds > 0 ORDER BY hold_until DESC LIMIT 1`;
      if (!held || !Number.isSafeInteger(Number(held.retention)) || Number(held.retention) <= 0) throw new Error("Held evidence unavailable");
      await this.event(tx, actor, input.reason, "held_evidence_access", input.caseId); return row;
    });
    if (!this.cipher) throw new Error("Evidence encryption unavailable");
    const value = this.cipher.open(`${actor.orgId}:${input.caseId}`, row.evidence);
    return { caseId: input.caseId, target: { communityId: row.community_id, channelId: row.channel_id, rumorId: row.rumor_id }, author: row.author, content: value.evidence.content, reason: value.reason, createdAt: value.evidence.createdAt, ...(value.evidence.editedAt === undefined ? {} : { editedAt: value.evidence.editedAt }), expiresAt: row.expires_at.toISOString() };
  }
  async setAppeal(input: { decisionId: string; state: "open" | "closed"; reason: string }, actor: VerifiedCoopActor): Promise<LifecycleStatus> {
    this.authorize(actor, "manage_moderation_records", input.decisionId, input.reason); this.requirePolicy();
    if (!["open", "closed"].includes(input.state)) throw new Error("Invalid appeal state");
    return this.sql.begin(async tx => {
      const { decision } = await lockLifecycleDecision(tx, actor.orgId, input.decisionId); this.current(decision, actor.orgId);
      if (input.state === "open" && decision.lifecycle_closed_at) await this.event(tx, actor, input.reason, "lifecycle_reopened", decision.case_id, decision.decision_id);
      await this.event(tx, actor, input.reason, input.state === "open" ? "appeal_opened" : "appeal_closed", decision.case_id, decision.decision_id);
      const [row] = await tx`UPDATE moderation.decisions SET appeal_state = ${input.state}, lifecycle_closed_at = CASE WHEN ${input.state} = 'open' THEN NULL ELSE lifecycle_closed_at END, audit_delete_after = CASE WHEN ${input.state} = 'open' THEN NULL ELSE audit_delete_after END WHERE decision_id = ${input.decisionId} RETURNING *`; return status(row);
    }) as Promise<LifecycleStatus>;
  }
  private async eligible(tx: postgres.TransactionSql, decision: any, deliveries: any[]) {
    // B3/B4 supply sanction recovery. Supersession never erases a surviving Guild effect.
    if (decision.action !== "remove_message" || decision.appeal_state === "open" || deliveries.map(d => d.target).sort().join(",") !== "concord,discord,divine_relay" || deliveries.some(d => !["verified", "not_applicable"].includes(d.state) || d.lease_until?.getTime() > Date.now() || (d.publication_attempted && d.state !== "verified" && !["concord_superseded_publication_settled", "concord_publication_settled"].includes(d.result_code)) || d.discord_restriction_state === "present" || (d.target === "discord" && decision.discord_guild_confirmed && d.discord_restriction_state === "unknown"))) return false;
    const [held] = await tx`SELECT 1 FROM moderation.evidence_holds WHERE org_id = ${decision.org_id} AND case_id = ${decision.case_id} AND released_at IS NULL AND hold_until > clock_timestamp()`;
    return !held;
  }
  async closeLifecycle(input: { decisionId: string; reason: string }, actor: VerifiedCoopActor): Promise<LifecycleStatus> {
    this.authorize(actor, "manage_moderation_records", input.decisionId, input.reason); const policy = this.requirePolicy();
    return this.sql.begin(async tx => {
      const { decision, deliveries } = await lockLifecycleDecision(tx, actor.orgId, input.decisionId); this.current(decision, actor.orgId);
      if (decision.lifecycle_closed_at) return status(decision);
      // Evidence expiry does not close audit automatically, and cannot make a
      // settled action depend forever on keeping or rebuilding expired bytes.
      if (!await this.eligible(tx, decision, deliveries)) throw new Error("Lifecycle not eligible for closure");
      await this.event(tx, actor, input.reason, "lifecycle_closed", decision.case_id, decision.decision_id);
      const retention = Math.max(policy.auditRetentionSeconds, Number(decision.audit_retention_seconds ?? 0));
      const [row] = await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp(), audit_retention_seconds = ${retention}, audit_delete_after = clock_timestamp() + (${retention} * interval '1 second') WHERE decision_id = ${input.decisionId} RETURNING *`; return status(row);
    }) as Promise<LifecycleStatus>;
  }
  private async eraseCase(tx: postgres.TransactionSql, org: string, caseId: string) {
    await tx`DELETE FROM moderation.cases c WHERE c.org_id = ${org} AND c.case_id = ${caseId} AND c.expires_at <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM moderation.evidence_holds h WHERE h.org_id = c.org_id AND h.case_id = c.case_id AND h.released_at IS NULL AND h.hold_until > clock_timestamp())`;
  }
  async expireEvidence() {
    const rows = await this.sql`SELECT org_id, case_id FROM moderation.cases WHERE expires_at <= clock_timestamp() ORDER BY org_id, case_id`;
    for (const row of rows) await this.sql.begin(async tx => { await lifecycleCaseBoundary(tx, row.org_id, row.case_id); await this.eraseCase(tx, row.org_id, row.case_id); });
  }
  async expireAudit() {
    const rows = await this.sql`SELECT org_id, decision_id FROM moderation.decisions WHERE audit IS NOT NULL AND audit_delete_after <= clock_timestamp() ORDER BY org_id, case_id, decision_id`;
    for (const row of rows) await this.sql.begin(async tx => {
      const { decision, deliveries } = await lockLifecycleDecision(tx, row.org_id, row.decision_id);
      if (decision.lifecycle_closed_at && decision.audit_delete_after?.getTime() <= Date.now() && await this.eligible(tx, decision, deliveries)) await tx`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${decision.decision_id}`;
    });
    const cases = await this.sql`SELECT DISTINCT org_id, case_id FROM moderation.evidence_holds UNION SELECT DISTINCT org_id, case_id FROM moderation.lifecycle_events`;
    for (const row of cases) await this.sql.begin(async tx => {
      await lockLifecycleCase(tx, row.org_id, row.case_id);
      await lockCaseRecords(tx, row.org_id, row.case_id);
      const [active] = await tx`SELECT 1 FROM moderation.evidence_holds WHERE org_id = ${row.org_id} AND case_id = ${row.case_id} AND released_at IS NULL AND hold_until > clock_timestamp()`;
      if (active) return;
      const [retention] = await tx`SELECT max(GREATEST(COALESCE(released_at, hold_until), case_expires_at) + audit_retention_seconds * interval '1 second') AS deadline FROM moderation.evidence_holds WHERE org_id = ${row.org_id} AND case_id = ${row.case_id}`;
      if (retention?.deadline) {
        await tx`UPDATE moderation.evidence_holds SET audit_delete_after = GREATEST(audit_delete_after, ${retention.deadline}) WHERE org_id = ${row.org_id} AND case_id = ${row.case_id} AND audit_retention_seconds IS NOT NULL`;
        await tx`UPDATE moderation.lifecycle_events SET audit_delete_after = GREATEST(audit_delete_after, ${retention.deadline}) WHERE org_id = ${row.org_id} AND case_id = ${row.case_id} AND decision_id IS NULL`;
      }
      await tx`UPDATE moderation.lifecycle_events e SET audit_delete_after = GREATEST(e.audit_delete_after, c.audit_delete_after) FROM moderation.decisions c WHERE e.decision_id = c.decision_id AND e.org_id = ${row.org_id} AND e.case_id = ${row.case_id} AND c.audit_delete_after IS NOT NULL`;
      await tx`DELETE FROM moderation.lifecycle_events e WHERE e.org_id = ${row.org_id} AND e.case_id = ${row.case_id} AND e.audit_delete_after <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM moderation.cases c WHERE c.org_id = e.org_id AND c.case_id = e.case_id AND c.expires_at > clock_timestamp()) AND (e.decision_id IS NULL OR EXISTS (SELECT 1 FROM moderation.decisions c WHERE c.decision_id = e.decision_id AND c.audit IS NULL AND c.lifecycle_closed_at IS NOT NULL AND c.appeal_state <> 'open'))`;
      await tx`DELETE FROM moderation.evidence_holds h WHERE h.org_id = ${row.org_id} AND h.case_id = ${row.case_id} AND h.audit_delete_after <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM moderation.cases c WHERE c.org_id = h.org_id AND c.case_id = h.case_id AND c.expires_at > clock_timestamp()) AND NOT EXISTS (SELECT 1 FROM moderation.lifecycle_events e WHERE e.hold_id = h.hold_id)`;
    });
  }
}
