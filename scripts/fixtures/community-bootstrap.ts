/**
 * The bootstrap a client performs from nothing but a shared invite: verify the
 * bundle against the link signer, rebuild the community from it, then fold the
 * owner-rooted control state. Web and native port exactly this sequence, so the
 * shared-vector tests run it from one place instead of each keeping a copy that
 * can quietly drift from the others.
 */
import { bundleToEntry, controlGroups, foldControlState, openControlWraps, parseBundleEvent, parseInviteLink, rehydrateCommunity } from '@armada-bridge/concord-core';
import type { ChannelV2, FoldedControl } from '@armada-bridge/concord-core';
import type { NostrEvent } from 'nostr-tools/pure';

export function bootstrapFixture(fx: { inviteUrl: string; bundleEvent: NostrEvent; controlEvents: NostrEvent[] }, priorHeads?: FoldedControl['heads']) {
  const invite = parseInviteLink(fx.inviteUrl)!;
  const bundle = parseBundleEvent(fx.bundleEvent, invite.linkSigner, invite.token, Date.now());
  const community = rehydrateCommunity(bundleToEntry(bundle))!;
  const fold = (events: NostrEvent[]) => foldControlState(openControlWraps(events, controlGroups(community)), community.id, community.owner, priorHeads);
  return { invite, bundle, community, fold, folded: fold(fx.controlEvents) };
}

/** The channel shape `expected.channels` pins: id, name, and each stream's address and epoch. */
export const projectChannel = (c: ChannelV2) => ({
  id: c.idHex, name: c.name, streams: c.streams.map(s => ({ pubkey: s.group.pk, epoch: Number(s.epoch) })),
});
