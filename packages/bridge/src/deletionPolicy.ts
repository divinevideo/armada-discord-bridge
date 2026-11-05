import type { PendingConcordDelete, ChannelLink } from './router';

export const MAX_PENDING_DELETES_PER_LINK = 4096;
export const MAX_PENDING_DELETES_PER_ACTOR = 1024;
export const DELETION_RETRY_MS = 10_000;
export const MAX_PENDING_DELETE_REPLAY_BATCH = 128;
export const UNRESOLVED_RETENTION_MS = 7 * 86400_000;
export class DeletionIntakeError extends Error {
  readonly durable = false;
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'DeletionIntakeError'; }
}
export class ActionableDeletionCapacityError extends DeletionIntakeError {
  link?: ChannelLink;
  readonly repairFloor: number;
  constructor(row: PendingConcordDelete) {
    super('Actionable Concord deletion capacity exceeded');
    this.repairFloor = row.sourceWrapCreatedAt ?? Math.floor(row.createdAtMs / 1000);
  }
}
export interface DeletionIntakeOutcome { stored: number; disposedExpired: number; disposedCapacity: number; disposedFuture?: number; }
export const deletionPolicyCounters = { expired: 0, capacity: 0, future: 0 };
export function observeDeletionDisposition(outcome: DeletionIntakeOutcome): void {
  deletionPolicyCounters.expired += outcome.disposedExpired;
  deletionPolicyCounters.capacity += outcome.disposedCapacity;
  deletionPolicyCounters.future += outcome.disposedFuture ?? 0;
}
export function normalizeDeletion(row: PendingConcordDelete, now: number): PendingConcordDelete {
  const sourceWrapCreatedAt = row.sourceWrapCreatedAt ?? Math.floor(row.createdAtMs / 1000);
  const firstObservedAtMs = Math.min(row.firstObservedAtMs ?? row.createdAtMs, now);
  const actionClass = row.actionClass ?? 'unresolved';
  return { ...row, sourceWrapCreatedAt, firstObservedAtMs, actionClass,
    expiresAtMs: actionClass === 'actionable' ? undefined : Math.min(sourceWrapCreatedAt * 1000, firstObservedAtMs, now) + UNRESOLVED_RETENTION_MS,
    attempts: row.attempts ?? 0, nextAttemptAtMs: row.nextAttemptAtMs ?? now };
}
export const deletionKey = (row: PendingConcordDelete): string => `${row.deleteRumorId}:${row.targetRumorId}`;
/** Plan atomically before writing: promotion cannot lose its quarantine row on overflow. */
export function planDeletionIntake(held: PendingConcordDelete[], input: PendingConcordDelete[], now: number): { writes: PendingConcordDelete[]; outcome: DeletionIntakeOutcome } {
  const map = new Map(held.map(row => [deletionKey(row), row]));
  const outcome = { stored: 0, disposedExpired: 0, disposedCapacity: 0, disposedFuture: 0 };
  const writes: PendingConcordDelete[] = [];
  for (const raw of new Map(input.map(row => [deletionKey(row), row])).values()) {
    const key = deletionKey(raw), old = map.get(key);
    if (old && (old.actionClass === 'actionable' || raw.actionClass !== 'actionable')) { outcome.stored++; continue; }
    const row = normalizeDeletion(old ? { ...old, actionClass: 'actionable' } : raw, now);
    if (row.actionClass === 'unresolved' && row.sourceWrapCreatedAt! > Math.floor(now / 1000)) { outcome.disposedFuture++; continue; }
    if (row.actionClass === 'unresolved' && row.expiresAtMs! <= now) { outcome.disposedExpired++; continue; }
    const peers = [...map.values()].filter(other => other.actionClass === row.actionClass);
    if (peers.length >= MAX_PENDING_DELETES_PER_LINK || peers.filter(other => other.author === row.author).length >= MAX_PENDING_DELETES_PER_ACTOR) {
      if (row.actionClass === 'actionable') throw new ActionableDeletionCapacityError(row);
      outcome.disposedCapacity++; continue;
    }
    map.set(key,row); writes.push(row); outcome.stored++;
  }
  return { writes, outcome };
}
export const deletionRetryDelay = (attempts: number): number => Math.min(3_600_000, DELETION_RETRY_MS * 2 ** Math.min(attempts, 9));
