import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { validateCapacityContract, type PublicCapacityContract } from "./capacityContract";
import type { CommunityPolicy } from "./contracts";
import { PolicyStore, policyLock } from "./policyStore";
export interface PublicCapacitySnapshot { orgId: string; communityId: string; observedAt: number; historyCount: number; historyBytes: number; rekeyCount: number; streamCount: number; inFlight: number; /** Optional monotonic elapsed time through the gate, not full settled admission. */ innerAdmissionMs?: number }
export interface PublicCapacityState { state: "unknown" | "normal" | "warning" | "paused"; reasonCode: string; remainingBudget: number }
const unknown = (reasonCode: string): PublicCapacityState => ({ state: "unknown", reasonCode, remainingBudget: 0 });
export function evaluatePublicCapacity(snapshot: PublicCapacitySnapshot, contract: PublicCapacityContract | undefined, now: number): PublicCapacityState {
  if (!contract) return unknown("capacity_contract_required");
  if (![now, snapshot.observedAt, snapshot.historyCount, snapshot.historyBytes, snapshot.rekeyCount, snapshot.streamCount, snapshot.inFlight].every(v => Number.isSafeInteger(v) && v >= 0) || (snapshot.innerAdmissionMs !== undefined && (!Number.isFinite(snapshot.innerAdmissionMs) || snapshot.innerAdmissionMs < 0))) return unknown("capacity_sample_invalid");
  if (now < snapshot.observedAt || now - snapshot.observedAt > contract.maxSampleAgeMs) return unknown("capacity_sample_stale");
  const remainingBudget = Math.max(0, Math.min(contract.maxima.historyCount, contract.thresholds.pauseHistoryCount + contract.thresholds.urgentReserve, 4095) - snapshot.historyCount - snapshot.inFlight);
  if (snapshot.historyBytes > contract.maxima.historyBytes || snapshot.rekeyCount > contract.maxima.rekeyCount || snapshot.streamCount > contract.maxima.streamCount || snapshot.inFlight > contract.maxima.inFlight || (snapshot.innerAdmissionMs ?? 0) > contract.maxima.innerAdmissionMs || snapshot.historyCount + snapshot.inFlight >= contract.thresholds.pauseHistoryCount) return { state: "paused", reasonCode: "capacity_bound_reached", remainingBudget };
  return { state: snapshot.historyCount + snapshot.inFlight >= contract.thresholds.warningHistoryCount ? "warning" : "normal", reasonCode: "capacity_within_bounds", remainingBudget };
}
export function assertPublicChatAllowed(state: PublicCapacityState): void { if (!["normal", "warning"].includes(state.state)) throw new Error("Public capacity unavailable"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical((value as any)[k])).join(",")}}`; return JSON.stringify(value); }
export function loadPublicCapacity(env: Record<string, string | undefined> = process.env) {
  let communities = new Map<string, string>(), contract: PublicCapacityContract | undefined;
  try { communities = new Map(Object.entries(JSON.parse(env.MODERATION_COMMUNITY_ORGS ?? "null"))); if (!communities.size || [...communities].some(([id, org]) => !/^[0-9a-f]{64}$/.test(id) || typeof org !== "string" || !org)) throw Error(); } catch { communities = new Map(); }
  try { if (env.MODERATION_CAPACITY_CONTRACT_FILE) contract = validateCapacityContract(JSON.parse(readFileSync(env.MODERATION_CAPACITY_CONTRACT_FILE, "utf8")), { sourceSha: env.MODERATION_SOURCE_SHA ?? "", platform: `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}` }); } catch { /* Invalid/missing evidence blocks public mutation, never startup/read recovery. */ }
  return { communities, contract };
}
export async function currentCapacitySnapshot(tx: postgres.TransactionSql, policy: CommunityPolicy, orgId: string, inFlight = 0): Promise<PublicCapacitySnapshot> {
  const rekeys = await tx`SELECT event_id, event FROM moderation.rekey_events WHERE community_id = ${policy.communityId} LIMIT 4097`;
  const [streams] = await tx`SELECT count(*)::int AS n FROM moderation.streams WHERE community_id = ${policy.communityId}`;
  return { orgId, communityId: policy.communityId, observedAt: Date.now(), historyCount: policy.controlEvents.length + rekeys.length, historyBytes: Buffer.byteLength(JSON.stringify(policy.controlEvents)) + Buffer.byteLength(JSON.stringify(rekeys.map(r => r.event))), rekeyCount: rekeys.length, streamCount: streams.n, inFlight };
}
export class PublicCapacityStore {
  readonly contractHash: string | null;
  constructor(private readonly sql: postgres.Sql, readonly contract: PublicCapacityContract | undefined) { this.contractHash = contract ? createHash("sha256").update(canonical(contract)).digest("hex") : null; }
  private async observeTx(tx: postgres.TransactionSql, snapshot: PublicCapacitySnapshot): Promise<PublicCapacityState> {
    const [prior] = await tx`SELECT * FROM moderation.public_capacity_state WHERE org_id = ${snapshot.orgId} AND community_id = ${snapshot.communityId}`;
    let next = evaluatePublicCapacity(snapshot, this.contract, Date.now());
    if (prior?.state === "paused") next = { ...next, state: "paused", reasonCode: prior.reason_code };
    else if (prior?.contract_hash && prior.contract_hash !== this.contractHash) next = unknown("capacity_contract_changed");
    await tx`INSERT INTO moderation.public_capacity_state (org_id, community_id, state, contract_hash, paused_at, reason_code, history_count, history_bytes, rekey_count, stream_count, in_flight, gate_elapsed_ms, observed_at)
      VALUES (${snapshot.orgId}, ${snapshot.communityId}, ${next.state}, ${prior?.contract_hash && prior.contract_hash !== this.contractHash ? prior.contract_hash : this.contractHash}, ${next.state === "paused" ? prior?.paused_at ?? new Date() : null}, ${next.reasonCode}, ${snapshot.historyCount}, ${snapshot.historyBytes}, ${snapshot.rekeyCount}, ${snapshot.streamCount}, ${snapshot.inFlight}, ${snapshot.innerAdmissionMs ?? null}, ${new Date(snapshot.observedAt)})
      ON CONFLICT (org_id, community_id) DO UPDATE SET state = EXCLUDED.state, contract_hash = EXCLUDED.contract_hash, paused_at = EXCLUDED.paused_at, reason_code = EXCLUDED.reason_code, history_count = EXCLUDED.history_count, history_bytes = EXCLUDED.history_bytes, rekey_count = EXCLUDED.rekey_count, stream_count = EXCLUDED.stream_count, in_flight = EXCLUDED.in_flight, gate_elapsed_ms = EXCLUDED.gate_elapsed_ms, observed_at = EXCLUDED.observed_at`;
    return next;
  }
  async observe(snapshot: PublicCapacitySnapshot): Promise<PublicCapacityState> { return this.sql.begin(async tx => { await policyLock(tx, snapshot.communityId); return this.observeTx(tx, snapshot); }) as Promise<PublicCapacityState>; }
  async observeCurrent(orgId: string, communityId: string): Promise<PublicCapacityState> {
    return this.sql.begin(async tx => { await policyLock(tx, communityId); const policy = await new PolicyStore(tx as unknown as postgres.Sql).getPolicy(communityId); if (!policy || !policy.complete || policy.rekeyPending || policy.validUntil <= Date.now()) throw Error("Capacity policy unavailable"); return this.observeTx(tx, await currentCapacitySnapshot(tx, policy, orgId)); }) as Promise<PublicCapacityState>;
  }
  async pause(input: { orgId: string; communityId: string; reasonCode: string }): Promise<PublicCapacityState> {
    if (!/^[a-z_]{1,64}$/.test(input.reasonCode)) throw Error("Invalid pause reason");
    await this.sql.begin(async tx => {
      await policyLock(tx, input.communityId);
      const [prior] = await tx`SELECT 1 FROM moderation.public_capacity_state WHERE org_id = ${input.orgId} AND community_id = ${input.communityId}`;
      if (!prior) {
        const policy = await new PolicyStore(tx as unknown as postgres.Sql).getPolicy(input.communityId);
        if (!policy) throw Error("Capacity policy unavailable");
        await this.observeTx(tx, await currentCapacitySnapshot(tx, policy, input.orgId));
      }
      // Stale/missing observations cannot prevent an operator from setting the latch.
      await tx`UPDATE moderation.public_capacity_state SET state = 'paused', reason_code = ${input.reasonCode}, paused_at = COALESCE(paused_at, clock_timestamp()) WHERE org_id = ${input.orgId} AND community_id = ${input.communityId}`;
    });
    return { state: "paused", reasonCode: input.reasonCode, remainingBudget: 0 };
  }
  async resume(input: { orgId: string; communityId: string; actorId: string; contractHash: string }): Promise<PublicCapacityState> {
    if (!input.actorId || input.actorId.length > 128 || !this.contract || input.contractHash !== this.contractHash) throw Error("Fresh reviewed capacity contract required");
    return this.sql.begin(async tx => {
      await policyLock(tx, input.communityId); const policy = await new PolicyStore(tx as unknown as postgres.Sql).getPolicy(input.communityId);
      if (!policy || !policy.complete || policy.rekeyPending || policy.validUntil <= Date.now()) throw Error("Fresh policy required");
      const snapshot = await currentCapacitySnapshot(tx, policy, input.orgId), next = evaluatePublicCapacity(snapshot, this.contract, Date.now()); assertPublicChatAllowed(next);
      await tx`UPDATE moderation.public_capacity_state SET state = ${next.state}, contract_hash = ${this.contractHash}, reason_code = 'capacity_operator_resumed', paused_at = NULL, observed_at = clock_timestamp(), history_count = ${snapshot.historyCount}, history_bytes = ${snapshot.historyBytes}, rekey_count = ${snapshot.rekeyCount}, stream_count = ${snapshot.streamCount}, in_flight = 0, gate_elapsed_ms = NULL, resumed_by = ${input.actorId} WHERE org_id = ${input.orgId} AND community_id = ${input.communityId}`;
      return { ...next, reasonCode: "capacity_operator_resumed" };
    }) as Promise<PublicCapacityState>;
  }
  async assertAdmission(tx: postgres.TransactionSql, policy: CommunityPolicy, orgId: string, urgent: boolean, projected: { control?: string; rekey?: string; bytes: number }, gateElapsedMs: number): Promise<void> {
    const [row] = await tx`SELECT * FROM moderation.public_capacity_state WHERE org_id = ${orgId} AND community_id = ${policy.communityId}`;
    const snapshot = await currentCapacitySnapshot(tx, policy, orgId, 1);
    if (projected.control && !policy.controlEvents.some(e => e.id === projected.control)) { snapshot.historyCount++; snapshot.historyBytes += projected.bytes; }
    if (projected.rekey && !(await tx`SELECT 1 FROM moderation.rekey_events WHERE event_id = ${projected.rekey}`).length) { snapshot.historyCount++; snapshot.rekeyCount++; snapshot.historyBytes += projected.bytes; }
    snapshot.innerAdmissionMs = gateElapsedMs;
    if (!this.contract || !row || row.contract_hash !== this.contractHash) throw Error("Capacity configuration unavailable");
    const evaluated = evaluatePublicCapacity({ ...snapshot, observedAt: row.observed_at.getTime() }, this.contract, Date.now());
    if (urgent) {
      if (snapshot.historyBytes > this.contract.maxima.historyBytes || snapshot.rekeyCount > this.contract.maxima.rekeyCount || snapshot.streamCount > this.contract.maxima.streamCount || gateElapsedMs > this.contract.maxima.innerAdmissionMs || evaluated.remainingBudget <= 0) throw Error("Moderation capacity reserve exhausted");
    } else { if (["paused", "unknown"].includes(row.state)) throw Error("Public capacity paused"); assertPublicChatAllowed(evaluated); }
  }
  async assertPublicProducer(orgId: string, communityId: string): Promise<void> {
    await this.sql.begin(async tx => { await policyLock(tx, communityId, true); const policy = await new PolicyStore(tx as unknown as postgres.Sql).getPolicy(communityId); if (!policy || !policy.complete || policy.rekeyPending || policy.validUntil <= Date.now()) throw Error("Capacity policy unavailable"); await this.assertAdmission(tx, policy, orgId, false, { bytes: 0 }, 0); });
  }
}

/** Producer fast-fail; native admission repeats the authoritative transactional gate. */
export class PublicCapacityGuard {
  private readonly store: PublicCapacityStore;
  constructor(sql: postgres.Sql, private readonly capacity = loadPublicCapacity()) { this.store = new PublicCapacityStore(sql, capacity.contract); }
  async assertPublicProducer(communityId: string): Promise<void> {
    const orgId = this.capacity.communities.get(communityId);
    if (!orgId) throw new Error("Capacity community scope unavailable");
    await this.store.assertPublicProducer(orgId, communityId);
  }
}
