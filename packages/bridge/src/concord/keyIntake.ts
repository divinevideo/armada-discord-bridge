/**
 * Private-channel key intake — how the bridge is let into a gated room.
 *
 * A Public Channel derives its key from the community root, so the invite the
 * bridge joined with already reads every one of them. A Private Channel does
 * not: its key is an independent random secret, delivered per member (CORD-03
 * §1). Armada delivers it the same way it delivers any key to a known npub —
 * a Direct Invite (CORD-05 §6), giftwrapped to the recipient, carrying exactly
 * the channels that member's Roles entitle them to.
 *
 * So "add the bridge to #mods-only" in Armada lands here, and without this the
 * bridge's channel list is frozen at whatever the join bundle happened to
 * carry: `channelsView` omits a Private Channel whose key we do not hold, and
 * the bridge reports "concord channel not found" for a room it can plainly see
 * named in the control fold.
 *
 * Nothing is persisted. A Direct Invite is a durable relay event sealed TO US,
 * so re-scanning at boot recovers the same keys from the same relays — the
 * bridge needs no key custody of its own, and a restart is not a way to lose
 * access. The bound: a relay that has dropped the wrap takes the key with it,
 * and re-granting from Armada re-delivers.
 *
 * Rotation is NOT handled here. A rekey (CORD-06) mints a new epoch for a
 * channel and delivers it at the rekey addresses, which nothing in this repo
 * subscribes to yet: after a revoke-driven rotation the bridge keeps a
 * superseded key and goes quiet on that channel until it is re-invited.
 */

import {
  KIND_DIRECT_INVITE,
  KIND_WRAP,
  parseDirectInviteRumor,
  rehydrateCommunity,
  toJoinMaterial,
  unionChannelKeys,
  unwrapDirectInvite,
} from "@armada-bridge/concord-core";
import type { CommunityV2 } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";

import type { RelayLike } from "./pool";
import type { LocalIdentity } from "./signer";

/** How many giftwraps to pull per relay set. Bounded: this runs at boot. */
const SCAN_LIMIT = 200;

export interface KeyIntakeResult {
  /** The community with every newly-learned channel key merged in. */
  community: CommunityV2;
  /** Channel ids (hex) whose keys this scan added. */
  learned: string[];
}

export interface KeyIntakeOptions {
  /**
   * Whether `senderPk` may vend channel keys for this community — the owner,
   * or a roster member holding MANAGE_CHANNELS. REQUIRED, and the reason is
   * worth stating: a Direct Invite is giftwrapped to our npub, but our npub is
   * public (we publish it as kind 0, in the guestbook join, and in our kind
   * 10050), and `community_id`/`owner`/`owner_salt` ride in every invite. So
   * anyone at all can seal a well-formed bundle to us naming this community.
   * Without this gate the only check was `community_id`, and since
   * `unionChannelKeys` resolves a collision by HIGHER EPOCH WINS, a stranger's
   * bundle claiming `epoch: 9999` for a real channel id would replace that
   * channel's key — silently redirecting everything the bridge mirrors into a
   * stream only the attacker can read, and persisting across restarts because
   * the forged wrap stays on the relays.
   */
  isAuthorizedSender: (senderPk: string) => boolean;
}

/**
 * Scan the identity's giftwrap inbox for Direct Invites to THIS community and
 * merge the private-channel keys they carry.
 *
 * Indexed by the wrap's outer `k` tag, which is why a recipient can ask for
 * exactly their invites instead of decrypting everything ever `p`-tagged at
 * them. The tag is unsigned relay-visible bytes and never authority — every
 * wrap is still unwrapped, seal-verified and validated below.
 */
export async function intakeDirectInviteKeys(
  pools: readonly RelayLike[],
  identity: LocalIdentity,
  community: CommunityV2,
  options: KeyIntakeOptions,
): Promise<KeyIntakeResult> {
  const filter = {
    kinds: [KIND_WRAP],
    "#p": [identity.pk],
    "#k": [String(KIND_DIRECT_INVITE)],
    limit: SCAN_LIMIT,
  };

  const wraps = new Map<string, NostrEvent>();
  for (const pool of pools) {
    const events = await pool.query([filter]).catch(() => []);
    for (const event of events) wraps.set(event.id, event);
  }

  const jm = toJoinMaterial(community, { relays: community.relays });
  const before = new Map(jm.channels.map((c) => [c.id.toLowerCase(), c.epoch]));
  let channels = jm.channels;

  for (const wrap of wraps.values()) {
    const opened = await unwrapDirectInvite(wrap, identity.signer).catch(() => undefined);
    if (!opened) continue;
    // WHO sealed this, before WHAT it says. `unwrapDirectInvite` authenticates
    // the sender (the seal opens only under the pairwise ECDH key, and the
    // rumor's claimed author must equal the seal's), so `sender` is proven —
    // but proven-who is not authorized-to, and the bundle's contents are
    // otherwise unsigned key material we are about to adopt.
    if (!options.isAuthorizedSender(opened.sender)) {
      console.warn(
        `bridge: ignoring direct invite from unauthorized sender ${opened.sender.slice(0, 8)}…`,
      );
      continue;
    }
    const bundle = parseDirectInviteRumor(opened.rumor.kind, opened.rumor.content);
    // A bundle for another community is not ours to merge: the keys inside are
    // addressed by channel id alone, and channel ids are random 32-byte values
    // that say nothing about which community minted them.
    if (!bundle || bundle.community_id.toLowerCase() !== community.idHex.toLowerCase()) continue;
    // Union, never replace: a partial vend (one channel's key, which is what a
    // single role grant produces) must not displace the keys already held.
    channels = unionChannelKeys(channels, bundle.channels);
  }

  // An id we already hold can still have ADVANCED: a re-vend at a higher
  // channel epoch is a rotation we were kept through, and treating "same id"
  // as "nothing new" would throw the current key away and leave the bridge
  // reading an epoch the channel has moved off.
  const learned = channels
    .filter((c) => {
      const prior = before.get(c.id.toLowerCase());
      return prior === undefined || c.epoch > prior;
    })
    .map((c) => c.id.toLowerCase());
  if (learned.length === 0) return { community, learned: [] };

  const merged = { ...jm, channels };
  const next = rehydrateCommunity({
    community_id: community.idHex,
    seed: merged,
    current: merged,
    added_at: Date.now(),
  });
  // Unreachable short of a bug: the material came from a community that
  // already verified. Keep the old one rather than throwing away a working
  // bridge over an extra key.
  if (!next) return { community, learned: [] };
  return { community: { ...next, relays: community.relays }, learned };
}
