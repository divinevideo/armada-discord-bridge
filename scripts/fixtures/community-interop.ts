/** Generate only synthetic cross-client vectors; never accesses a relay or production secrets. */
import { buildBundleEvent, buildInviteUrl, buildMetadataEdition, buildChannelEdition, buildRegistryEdition, bytesToHex, channelsView, controlGroups, currentControlWriteGroup, foldControlState, hex32, mintLinkSigner, mintToken, openControlWraps, sealEdition } from '@armada-bridge/concord-core';
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
    f.unauthorizedControl,
  ];
  const bundle = {
    community_id: f.community.idHex, owner: f.owner.pk,
    owner_salt: bytesToHex(f.community.ownerSalt), community_root: bytesToHex(f.community.root),
    root_epoch: 0, control_pk: f.community.controlPk, channels: [], relays: f.community.relays,
    name: 'Synthetic shared community', creator_npub: f.owner.pk,
  };
  const folded = foldControlState(openControlWraps(controls, controlGroups(f.community)), f.community.id, f.owner.pk);
  return {
    description: 'Synthetic signed bridge-kernel vectors. Contains disposable public read material only. Never use for deployment.',
    sourceRevision: '3febf95aef198828fc156b08e2bda4b873e55f2a',
    inviteUrl: buildInviteUrl('https://chat.example', link.pk, token, f.community.relays),
    bundleEvent: buildBundleEvent(bundle, token, link.sk), controlEvents: controls,
    chatEvent: f.allowed,
    expected: {
      communityId: f.community.idHex, owner: f.owner.pk, member: f.member.pk,
      moderator: f.moderator.pk, bannedMember: f.bannedMember.pk,
      channels: channelsView(f.community, folded).filter(c => !c.isPrivate).map(c => ({
        id: c.idHex, name: c.name, streams: c.streams.map(s => ({ pubkey: s.group.pk, epoch: Number(s.epoch) })),
      })),
      message: { id: f.allowedRumorId, channelId: f.channelId, content: 'Synthetic relay message' },
    },
  };
}
if (import.meta.main) console.log(JSON.stringify(await communityInteropFixture(), null, 2));
