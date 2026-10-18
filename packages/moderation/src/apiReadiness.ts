import type postgres from "postgres";

/** Durable outbox backlog is a delivery problem, not loss of the staff API.
 * Making it unready also removes Retry and status access during a Coop outage. */
export async function apiReadiness(sql: postgres.Sql, cleanupFailed: boolean): Promise<boolean> {
  try { await sql`SELECT 1`; return !cleanupFailed; }
  catch { return false; }
}

export interface LifecyclePolicyConfig { auditRetentionSeconds?: number; holdMaxSeconds?: number }
export class PolicyConfigurationRequiredError extends Error {
  readonly code = "policy_configuration_required";
  constructor() { super("Lifecycle policy configuration required"); }
}
/** Preflight describes policy configuration only. Lifecycle routes consume the
 * guard when wired; health and accepted replay do not depend on new policy. */
export function moderationWriteCapabilities(config: LifecyclePolicyConfig) {
  const configured = [config.auditRetentionSeconds, config.holdMaxSeconds].every(value => Number.isSafeInteger(value) && value! > 0);
  return { reads: true, acceptedReplay: true, reconciliation: true, holdRelease: true,
    policyDependentWrites: configured, code: configured ? "ready" : "policy_configuration_required" } as const;
}
export function requireLifecyclePolicy(config: LifecyclePolicyConfig): { auditRetentionSeconds: number; holdMaxSeconds: number } {
  if (!moderationWriteCapabilities(config).policyDependentWrites) throw new PolicyConfigurationRequiredError();
  return { auditRetentionSeconds: config.auditRetentionSeconds!, holdMaxSeconds: config.holdMaxSeconds! };
}
export function lifecycleWriteReadinessResponse(config: LifecyclePolicyConfig, healthy: boolean): Response {
  const capabilities = moderationWriteCapabilities(config);
  return Response.json({ ...capabilities, code: healthy ? capabilities.code : "unavailable" }, {
    status: healthy && capabilities.policyDependentWrites ? 200 : 503, headers: { "cache-control": "no-store" },
  });
}
