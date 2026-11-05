import { KIND_WRAP, openChatBatch } from '@armada-bridge/concord-core';
import type { ChannelV2, OpenedChat } from '@armada-bridge/concord-core';
import type { NostrFilter } from '@nostrify/nostrify';
import type { RelayLike } from './pool';
import { REPLAY_MAX_IDS, ReplayWindowLimitError } from './reconciliation';

export type DeliveredChat = OpenedChat & { sourceWrapCreatedAt: number };
export interface ReplayBatch { chats: DeliveredChat[]; newestWrapAt?: number }
export interface ReplayWindow { since: number; until: number; runUntil: number }
/** Cancellation bounds the replay wait, not the external operation. Callers
 * must retain in-flight callbacks in the same serial delivery lane until they
 * settle, and fence every later effect/checkpoint with current authority and
 * durable lifecycle/lease/version predicates. A rejected replay is not drain. */
export interface ReplayCallbackContext { readonly signal: AbortSignal }
export interface ReplayOptions {
  signal?: AbortSignal;
  onBatch?: (batch: ReplayBatch, context: ReplayCallbackContext) => Promise<void>;
  /** Only this callback certifies coverage, after every payload batch settled. */
  onWindowComplete?: (window: ReplayWindow, context: ReplayCallbackContext) => Promise<void>;
}
export interface ReplayResult extends ReplayBatch { certifiedUntil?: number }
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
// Includes the strings retained by OpenedChat's nested rumor as well as tags.
function decodedBytes(chat: DeliveredChat): number { return encoder.encode(JSON.stringify([chat.content, chat.tags, chat.seal])).length + 512; }

class MissingInventoryError extends Error {}

async function awaitReplayCallback<T>(callback: (value: T, context: ReplayCallbackContext) => Promise<void>, value: T, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      failed ? reject(error) : resolve();
    };
    const aborted = () => finish(true, signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    // Keep a rejection handler attached even after abort wins: the callback
    // may still run in its caller-owned lane, but cannot resume this replay.
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return callback(value, { signal });
    }).then(() => finish(false), error => finish(true, error));
  });
  signal.throwIfAborted();
}

/** Wrap-time windows progress oldest first; rumor-ms order is preserved within
 * each window. Arbitrarily backdated rumors cannot be globally ordered across
 * windows without retaining the entire history. No plaintext is spooled to disk. */
export async function replayChannel(pool: RelayLike, channel: ChannelV2, sinceSec: number, limit = 500, opts?: ReplayOptions): Promise<ReplayResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPLAY_MAX_IDS) throw new Error('Invalid Concord replay page size');
  if (!Number.isSafeInteger(sinceSec) || sinceSec < 0) throw new Error('Invalid Concord replay floor');
  if (!pool.replayRelays?.length || !pool.enumerateRelay || !pool.fetchRelay) throw new Error('Relay does not support certified inventory replay');
  const relays = [...new Set(pool.replayRelays)];
  const enumerate = pool.enumerateRelay.bind(pool), fetchIds = pool.fetchRelay.bind(pool);
  const signal = AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(opts?.signal ? [opts.signal] : [])]);
  // Captured once, never inferred from an untrusted/future-dated event.
  const upper = Math.max(0, Math.floor(Date.now() / 1000) - 60), batchSize = Math.min(limit, 100);
  const accumulated: DeliveredChat[] = [];
  let accumulatedBytes = 0, newestWrapAt: number | undefined, certifiedUntil: number | undefined;
  const collect = async (since: number, until: number): Promise<ReplayBatch> => {
    const filter: NostrFilter = { kinds: [KIND_WRAP], authors: channel.streams.map(s => s.group.pk), since, until };
    // A carrier can disappear between NEG and REQ (e.g. a completed purge).
    // Re-enumerate once from empty. A repeatedly advertised but missing ID is
    // incomplete, never an implicit deletion or an EOSE-based success.
    for (let attempt = 0; attempt < 2; attempt++) {
      const inventories = new Map<string, string[]>(), union = new Set<string>();
      for (const url of relays) {
        signal.throwIfAborted();
        const ids = await enumerate(url, filter, { signal });
        for (const id of ids) {
          if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid inventory ID');
          union.add(id);
          if (union.size > REPLAY_MAX_IDS) throw new ReplayWindowLimitError('Replay union exceeds 16384 IDs');
        }
        inventories.set(url, ids);
      }
      const decoded = new Set<string>(), chats: DeliveredChat[] = [];
      let bytes = 0, at: number | undefined;
      try {
        for (const [url, ids] of inventories) {
          const outstanding = new Set(ids);
          while (outstanding.size) {
            signal.throwIfAborted();
            const batch = [...outstanding].slice(0, 100), requested = new Set(batch);
            const wraps = await fetchIds(url, batch, filter, { signal });
            let progress = 0;
            for (const wrap of wraps) {
              if (!requested.has(wrap.id) || wrap.kind !== KIND_WRAP || !filter.authors!.includes(wrap.pubkey) || wrap.created_at < since || wrap.created_at > until) throw new Error('Relay returned an event outside its exact inventory request');
              if (outstanding.delete(wrap.id)) progress++;
              if (decoded.has(wrap.id)) continue;
              decoded.add(wrap.id);
              at = Math.max(at ?? wrap.created_at, wrap.created_at);
              // The transport verified the wrap; inner rumor time is not its
              // source age and cannot extend retention after a replay.
              for (const opened of await openChatBatch([wrap], channel)) {
                const chat = { ...opened, sourceWrapCreatedAt: wrap.created_at };
                bytes += decodedBytes(chat);
                if (bytes > MAX_DECODED_BYTES) throw new ReplayWindowLimitError('Replay decoded payload exceeds 16 MiB');
                chats.push(chat);
              }
            }
            if (!progress) throw new MissingInventoryError('Relay inventory contains unavailable IDs');
          }
        }
        chats.sort((a, b) => a.ms - b.ms || a.wrapId.localeCompare(b.wrapId));
        return { chats, newestWrapAt: at };
      } catch (error) {
        if (!(error instanceof MissingInventoryError) || attempt === 1) throw error;
      }
    }
    throw new Error('Replay inventory retry exhausted');
  };
  const visit = async (since: number, until: number): Promise<void> => {
    signal.throwIfAborted();
    let batch: ReplayBatch;
    try { batch = await collect(since, until); }
    catch (error) {
      if (!(error instanceof ReplayWindowLimitError)) throw error;
      if (since === until) throw new ReplayWindowLimitError('Concord replay second exceeds resource limits; coverage remains incomplete');
      const middle = since + Math.floor((until - since) / 2);
      await visit(since, middle); await visit(middle + 1, until); return;
    }
    if (opts?.onBatch) {
      for (let i = 0; i < batch.chats.length; i += batchSize) {
        signal.throwIfAborted();
        const chats = batch.chats.slice(i, i + batchSize);
        await awaitReplayCallback(opts.onBatch, { chats, newestWrapAt: Math.max(...chats.map(chat => chat.sourceWrapCreatedAt)) }, signal);
      }
    } else {
      for (const chat of batch.chats) {
        accumulatedBytes += decodedBytes(chat);
        if (accumulatedBytes > MAX_DECODED_BYTES || accumulated.length >= REPLAY_MAX_IDS) throw new Error('Replay collection limit exceeded; use onBatch');
        accumulated.push(chat);
      }
    }
    signal.throwIfAborted();
    if (opts?.onWindowComplete) await awaitReplayCallback(opts.onWindowComplete, { since, until, runUntil: upper }, signal);
    signal.throwIfAborted();
    certifiedUntil = until;
    if (batch.newestWrapAt !== undefined) newestWrapAt = Math.max(newestWrapAt ?? batch.newestWrapAt, batch.newestWrapAt);
  };
  if (sinceSec <= upper) await visit(sinceSec, upper);
  accumulated.sort((a, b) => a.ms - b.ms);
  return { chats: accumulated, newestWrapAt, certifiedUntil };
}
