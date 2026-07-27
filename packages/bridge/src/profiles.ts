/**
 * Concord member personas for the Discord side: kind 0 profile lookup over
 * the app relays, TTL-cached, falling back to a shortened key handle.
 */

import type { RelayLike } from "./concord/pool";
import { fallbackProfile } from "./router";
import type { ProfileResolver } from "./router";

const TTL_MS = 10 * 60 * 1000;

interface CachedProfile {
  value: { name: string; avatarUrl?: string };
  fetchedAt: number;
}

export class Kind0ProfileResolver implements ProfileResolver {
  private readonly cache = new Map<string, CachedProfile>();

  constructor(private readonly pool: RelayLike) {}

  async resolve(pubkeyHex: string): Promise<{ name: string; avatarUrl?: string }> {
    const hit = this.cache.get(pubkeyHex);
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.value;

    let value = fallbackProfile(pubkeyHex);
    try {
      const events = await this.pool.query([{ kinds: [0], authors: [pubkeyHex], limit: 1 }]);
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (newest) {
        const meta = JSON.parse(newest.content) as { name?: string; display_name?: string; picture?: string };
        const name = (meta.display_name || meta.name || "").trim();
        if (name) value = { name, avatarUrl: typeof meta.picture === "string" ? meta.picture : undefined };
      }
    } catch {
      // relay or JSON failure: fall back, retry after TTL
    }
    if (this.cache.size >= 4096) this.cache.clear();
    this.cache.set(pubkeyHex, { value, fetchedAt: Date.now() });
    return value;
  }
}
