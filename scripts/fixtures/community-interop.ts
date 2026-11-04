/** Generate only synthetic cross-client vectors; never accesses a relay or production secrets. */
import { random32, controlSignerGroupKey, openWrap, baseRekeyGroupKey, buildRekeyRumors, epochKeyCommitment, KIND_SEAL_ENCRYPTED, sealDissolved, sealRumor, wrapSeal, buildBundleEvent, buildInviteUrl, buildMetadataEdition, buildChannelEdition, buildRegistryEdition, bytesToHex, channelsView, controlGroups, currentControlWriteGroup, foldControlState, hex32, mintLinkSigner, mintToken, openControlWraps, sealEdition } from '@armada-bridge/concord-core';
import { finalizeEvent } from 'nostr-tools/pure';
import { ConcordActions } from '../../packages/moderation/src/concordActions';
import { moderationFixture } from './moderation-events';

export async function communityInteropFixture() {
  const f = await moderationFixture();
  const link = mintLinkSigner(), token = mintToken();
  const common = { actorPubkey: f.owner.pk, version: 1n };
  const sign = (rumor: Parameters<typeof sealEdition>[0]) => sealEdition(rumor, currentControlWriteGroup(f.community), f.owner.signer);
  const controls = [...f.policy.controlEvents,
    await sign(buildMetadataEdition(f.community.id, { name: 'Synthetic shared community', relays: f.community.relays }, common)),
    await sign(buildChannelEdition(hex32('cd'.repeat(32)), { name: 'introductions', private: false }, common)),
    await sign(buildChannelEdition(hex32('ef'.repeat(32)), { name: 'private-support', private: true }, common)),
    await sign(buildRegistryEdition(f.community.id, f.owner.pk, [link.pk], common)),
  ];
  const bundle = {
    community_id: f.community.idHex, owner: f.owner.pk,
    owner_salt: bytesToHex(f.community.ownerSalt), community_root: bytesToHex(f.community.root),
    root_epoch: 0, control_pk: f.community.controlPk, channels: [], relays: f.community.relays,
    name: 'Synthetic shared community', creator_npub: f.owner.pk,
  };
  const originalBundle = buildBundleEvent(bundle, token, link.sk);
  // Replaceable invite selection needs a strictly newer refresh, regardless of
  // generator speed or same-second event-id ordering at a relay.
  const bundleEvent = finalizeEvent({ kind: originalBundle.kind, tags: originalBundle.tags,
    content: originalBundle.content, created_at: originalBundle.created_at - 1 }, link.sk);
  const folded = foldControlState(openControlWraps(controls, controlGroups(f.community)), f.community.id, f.owner.pk);
  const [moderatorDeleteEvent] = await new ConcordActions(f.community, f.moderator, async () => ({ ...f.policy, controlEvents: controls })).prepare(f.decision);
  // Rekey carriers exclude this member. Recovery uses a separately refreshed
  // public invite; a client must not interpret stop detection as key adoption.
  const nextEpoch = f.community.rootEpoch + 1n;
  const rekeyGroup = baseRekeyGroupKey(f.community.root, f.community.id, nextEpoch);
  const rekeys = buildRekeyRumors(f.owner.pk, {
    scope: { kind: 'root' }, newEpoch: nextEpoch, prevEpoch: f.community.rootEpoch,
    prevCommit: bytesToHex(epochKeyCommitment(f.community.rootEpoch, f.community.root)),
  }, [], Date.now());
  const baseRekeyEvents = await Promise.all(rekeys.map(async rumor => wrapSeal(
    await sealRumor(rumor, KIND_SEAL_ENCRYPTED, rekeyGroup, f.owner.signer), rekeyGroup)));
  const dissolvedEvents = [await sealDissolved(f.community.id, f.owner.pk, f.owner.signer)];
  const impostorDissolvedEvents = [await sealDissolved(f.community.id, f.member.pk, f.member.signer)];
  const nextRoot = random32(), nextControlRoot = random32();
  const nextControlPk = controlSignerGroupKey(nextControlRoot, f.community.id, nextEpoch).pk;
  const nextCommunity = { ...f.community, root: nextRoot, rootEpoch: nextEpoch, controlRoot: nextControlRoot, controlPk: nextControlPk };
  const nextEpochControlEvents = await Promise.all(controls.map(event => {
    const opened = openWrap(event, controlGroups(f.community).find(group => group.pk === event.pubkey)!);
    return sealEdition({ id: opened.rumorId, pubkey: opened.author, kind: opened.kind,
      content: opened.content, tags: opened.tags, created_at: opened.createdAt }, currentControlWriteGroup(nextCommunity), f.owner.signer);
  }));
  const refreshedBundleEvent = buildBundleEvent({ ...bundle, community_root: bytesToHex(nextRoot),
    root_epoch: Number(nextEpoch), control_pk: nextControlPk }, token, link.sk);
  return {
    refreshedBundleEvent, nextEpochControlEvents,
    baseRekeyEvents, dissolvedEvents, impostorDissolvedEvents, nextEpoch: Number(nextEpoch),
    description: 'Synthetic signed bridge-kernel vectors. Contains disposable public read material only. Never use for deployment.',
    sourceRevision: '3febf95aef198828fc156b08e2bda4b873e55f2a',
    inviteUrl: buildInviteUrl('https://chat.example', link.pk, token, f.community.relays),
    bundleEvent, controlEvents: controls, rejectedControlEvents: [f.unauthorizedControl],
    chatEvent: f.allowed, bannedChatEvent: f.banned, moderatorDeleteEvent,
    expected: {
      communityId: f.community.idHex, owner: f.owner.pk, member: f.member.pk,
      moderator: f.moderator.pk, bannedMember: f.bannedMember.pk,
      channels: channelsView(f.community, folded).map(c => ({
        id: c.idHex, name: c.name, streams: c.streams.map(s => ({ pubkey: s.group.pk, epoch: Number(s.epoch) })),
      })),
      message: { id: f.allowedRumorId, channelId: f.channelId, content: 'Synthetic relay message' },
    },
  };
}
if (import.meta.main) console.log(JSON.stringify(await communityInteropFixture(), null, 2));
