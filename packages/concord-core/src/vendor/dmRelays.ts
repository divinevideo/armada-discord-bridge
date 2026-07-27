/**
 * NIP-17 DM relay list (kind 10050) parsing, extracted from armada
 * `src/hooks/useDmRelayList.ts` (the pure part only; no React hook).
 */

import { normalizeRelayUrl } from "./platform";

export const KIND_DM_RELAYS = 10050;

/** Extract the relay URLs from a kind-10050 event's `relay` tags. */
export function parseDmRelays(event: { tags: string[][] } | undefined): string[] {
  if (!event) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const [name, url] of event.tags) {
    if (name !== "relay" || !url) continue;
    const n = normalizeRelayUrl(url);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    urls.push(n);
  }
  return urls;
}
