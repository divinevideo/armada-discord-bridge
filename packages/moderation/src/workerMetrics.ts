import type postgres from "postgres";
import { bytesToHex, citationSatisfied, currentControlWriteGroup, grantLocator, hex32, isAuthorized, Permissions, type CommunityV2 } from "@armada-bridge/concord-core";
import type { CommunityPolicy } from "./contracts";
import { controlState } from "./relayPolicy";

export interface WorkerAuthorityObservation { available: boolean; validUntil: number }
/** Aggregate capability observation, never an authorization input. Target rank,
 * channel scope and publication fences remain enforced by ConcordActions.
 * `folded` must be `controlState(policy).folded`. The refresh already folds the
 * full control history for stream keys, and folding it again here would double
 * the cost of every refresh, including those on the action path. */
export function observeWorkerAuthority(community: CommunityV2, worker: string, policy: CommunityPolicy, now = Date.now(), folded?: ReturnType<typeof controlState>["folded"]): WorkerAuthorityObservation {
  const unavailable = { available: false, validUntil: now };
  try {
    if (policy.communityId !== community.idHex || policy.owner !== community.owner || worker === community.owner || !policy.complete || policy.rekeyPending || !Number.isFinite(policy.validUntil) || policy.validUntil <= now) return unavailable;
    folded ??= controlState(policy).folded;
    if (folded.incomplete.length || policy.banned.includes(worker) || folded.banned.has(worker)) return unavailable;
    if (!isAuthorized(folded.roster, worker, community.owner, Permissions.BAN) || !isAuthorized(folded.roster, worker, community.owner, Permissions.MANAGE_MESSAGES)) return unavailable;
    const entityId = grantLocator(community.id, hex32(worker)), grant = folded.heads.get(bytesToHex(entityId));
    if (!grant || !citationSatisfied(folded, community.id, worker, { entityId, version: grant.version, editionHash: grant.hash })) return unavailable;
    currentControlWriteGroup(community);
    // A wedged refresh loop must not retain a green observation indefinitely.
    return { available: true, validUntil: Math.min(policy.validUntil, now + 30_000) };
  } catch { return unavailable; }
}

export async function workerMetricsResponse(sql: postgres.Sql, authority?: WorkerAuthorityObservation, now?: number): Promise<Response> {
  try {
    await sql`SELECT 1`;
    return new Response(`concord_worker_authority_available ${Number(Boolean(authority?.available && (now ?? Date.now()) < authority.validUntil))}\n`, { headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
  } catch { return new Response("unavailable", { status: 503 }); }
}
