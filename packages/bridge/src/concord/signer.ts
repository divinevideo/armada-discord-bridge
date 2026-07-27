/**
 * Local secret-key signer: the bridge holds raw keys (primary identity and
 * derived puppets), so signing is a local schnorr operation, never a remote
 * NIP-46 round-trip.
 */

import type { StreamSigner } from "@armada-bridge/concord-core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

export interface LocalIdentity {
  /** x-only pubkey, lowercase hex. */
  pk: string;
  signer: StreamSigner;
}

export function localIdentity(sk: Uint8Array): LocalIdentity {
  return {
    pk: getPublicKey(sk),
    signer: {
      async signEvent(template: EventTemplate): Promise<NostrEvent> {
        return finalizeEvent(template, sk);
      },
    },
  };
}
