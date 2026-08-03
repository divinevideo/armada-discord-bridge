/**
 * Local secret-key signer: the bridge holds raw keys (primary identity and
 * derived puppets), so signing is a local schnorr operation, never a remote
 * NIP-46 round-trip.
 */

import type { DirectInviteSigner, StreamSigner } from "@armada-bridge/concord-core";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

export interface LocalIdentity {
  /** x-only pubkey, lowercase hex. */
  pk: string;
  /**
   * Stream signing plus NIP-44, which is what a Direct Invite needs: its seal
   * is encrypted to the recipient (CORD-05 §6). Holding the raw key is what
   * makes that a local operation — the client's NIP-46 path has to ask a
   * bunker, which is why the surface is optional in `DirectInviteSigner`.
   */
  signer: StreamSigner & Required<Pick<DirectInviteSigner, "nip44">>;
}

export function localIdentity(sk: Uint8Array): LocalIdentity {
  return {
    pk: getPublicKey(sk),
    signer: {
      async signEvent(template: EventTemplate): Promise<NostrEvent> {
        return finalizeEvent(template, sk);
      },
      nip44: {
        async encrypt(pubkey: string, plaintext: string): Promise<string> {
          return nip44Encrypt(plaintext, getConversationKey(sk, pubkey));
        },
        async decrypt(pubkey: string, ciphertext: string): Promise<string> {
          return nip44Decrypt(ciphertext, getConversationKey(sk, pubkey));
        },
      },
    },
  };
}
