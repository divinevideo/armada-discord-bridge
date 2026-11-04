/**
 * Generate only synthetic cross-client vectors; never accesses a relay or production secrets.
 *
 * The live community every shared vector is built on: bootstrap, control
 * history, chat and moderation carriers. It deliberately carries no rotation
 * or dissolution, since those would end the very community this file presents
 * as live; community-lifecycle.ts adds them to a fixture of its own.
 *
 *   bun scripts/fixtures/community-interop.ts > test-fixtures/concord/community-interop.json
 */
import { buildBundleEvent, buildInviteUrl, buildMetadataEdition, buildChannelEdition, buildRegistryEdition, bytesToHex, channelsView, controlGroups, currentControlWriteGroup, foldControlState, hex32, mintLinkSigner, mintToken, openControlWraps, sealEdition } from '@armada-bridge/concord-core';
import { finalizeEvent } from 'nostr-tools/pure';
import { ConcordActions } from '../../packages/moderation/src/concordActions';
import { moderationFixture } from './moderation-events';
import { projectChannel } from './community-bootstrap';

/** The fixture, plus the private material the lifecycle generator signs with. */
export async function communityInteropParts() {
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
  const fixture = {
    description: 'Synthetic signed bridge-kernel vectors. Contains disposable public read material only. Never use for deployment.',
    sourceRevision: '3febf95aef198828fc156b08e2bda4b873e55f2a',
    inviteUrl: buildInviteUrl('https://chat.example', link.pk, token, f.community.relays),
    bundleEvent, controlEvents: controls, rejectedControlEvents: [f.unauthorizedControl],
    chatEvent: f.allowed, bannedChatEvent: f.banned, moderatorDeleteEvent,
    expected: {
      communityId: f.community.idHex, owner: f.owner.pk, member: f.member.pk,
      moderator: f.moderator.pk, bannedMember: f.bannedMember.pk,
      channels: channelsView(f.community, folded).map(projectChannel),
      message: { id: f.allowedRumorId, channelId: f.channelId, content: 'Synthetic relay message' },
    },
  };
  return { f, link, token, bundle, controls, fixture };
}

export async function communityInteropFixture() {
  return (await communityInteropParts()).fixture;
}
if (import.meta.main) console.log(JSON.stringify(await communityInteropFixture(), null, 2));
