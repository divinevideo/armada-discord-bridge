/**
 * Relay pool with Concord broadcast semantics: reads merge across every
 * community relay; a publish succeeds when ANY relay accepts (matching
 * Armada's `broadcast` in useChannel2).
 *
 * NIP-42: relays that gate kind 1059 (ditto-relay's default) require every
 * `authors` entry in a REQ to be an authenticated pubkey on the connection.
 * Stream addresses are derived keys the client holds, so a pool AUTHs as the
 * stream keys its own REQs name (see `want`) plus an identity key, all on the
 * same socket; NRelay1 retries a REQ the relay closed as auth-required.
 */

import {
  isStreamPubkey,
  onStreamKeysAdded,
  signStreamAuths,
  streamPubkeysForRelay,
} from "@armada-bridge/concord-core";
import { NRelay1 } from "@nostrify/nostrify";
import type { NostrClientMsg, NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getEventHash, verifyEvent } from "nostr-tools/pure";

/** NRelay1 keeps `send` protected; the AUTH fan-out needs it. */
class AuthedNRelay1 extends NRelay1 {
  sendRaw(msg: NostrClientMsg): void {
    this.send(msg);
  }
}

export interface SubscriptionHandlers {
  onEvent(event: NostrEvent): void;
  onError?(relayUrl: string, error: unknown): void;
}

export interface RelayLike {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  /** First relay holding a match wins; see {@link RelayPool.queryRace}. */
  queryRace?(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  publish(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  /** Standing REQ across relays, deduped by event id. Returns unsubscribe. */
  subscribe(filters: NostrFilter[], handlers: SubscriptionHandlers): () => void;
  close(): Promise<void>;
}

const QUERY_TIMEOUT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 8_000;

/** Bound on the process-wide verified-signature memo; see verifyOnce. */
const VERIFIED_MAX = 200_000;
const verified = new Set<string>();

/**
 * NRelay1's event verifier, remembering signatures it has already checked.
 *
 * Every bridge holds its own pool, and every pool hears every event from all
 * of its relays: a community's control history arrives once per relay per
 * bridge, so a fifty-bridge community Schnorr-verified each wrap two hundred
 * times — about a quarter of all boot CPU (2026-09-24 profile). The hash is
 * still recomputed every time, since it is what binds the id to the content;
 * only the signature check over that id is remembered.
 */
function verifyOnce(event: NostrEvent): boolean {
  if (getEventHash(event) !== event.id) return false;
  const key = event.id + event.sig;
  if (verified.has(key)) return true;
  if (!verifyEvent(event)) return false;
  if (verified.size >= VERIFIED_MAX) verified.clear();
  verified.add(key);
  return true;
}

/** Every pool not yet closed, for {@link RelayPool.backlog}. */
const openPools = new Set<RelayPool>();

export class RelayPool implements RelayLike {
  /**
   * What the process's sockets are holding that the relays have not taken:
   * messages queued while a socket was down (websocket-ts buffers every send
   * made then, without bound, until it reconnects) and bytes the kernel has
   * not drained from open ones. Operational visibility only.
   */
  static backlog(): { pools: number; sockets: number; down: number; queued: number; unsentBytes: number } {
    const out = { pools: openPools.size, sockets: 0, down: 0, queued: 0, unsentBytes: 0 };
    for (const pool of openPools) {
      for (const conn of pool.conns.values()) {
        out.sockets++;
        const ws = conn.socket;
        if (ws.readyState !== WebSocket.OPEN) out.down++;
        // NRelay1 always builds its socket with an ArrayQueue, which has length().
        const buffer = ws.buffer as { length?: () => number } | undefined;
        out.queued += buffer?.length?.() ?? 0;
        out.unsentBytes += ws.bufferedAmount ?? 0;
      }
    }
    return out;
  }

  private readonly conns = new Map<string, AuthedNRelay1>();
  private readonly challenges = new Map<string, string>();
  /**
   * The stream pubkeys this pool's own REQs have named as authors. A pool
   * AUTHs as these and nothing else.
   *
   * It used to AUTH as every stream key in the process-wide registry, on every
   * challenge and again whenever any pool registered a new key. With one pool
   * per bridge on the same four stock relays, that is quadratic in bridges:
   * each of ~1100 pools signed thousands of keys it never queried, at ~4ms a
   * Schnorr signature, on the main thread — 56% of boot CPU, and a boot that
   * pinned the event loop for 90 minutes (2026-09-24).
   */
  private readonly wanted = new Set<string>();
  /** Per relay, the stream pubkeys already AUTHed on its current challenge. */
  private readonly authed = new Map<string, Set<string>>();
  private readonly authSk: Uint8Array;
  private readonly stopKeyListener: () => void;

  private readonly onDisconnect?: () => void;

  constructor(readonly urls: string[], opts?: { authSk?: Uint8Array; onDisconnect?: () => void }) {
    if (urls.length === 0) throw new Error("RelayPool needs at least one relay URL");
    this.authSk = opts?.authSk ?? generateSecretKey();
    this.onDisconnect = opts?.onDisconnect;
    openPools.add(this);
    // A key can gain its secret or widen its relay scope after this pool
    // first wanted it; sign it then, on sockets that are already challenged.
    this.stopKeyListener = onStreamKeysAdded((pks) => {
      const mine = pks.filter((pk) => this.wanted.has(pk));
      if (mine.length === 0) return;
      for (const url of this.challenges.keys()) this.sendStreamAuths(url, mine);
    });
  }

  /**
   * Record the stream authors a REQ is about to name, and AUTH as the new
   * ones on every socket already challenged. Sent ahead of the REQ on the
   * same socket; should the relay still close it as auth-required, NRelay1
   * retries it once the AUTH has settled.
   *
   * Only registered stream keys are recorded: the callers register a stream
   * (ConcordClient's constructor, channels()) before they query it, and the
   * other authors a pool sees — profile lookups — are not ours to sign for.
   */
  private want(filters: NostrFilter[]): void {
    const fresh: string[] = [];
    for (const filter of filters) {
      for (const pk of filter.authors ?? []) {
        if (this.wanted.has(pk) || !isStreamPubkey(pk)) continue;
        this.wanted.add(pk);
        fresh.push(pk);
      }
    }
    if (fresh.length === 0) return;
    for (const url of this.challenges.keys()) this.sendStreamAuths(url, fresh);
  }

  /** AUTH as each of `pks` on `url`'s live challenge, skipping ones already done. */
  private sendStreamAuths(url: string, pks: Iterable<string>): void {
    const challenge = this.challenges.get(url);
    const conn = this.conns.get(url);
    if (!challenge || !conn) return;
    let done = this.authed.get(url);
    if (!done) this.authed.set(url, (done = new Set()));
    const todo = [...pks].filter((pk) => !done.has(pk));
    if (todo.length === 0) return;
    const scoped = new Set(streamPubkeysForRelay(url));
    for (const event of signStreamAuths(challenge, url, todo.filter((pk) => scoped.has(pk)))) {
      conn.sendRaw(["AUTH", event]);
      done.add(event.pubkey);
    }
  }

  private relay(url: string): AuthedNRelay1 {
    let conn = this.conns.get(url);
    if (!conn) {
      conn = new AuthedNRelay1(url, {
        verifyEvent: verifyOnce,
        auth: async (challenge) => {
          // A challenge is per socket: a reconnect earns a fresh one on which
          // nothing is authenticated yet. AUTH as the wanted stream keys, then
          // hand NRelay1 the identity auth it awaits an OK for. Keep the
          // challenge — it stays valid for the socket's lifetime — so keys
          // wanted later can AUTH on this socket too.
          this.challenges.set(url, challenge);
          this.authed.set(url, new Set());
          this.sendStreamAuths(url, this.wanted);
          return finalizeEvent(
            {
              kind: 22242,
              content: "",
              tags: [["relay", url], ["challenge", challenge]],
              created_at: Math.floor(Date.now() / 1000),
            },
            this.authSk,
          );
        },
      });
      conn.socket.addEventListener("close", () => this.onDisconnect?.());
      conn.socket.addEventListener("error", () => this.onDisconnect?.());
      this.conns.set(url, conn);
    }
    return conn;
  }

  /** A policy snapshot is incomplete if any configured source failed. */
  async queryStrict(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    const signal = opts?.signal ?? AbortSignal.timeout(QUERY_TIMEOUT_MS);
    this.want(filters);
    const results = await Promise.all(this.urls.map((url) => this.relay(url).query(filters, { signal })));
    const byId = new Map<string, NostrEvent>();
    for (const events of results) for (const event of events) byId.set(event.id, event);
    return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
  }

  /** Merge results from every relay, deduped by event id, newest first. */
  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    const signal = opts?.signal ?? AbortSignal.timeout(QUERY_TIMEOUT_MS);
    this.want(filters);
    const settled = await Promise.allSettled(
      this.urls.map((url) => this.relay(url).query(filters, { signal })),
    );
    const byId = new Map<string, NostrEvent>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const event of result.value) byId.set(event.id, event);
    }
    return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * First relay holding a match wins; empty after the timeout.
   *
   * `query` merges every relay and therefore waits for the slowest one, which
   * is right for a channel's history: the wraps are spread across relays and a
   * missing one is a missing message. Resolving an invite is the opposite
   * shape. There is a single self-certifying bundle, every relay carrying it
   * serves the same bytes, and validation rejects a bad one — so waiting on
   * the silent peers buys nothing and costs the full timeout on every boot.
   *
   * That cost was not merely slow: an empty merged result is indistinguishable
   * from a deleted bundle, so one unresponsive relay could sever a bridge
   * whose community was alive the whole time (41 of them, 2026-08-10).
   *
   * A relay that answers with nothing loses rather than wins the race — it
   * simply does not carry the bundle, and its silence must not out-run a peer
   * that does.
   */
  async queryRace(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    const signal = opts?.signal ?? AbortSignal.timeout(QUERY_TIMEOUT_MS);
    this.want(filters);
    try {
      return await Promise.any(
        this.urls.map(async (url) => {
          const events = await this.relay(url).query(filters, { signal });
          if (events.length === 0) throw new Error(`no match on ${url}`);
          return events.sort((a, b) => b.created_at - a.created_at);
        }),
      );
    } catch {
      return [];
    }
  }

  /** Any-accept broadcast; throws only when every relay refused. */
  async publish(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal ?? AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
    try {
      await Promise.any(this.urls.map((url) => this.relay(url).event(event, { signal })));
    } catch {
      throw new Error(`no relay accepted event ${event.id} (${this.urls.length} tried)`);
    }
  }

  subscribe(filters: NostrFilter[], handlers: SubscriptionHandlers): () => void {
    const controller = new AbortController();
    const seen = new Set<string>();
    this.want(filters);
    for (const url of this.urls) {
      void (async () => {
        // One retry: an auth-required CLOSED can race the AUTH fan-out for
        // late-registered stream keys; the second REQ runs post-auth.
        for (let attempt = 0; attempt < 2; attempt++) {
          let retry = false;
          try {
            for await (const msg of this.relay(url).req(filters, { signal: controller.signal })) {
              if (msg[0] === "CLOSED") {
                const reason = String(msg[2] ?? "");
                if (attempt === 0 && /auth|restricted/i.test(reason)) {
                  retry = true;
                  break;
                }
                handlers.onError?.(url, new Error(`REQ closed by relay: ${reason}`));
                return;
              }
              if (msg[0] !== "EVENT") continue;
              const event = msg[2];
              if (seen.has(event.id)) continue;
              if (seen.size >= 65_536) seen.clear(); // bounded; re-delivery is harmless post-dedup downstream
              seen.add(event.id);
              handlers.onEvent(event);
            }
          } catch (error) {
            if (!controller.signal.aborted) handlers.onError?.(url, error);
            return;
          }
          if (!retry) {
            if (!controller.signal.aborted) handlers.onError?.(url, new Error("subscription ended by relay"));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      })();
    }
    return () => controller.abort();
  }

  async close(): Promise<void> {
    openPools.delete(this);
    this.stopKeyListener();
    this.challenges.clear();
    this.authed.clear();
    await Promise.allSettled([...this.conns.values()].map((conn) => conn.close()));
    this.conns.clear();
  }
}
