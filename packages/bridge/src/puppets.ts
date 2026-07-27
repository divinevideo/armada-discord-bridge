/**
 * Puppet identities: one deterministic Nostr keypair per Discord user
 * (armada-discord-bridge-PLAN.md, following Mostr's derivation pattern).
 *
 * Nothing per-user is stored; keys are recomputed from the bridge's master
 * secret and the Discord user id, and LRU-cached. A Concord moderator can ban
 * one puppet npub without affecting the bridge or other Discord users.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "nostr-tools/pure";

export interface PuppetKey {
  /** 32-byte secret key. */
  sk: Uint8Array;
  /** x-only pubkey, lowercase hex. */
  pk: string;
  /** The Discord user id this puppet represents. */
  discordUserId: string;
}

const HKDF_INFO_PREFIX = "armada-bridge/puppet/v1/";

/**
 * Derive the puppet keypair for a Discord user. The counter suffix guards the
 * negligible (~2^-128) case where HKDF output is not a valid secp256k1
 * scalar; derivation stays deterministic because the first valid counter
 * always wins.
 */
export function derivePuppet(masterSecretHex: string, discordUserId: string): PuppetKey {
  if (!/^\d{1,20}$/.test(discordUserId)) {
    throw new Error(`Not a Discord snowflake id: ${discordUserId}`);
  }
  const ikm = hexToBytes(masterSecretHex);
  for (let counter = 0; ; counter++) {
    const info = `${HKDF_INFO_PREFIX}${discordUserId}/${counter}`;
    const sk = hkdf(sha256, ikm, undefined, info, 32);
    try {
      const pk = getPublicKey(sk);
      return { sk, pk, discordUserId };
    } catch {
      // out-of-range scalar; bump the counter
    }
  }
}

/** Bounded insertion-order cache of derived puppets. */
export class PuppetCache {
  private readonly map = new Map<string, PuppetKey>();
  private readonly byPubkey = new Map<string, string>();

  constructor(
    private readonly masterSecretHex: string,
    private readonly cap = 4096,
  ) {}

  get(discordUserId: string): PuppetKey {
    const hit = this.map.get(discordUserId);
    if (hit) return hit;
    const puppet = derivePuppet(this.masterSecretHex, discordUserId);
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value as string;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      if (evicted) this.byPubkey.delete(evicted.pk);
    }
    this.map.set(discordUserId, puppet);
    this.byPubkey.set(puppet.pk, discordUserId);
    return puppet;
  }

  /**
   * Loop-prevention layer 2: is this pubkey one of our puppets? Only answers
   * for puppets seen this process lifetime; the messages table is the
   * durable check.
   */
  isPuppetPubkey(pk: string): boolean {
    return this.byPubkey.has(pk);
  }
}
