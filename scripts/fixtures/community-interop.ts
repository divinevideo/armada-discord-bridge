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
import { KIND_SEAL_PLAINTEXT, buildBundleEvent, buildInviteUrl, buildRevocationEvent, buildRumor, channelBindingTags, KIND_SEAL_ENCRYPTED, sealRumor, wrapSeal, buildMetadataEdition, buildChannelEdition, buildRegistryEdition, bytesToHex, channelsView, controlGroups, currentControlWriteGroup, foldControlState, grantLocator, hex32, mintLinkSigner, mintToken, openControlWraps, sealEdition } from '@armada-bridge/concord-core';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { localIdentity } from '../../packages/bridge/src/concord/signer';
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
  // The authority vector. Staff who hold the control write key and a valid
  // Grant, but whose Moderator role lacks MANAGE_CHANNELS, rename the message's
  // channel. It links to the channel's head and cites the signer's own Grant, so
  // neither a chain gap, a stale version nor a missing citation can be what
  // refuses it; only the permission bit can. relayFixture's unchained rename
  // (rejectedControlEvents) is refused as a gap even when the owner signs it,
  // so it cannot stand in for this.
  const channelHead = folded.heads.get(f.channelId)!;
  const moderatorGrant = grantLocator(f.community.id, hex32(f.moderator.pk));
  const grantHead = folded.heads.get(bytesToHex(moderatorGrant))!;
  const unauthorizedControlEvents = [await sealEdition(buildChannelEdition(hex32(f.channelId), { name: 'changed', private: false }, {
    actorPubkey: f.moderator.pk, version: channelHead.version + 1n, prevHash: channelHead.hash,
    authority: { entityId: moderatorGrant, version: grantHead.version, editionHash: grantHead.hash },
  }), currentControlWriteGroup(f.community), f.moderator.signer)];
  // Deletions of the allowed message that a client must not honour. Each opens
  // and binds like any chat event, so the moderation predicate is the only
  // thing that can keep the message.
  const chat = channelsView(f.community, folded).find(c => c.idHex === f.channelId)!.current;
  const deleteBy = async (who: { pk: string; signer: Parameters<typeof sealRumor>[3] }) => wrapSeal(await sealRumor(buildRumor({
    pubkey: who.pk, kind: 5, content: '', tags: [...channelBindingTags(f.channelId, chat.epoch), ['e', f.allowedRumorId]], ms: Date.now(),
  }), KIND_SEAL_ENCRYPTED, chat.group, who.signer), chat.group);
  // A member with no Grant: a canDelete that allows anyone removes the message.
  const bystander = localIdentity(generateSecretKey());
  const unprivilegedDeleteEvent = await deleteBy(bystander);
  // The moderator, who does hold MANAGE_MESSAGES, without citing their Grant.
  // A non-owner moderation delete with no resolvable citation parks
  // (ChatModeration.canDelete): the permission alone would honour a moderator
  // whose demotion this client has not synced yet. A canDelete that checks
  // only the permission, or only that the deleter is staff, removes it.
  const uncitedModeratorDeleteEvent = await deleteBy(f.moderator);
  // Chat carriers the read path must refuse though openWrap opens them: the
  // member's message under a plaintext seal (chat seals must be encrypted,
  // CORD-02 §5), and one sealed under this channel's key but bound to the
  // introductions channel. Only openChatBatch's seal and binding checks catch them.
  const memberSays = (tags: string[][]) => buildRumor({ pubkey: f.member.pk, kind: 9, content: 'Synthetic relay message', tags, ms: Date.now() });
  const plaintextChatEvent = wrapSeal(await sealRumor(memberSays(channelBindingTags(f.channelId, chat.epoch)), KIND_SEAL_PLAINTEXT, chat.group, f.member.signer), chat.group);
  const misboundChatEvent = wrapSeal(await sealRumor(memberSays(channelBindingTags('cd'.repeat(32), chat.epoch)), KIND_SEAL_ENCRYPTED, chat.group, f.member.signer), chat.group);
  // A second invite whose signer has re-posted its coordinate as a revocation
  // tombstone (and which the owner's registry no longer lists). Its earlier live
  // bundle ships too, a second older and openable with the URL's token: the
  // coordinate is replaceable, so a client that does not act on the newest
  // event there opens a revoked invite. (One that does act on it refuses even
  // without checking the marker, since the empty payload cannot decrypt; only
  // asserting the "revoked" reason pins the marker itself.)
  const revokedLink = mintLinkSigner(), revokedToken = mintToken();
  const revokedLive = buildBundleEvent(bundle, revokedToken, revokedLink.sk);
  const revokedLiveBundleEvent = finalizeEvent({ kind: revokedLive.kind, tags: revokedLive.tags,
    content: revokedLive.content, created_at: revokedLive.created_at - 1 }, revokedLink.sk);
  const [moderatorDeleteEvent] = await new ConcordActions(f.community, f.moderator, async () => ({ ...f.policy, controlEvents: controls })).prepare(f.decision);
  const fixture = {
    description: 'Synthetic signed bridge-kernel vectors. Contains disposable public read material only. Never use for deployment.',
    sourceRevision: '3febf95aef198828fc156b08e2bda4b873e55f2a',
    inviteUrl: buildInviteUrl('https://chat.example', link.pk, token, f.community.relays),
    bundleEvent,
    revokedInviteUrl: buildInviteUrl('https://chat.example', revokedLink.pk, revokedToken, f.community.relays),
    revokedLiveBundleEvent, revokedBundleEvent: buildRevocationEvent(revokedLink.sk),
    controlEvents: controls, rejectedControlEvents: [f.unauthorizedControl], unauthorizedControlEvents,
    chatEvent: f.allowed, plaintextChatEvent, misboundChatEvent, bannedChatEvent: f.banned, moderatorDeleteEvent, unprivilegedDeleteEvent, uncitedModeratorDeleteEvent,
    expected: {
      communityId: f.community.idHex, owner: f.owner.pk, member: f.member.pk,
      moderator: f.moderator.pk, bannedMember: f.bannedMember.pk, bystander: bystander.pk,
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
