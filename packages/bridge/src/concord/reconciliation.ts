import { nip77 } from 'nostr-tools';
import type { NRelay1, NostrFilter, NostrEvent } from '@nostrify/nostrify';

export const REPLAY_MAX_IDS = 16_384;
export class ReplayWindowLimitError extends Error {}
export class ReplayAuthError extends Error {}

/** An empty local inventory is intentional: live delivery is not durable coverage. */
export function enumerateInventory(socket: NRelay1['socket'], filter: NostrFilter, opts?: { signal?: AbortSignal }): Promise<string[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(opts?.signal ? [opts.signal] : [])]);
  const storage = new nip77.NegentropyStorageVector(); storage.seal();
  const engine = new nip77.Negentropy(storage, 60_000);
  const id = `replay-${crypto.randomUUID()}`, ids = new Set<string>();
  // This is independent of REQ caps. No `limit` is admissible in the inventory filter.
  const { limit: _limit, ...inventoryFilter } = filter;
  return new Promise((resolve, reject) => {
    let done = false, started = false, rounds = 0, bytes = 0, previous = '';
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      socket.removeEventListener('message', message);
      socket.removeEventListener('open', open);
      socket.removeEventListener('close', closed);
      socket.removeEventListener('error', closed);
      signal.removeEventListener('abort', aborted);
      // Never put session frames on websocket-ts's reconnect queue.
      if (started && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify(['NEG-CLOSE', id])); } catch { /* The failed socket already invalidated coverage. */ }
      }
      error ? reject(error) : resolve([...ids]);
    };
    const send = (frame: unknown[]) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Inventory socket disconnected');
      socket.send(JSON.stringify(frame));
    };
    const closed = () => finish(new Error('Inventory socket disconnected'));
    const aborted = () => finish(signal.reason ?? new Error('Inventory aborted'));
    const open = () => {
      if (started || done) return;
      started = true;
      try { send(['NEG-OPEN', id, inventoryFilter, engine.initiate()]); } catch (error) { finish(error); }
    };
    const message = (_socket: unknown, incoming: MessageEvent) => {
      if (done) return;
      const raw = String(incoming.data);
      // Bound parsing as well as reconciliation. Huge unrelated frames also fail
      // this attempt closed rather than allocating arbitrary replay memory.
      if (raw.length > 2 * 1024 * 1024) { finish(new ReplayWindowLimitError('Inventory frame too large')); return; }
      let frame: unknown;
      try { frame = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(frame) || frame[1] !== id) return;
      try {
        if (frame[0] !== 'NEG-MSG') {
          const reason = String(frame[2] ?? '');
          if (frame[0] === 'NEG-ERR' && /auth|required.*auth|restricted/i.test(reason)) throw new ReplayAuthError('Inventory authentication required');
          if (frame[0] === 'NEG-ERR' && /too (many|large)|sync.*limit|exceed|maximum|resource|query.*limit/i.test(reason)) throw new ReplayWindowLimitError('Relay inventory limit');
          throw new Error(`Inventory refused: ${frame[0]}`);
        }
        const payload = frame[2];
        if (typeof payload !== 'string' || !/^[0-9a-f]+$/i.test(payload) || payload.length % 2) throw new Error('Invalid inventory frame');
        if (payload.length > 128 * 1024 || (bytes += payload.length / 2) > 4 * 1024 * 1024 || ++rounds > 256) throw new ReplayWindowLimitError('Inventory synchronization limit');
        const before = ids.size;
        const response = engine.reconcile(payload, undefined, eventId => {
          ids.add(eventId);
          if (ids.size > REPLAY_MAX_IDS) throw new ReplayWindowLimitError('Inventory exceeds 16384 IDs');
        });
        if (response === null) { finish(); return; }
        if (previous === payload && ids.size === before) throw new Error('Inventory made no progress');
        previous = payload;
        send(['NEG-MSG', id, response]);
      } catch (error) { finish(error); }
    };
    socket.addEventListener('message', message);
    socket.addEventListener('open', open);
    socket.addEventListener('close', closed);
    socket.addEventListener('error', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (socket.readyState === WebSocket.OPEN) open();
  });
}

/** Exact reads also stay on the current socket: reconnect cannot turn a partial
 * response into a completed fetch, and an encrypted batch has a byte ceiling. */
export function fetchInventory(socket: NRelay1['socket'], ids: string[], filter: NostrFilter, verify: (event: NostrEvent) => boolean, opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(opts?.signal ? [opts.signal] : [])]);
  const id = `fetch-${crypto.randomUUID()}`, requested = new Set(ids);
  return new Promise((resolve, reject) => {
    let done = false, started = false, bytes = 0, frames = 0;
    const found = new Map<string, NostrEvent>();
    const finish = (error?: unknown) => {
      if (done) return; done = true;
      socket.removeEventListener('message', message);
      socket.removeEventListener('open', open);
      socket.removeEventListener('close', closed);
      socket.removeEventListener('error', closed);
      signal.removeEventListener('abort', aborted);
      if (started && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify(['CLOSE', id])); } catch { /* No queue after disconnect. */ }
      }
      error ? reject(error) : resolve([...found.values()]);
    };
    const closed = () => finish(new Error('Exact-ID fetch disconnected'));
    const aborted = () => finish(signal.reason ?? new Error('Exact-ID fetch aborted'));
    const open = () => {
      if (done || started) return; started = true;
      try { socket.send(JSON.stringify(['REQ', id, { ...filter, ids, limit: ids.length }])); } catch (error) { finish(error); }
    };
    const message = (_socket: unknown, incoming: MessageEvent) => {
      const raw = String(incoming.data);
      if (raw.length > 1024 * 1024) { finish(new Error('Exact-ID event frame exceeds 1 MiB')); return; }
      let frame: unknown;
      try { frame = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(frame) || frame[1] !== id) return;
      try {
        if (++frames > 1000) throw new Error('Exact-ID fetch frame limit');
        if (bytes + raw.length * 2 > 16 * 1024 * 1024) {
          // A short exact read is progress, never coverage. Let the caller
          // fetch the outstanding IDs in another bounded batch.
          if (found.size) { finish(); return; }
          throw new Error('Exact-ID fetch byte limit');
        }
        bytes += raw.length * 2;
        if (frame[0] === 'EOSE') { finish(); return; }
        if (frame[0] === 'CLOSED') {
          if (/auth|restricted/i.test(String(frame[2]))) throw new ReplayAuthError('Exact-ID authentication required');
          throw new Error('Exact-ID fetch refused');
        }
        if (frame[0] !== 'EVENT') throw new Error('Invalid exact-ID fetch frame');
        const event = frame[2];
        if (!event || !requested.has(event.id) || !verify(event) ||
            (filter.kinds && !filter.kinds.includes(event.kind)) || (filter.authors && !filter.authors.includes(event.pubkey)) ||
            (filter.since !== undefined && event.created_at < filter.since) || (filter.until !== undefined && event.created_at > filter.until)) throw new Error('Invalid event in exact-ID fetch');
        found.set(event.id, event);
      } catch (error) { finish(error); }
    };
    socket.addEventListener('message', message);
    socket.addEventListener('open', open);
    socket.addEventListener('close', closed);
    socket.addEventListener('error', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (socket.readyState === WebSocket.OPEN) open();
  });
}
