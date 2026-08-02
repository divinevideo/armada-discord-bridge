/**
 * Sock identities: one deterministic Nostr keypair per seed persona.
 *
 * Same shape as the bridge's `derivePuppet`, but a separate HKDF namespace and
 * an arbitrary (non-Discord-snowflake) persona id, so seed personas can never
 * collide with real bridge puppets. Nothing is stored: a persona's key is a
 * pure function of the master secret and its id, so a dry-run preview shows the
 * exact npubs a later live push would use.
 *
 * The master secret lives ONLY in `.env` (SEED_MASTER_SECRET), which is
 * gitignored. Never commit it, never print it.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "nostr-tools/pure";

import { localIdentity, type LocalIdentity } from "../../packages/bridge/src/concord/signer";

const HKDF_INFO_PREFIX = "armada-seed/sock/v1/";

/** Deterministic secp256k1 secret for a persona id (counter guards bad scalars). */
export function deriveSockSk(masterSecretHex: string, personaId: string): Uint8Array {
  const ikm = hexToBytes(masterSecretHex);
  for (let counter = 0; ; counter++) {
    const sk = hkdf(sha256, ikm, undefined, `${HKDF_INFO_PREFIX}${personaId}/${counter}`, 32);
    try {
      getPublicKey(sk);
      return sk;
    } catch {
      // out-of-range scalar; bump the counter
    }
  }
}

/** A persona's local signer identity (pk + local schnorr signer). */
export function deriveSock(masterSecretHex: string, personaId: string): LocalIdentity {
  return localIdentity(deriveSockSk(masterSecretHex, personaId));
}
