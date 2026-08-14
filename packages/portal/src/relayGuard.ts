/**
 * Host vetting for relay URLs the portal is asked to connect to.
 *
 * Relay lists reach the server from two untrusted places: the list a user
 * types into the import wizard, and the `bootstrapRelays` embedded in a pasted
 * invite link (plus `community.relays` on the event that link resolves to — a
 * second hop the pasting user still indirectly controls). All three end up in
 * `new RelayPool(...)`, which opens a WebSocket: an HTTP GET to a host, port
 * and path of the submitter's choosing. `ws://127.0.0.1:6379/` was accepted.
 *
 * The scheme check that existed (`/^wss?:\/\//`) is not a host check. This is
 * the host check, sharing {@link hostIsPublic} with the bridge's fetch guard so
 * the two cannot drift on what counts as private.
 *
 * `ws://` to a PUBLIC host is still allowed. Concord payloads are NIP-44
 * sealed, so a plaintext relay hop leaks metadata rather than content, and
 * refusing it outright would be a behaviour change rather than a fix.
 */

import { hostIsPublic } from "@armada-bridge/bridge/src/net";

const RELAY_PROTOCOLS = new Set(["ws:", "wss:"]);

async function relayIsSafe(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!RELAY_PROTOCOLS.has(url.protocol)) return false;
  return hostIsPublic(url.hostname);
}

/**
 * Vet a user-submitted relay list, rejecting the whole request on the first
 * bad entry. Used where the list is typed by the caller and a silent drop
 * would leave them wondering why their relay never appeared.
 */
export async function assertPublicRelays(relays: readonly string[]): Promise<void> {
  for (const relay of relays) {
    if (!(await relayIsSafe(relay))) {
      throw new Error(`not a usable relay URL: ${relay}`);
    }
  }
}

/**
 * Keep only the relays we are willing to dial, for lists that arrive inside an
 * invite bundle rather than from a form. Filtering beats throwing here: one bad
 * entry in a community's published relay list should not take a working bridge
 * offline. Returns `fallback` when nothing survives, so the caller always has
 * somewhere to connect.
 */
export async function filterPublicRelays(
  relays: readonly string[],
  fallback: readonly string[],
): Promise<string[]> {
  const safe: string[] = [];
  for (const relay of relays) {
    if (await relayIsSafe(relay)) safe.push(relay);
    else console.warn(`portal: refusing to dial non-public relay ${relay}`);
  }
  return safe.length > 0 ? safe : [...fallback];
}
