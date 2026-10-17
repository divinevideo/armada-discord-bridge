import type postgres from 'postgres';
interface Snapshot { policyCount: number; policyRevision: number; policyAge: number; pending: number; failed: number; oldestPendingAge: number }
export function renderMetrics(snapshot: Snapshot): string {
  if (Object.values(snapshot).some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Invalid metric');
  return Object.entries({ concord_policy_count: snapshot.policyCount, concord_policy_revision: snapshot.policyRevision, concord_policy_age_seconds: snapshot.policyAge, concord_deliveries_pending: snapshot.pending, concord_deliveries_failed: snapshot.failed, concord_oldest_pending_seconds: snapshot.oldestPendingAge }).map(([name, value]) => `# TYPE ${name} gauge\n${name} ${value}\n`).join('');
}
/** No case IDs, authors, room IDs, evidence, or credential labels. */
export async function collectMetrics(sql: postgres.Sql): Promise<string> {
  const [policy] = await sql`SELECT count(*) AS count, COALESCE(min(revision), 0) AS revision,
    COALESCE(max(GREATEST(0, extract(epoch FROM clock_timestamp() - updated_at))), 0) AS age FROM moderation.community_policy`;
  const [delivery] = await sql`SELECT count(*) FILTER (WHERE d.state IN ('pending', 'acknowledged')) AS pending,
    count(*) FILTER (WHERE d.state = 'failed' AND d.result_code IS DISTINCT FROM 'superseded_by_newer_decision') AS failed,
    COALESCE(max(GREATEST(0, extract(epoch FROM clock_timestamp() - c.created_at))) FILTER (WHERE d.state IN ('pending', 'acknowledged')), 0) AS age
    FROM moderation.deliveries d JOIN moderation.decisions c USING (decision_id)`;
  const [handoff] = await sql`SELECT count(*) AS pending,
    COALESCE(max(GREATEST(0, extract(epoch FROM clock_timestamp() - c.created_at))), 0) AS age
    FROM moderation.coop_handoffs h JOIN moderation.cases c USING (case_id)
    WHERE h.state = 'pending' AND c.expires_at > clock_timestamp()`;
  const handoffPending = Number(handoff.pending), handoffAge = Number(handoff.age);
  if (![handoffPending, handoffAge].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('Invalid handoff metric');
  return renderMetrics({ policyCount: Number(policy.count), policyRevision: Number(policy.revision), policyAge: Number(policy.age), pending: Number(delivery.pending), failed: Number(delivery.failed), oldestPendingAge: Number(delivery.age) })
    + `# TYPE concord_coop_handoffs_pending gauge\nconcord_coop_handoffs_pending ${handoffPending}\n# TYPE concord_coop_oldest_pending_seconds gauge\nconcord_coop_oldest_pending_seconds ${handoffAge}\n`;
}
