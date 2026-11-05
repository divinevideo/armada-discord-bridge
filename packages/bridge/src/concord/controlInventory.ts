import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import type { RelayLike } from './pool';
import { REPLAY_MAX_IDS, ReplayWindowLimitError } from './reconciliation';

export const CONTROL_MAX_BYTES = 16 * 1024 * 1024;

/** Control editions determine which payload authors exist. REQ/EOSE can be
 * capped even when it succeeds, so only exact inventories from EVERY source
 * can establish this prerequisite. Fold input stays within replay's existing
 * ID/byte budget; exceeding it is explicit incompleteness, never truncation. */
export async function controlInventory(pool: RelayLike, authors: string[], signal: AbortSignal): Promise<NostrEvent[]> {
  if (!pool.replayRelays?.length || !pool.enumerateRelay || !pool.fetchRelay) throw new Error('Relay does not support complete control discovery');
  const relays = [...new Set(pool.replayRelays)].sort(), events = new Map<string, NostrEvent>();
  let bytes = 0;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (JSON.stringify([...new Set(pool.replayRelays)].sort()) !== JSON.stringify(relays)) throw new Error('Control discovery relay set changed');
  };
  const visit = async (since: number, until?: number): Promise<void> => {
    assertCurrent();
    const filter: NostrFilter = { kinds: [1059], authors, since, ...(until === undefined ? {} : { until }) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const inventories = new Map<string, string[]>(), union = new Set<string>();
      try {
        for (const relay of relays) {
          const ids = await pool.enumerateRelay!(relay, filter, { signal }); assertCurrent();
          for (const id of ids) {
            if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid control inventory ID');
            union.add(id);
            if (union.size > REPLAY_MAX_IDS) throw new ReplayWindowLimitError('Control inventory window exceeds ID bound');
          }
          inventories.set(relay, ids);
        }
      } catch (error) {
        if (!(error instanceof ReplayWindowLimitError) || since === until) throw error;
        if (until === undefined) {
          const now = Math.floor(Date.now() / 1000);
          // Control discovery has no settled/future timestamp cutoff. Split
          // retained history normally; an oversized unbounded future tail
          // stays incomplete rather than inventing a protocol time limit.
          if (since > now) throw new Error('Future control inventory exceeds source bounds');
          await visit(since, now); await visit(now + 1); return;
        }
        const middle = since + Math.floor((until - since) / 2);
        await visit(since, middle); await visit(middle + 1, until); return;
      }
      let missing = false;
      for (const [relay, ids] of inventories) {
        const outstanding = new Set(ids);
        while (outstanding.size) {
          assertCurrent();
          const batch = [...outstanding].slice(0, 100), requested = new Set(batch);
          const fetched = await pool.fetchRelay!(relay, batch, filter, { signal }); assertCurrent();
          let progress = 0;
          for (const event of fetched) {
            if (!requested.has(event.id) || event.kind !== 1059 || !authors.includes(event.pubkey) || event.created_at < since || (until !== undefined && event.created_at > until)) throw new Error('Control event outside exact inventory request');
            if (outstanding.delete(event.id)) progress++;
            if (events.has(event.id)) continue;
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (events.size >= REPLAY_MAX_IDS || bytes > CONTROL_MAX_BYTES) throw new Error('Complete control discovery exceeds resource bounds');
            events.set(event.id, event);
          }
          if (!progress) { missing = true; break; }
        }
        if (missing) break;
      }
      if (!missing) return;
      if (attempt === 1) throw new Error('Control inventory contains unavailable IDs');
    }
  };
  await visit(0); assertCurrent();
  return [...events.values()];
}
