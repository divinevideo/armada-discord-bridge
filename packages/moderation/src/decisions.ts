import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { DeliveryState, DeliveryTarget, RoomTarget } from "./contracts";
import { EvidenceCipher } from "./evidence";
export type RoomAction = "remove_message" | "ban_member" | "unban_member";
export interface VerifiedCoopActor { orgId: string; actorId: string; permissions: string[] }
export interface ModerationDecision { caseId: string; executionId: string; action: RoomAction; reason: string; scope: "message" | "community"; discordGuildConfirmed: boolean }
export interface DecisionStatus { decisionId: string; target: RoomTarget; action: RoomAction; deliveries: { target: DeliveryTarget; state: DeliveryState; attempts: number; resultCode: string | null }[] }
export interface StoredDecision { decisionId: string; orgId: string; caseId: string; target: RoomTarget; author: string; action: RoomAction; discordGuildConfirmed: boolean; expiresAt: Date }
export interface DeliveryClaim { decision: StoredDecision; target: DeliveryTarget; token: string; attempts: number; signedEvents: unknown[] | null }
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
    const deliveries = await this.sql`SELECT target, state, attempts, result_code FROM moderation.deliveries WHERE decision_id = ${decisionId} ORDER BY target`;
    return { decisionId, target: stored(row).target, action: row.action, deliveries: deliveries.map((d) => ({ target: d.target as DeliveryTarget, state: d.state as DeliveryState, attempts: d.attempts, resultCode: d.result_code })) };
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
    const retried = await this.sql`UPDATE moderation.deliveries SET state = 'pending', available_at = clock_timestamp(), token = NULL, lease_until = NULL, updated_at = clock_timestamp()
      WHERE decision_id = ${decisionId} AND state = 'failed' AND attempts < 8 AND decision_id IN (SELECT decision_id FROM moderation.decisions WHERE expires_at > clock_timestamp()) RETURNING target`;
    if (!retried.length) throw new Error("No retryable delivery; escalate expired or exhausted decisions");
    return this.get(decisionId, actor);
  }
  async claim(): Promise<DeliveryClaim | undefined> {
    await this.sql`UPDATE moderation.deliveries SET state = 'failed', result_code = 'retry_budget_exhausted', token = NULL, lease_until = NULL, updated_at = clock_timestamp()
      WHERE state IN ('pending', 'acknowledged') AND attempts >= 8 AND (lease_until IS NULL OR lease_until <= clock_timestamp())`;
    return this.sql.begin(async (tx) => {
      const [job] = await tx`SELECT d.* FROM moderation.deliveries d JOIN moderation.decisions c USING (decision_id)
        WHERE d.state IN ('pending', 'acknowledged') AND d.available_at <= clock_timestamp() AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
          AND d.attempts < 8 AND c.expires_at > clock_timestamp()
        ORDER BY d.available_at, d.decision_id, d.target FOR UPDATE OF d SKIP LOCKED LIMIT 1`;
      if (!job) return undefined;
      const token = crypto.randomUUID();
      await tx`UPDATE moderation.deliveries SET token = ${token}, attempts = attempts + 1, lease_until = clock_timestamp() + interval '60 seconds', updated_at = clock_timestamp()
        WHERE decision_id = ${job.decision_id} AND target = ${job.target}`;
      const [row] = await tx`SELECT * FROM moderation.decisions WHERE decision_id = ${job.decision_id}`;
      return { decision: stored(row), target: job.target as DeliveryTarget, token, attempts: job.attempts + 1, signedEvents: job.signed_events };
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
    const rows = await this.sql`UPDATE moderation.deliveries SET signed_events = COALESCE(signed_events, ${this.sql.json(events as never)})
      WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target} AND token = ${claim.token} AND lease_until > clock_timestamp() RETURNING signed_events`;
    if (!rows.length) throw new Error("Delivery lease lost");
    return rows[0].signed_events;
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
      await tx`UPDATE moderation.deliveries SET state = 'failed', result_code = 'decision_expired', signed_events = NULL, token = NULL, lease_until = NULL
        WHERE decision_id IN (SELECT decision_id FROM moderation.decisions WHERE expires_at <= clock_timestamp()) AND state IN ('pending', 'acknowledged')`;
      await tx`UPDATE moderation.decisions SET audit = NULL WHERE expires_at <= clock_timestamp() AND audit IS NOT NULL`;
    });
  }
}
