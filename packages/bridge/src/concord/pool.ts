/**
 * Relay pool with Concord broadcast semantics: reads merge across every
 * community relay; a publish succeeds when ANY relay accepts (matching
 * Armada's `broadcast` in useChannel2).
 */

import { NRelay1 } from "@nostrify/nostrify";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

export interface SubscriptionHandlers {
  onEvent(event: NostrEvent): void;
  onError?(relayUrl: string, error: unknown): void;
}

export interface RelayLike {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  publish(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  /** Standing REQ across relays, deduped by event id. Returns unsubscribe. */
  subscribe(filters: NostrFilter[], handlers: SubscriptionHandlers): () => void;
  close(): Promise<void>;
}

const QUERY_TIMEOUT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 8_000;

export class RelayPool implements RelayLike {
  private readonly conns = new Map<string, NRelay1>();

  constructor(readonly urls: string[]) {
    if (urls.length === 0) throw new Error("RelayPool needs at least one relay URL");
  }

  private relay(url: string): NRelay1 {
    let conn = this.conns.get(url);
    if (!conn) {
      conn = new NRelay1(url);
      this.conns.set(url, conn);
    }
    return conn;
  }

  /** Merge results from every relay, deduped by event id, newest first. */
  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    const signal = opts?.signal ?? AbortSignal.timeout(QUERY_TIMEOUT_MS);
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
    for (const url of this.urls) {
      void (async () => {
        try {
          for await (const msg of this.relay(url).req(filters, { signal: controller.signal })) {
            if (msg[0] !== "EVENT") continue;
            const event = msg[2];
            if (seen.has(event.id)) continue;
            if (seen.size >= 65_536) seen.clear(); // bounded; re-delivery is harmless post-dedup downstream
            seen.add(event.id);
            handlers.onEvent(event);
          }
        } catch (error) {
          if (!controller.signal.aborted) handlers.onError?.(url, error);
        }
      })();
    }
    return () => controller.abort();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.conns.values()].map((conn) => conn.close()));
    this.conns.clear();
  }
}
