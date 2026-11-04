/**
 * Lifecycle carriers for the shared community: an owner rotation, dissolution
 * tombstones, and the refreshed invite a stopped client reopens with. Kept out
 * of community-interop.json, whose community they would otherwise end.
 * Synthetic identities only; never accesses a relay or production secrets.
 *
 *   bun scripts/fixtures/community-lifecycle.ts > test-fixtures/concord/community-lifecycle.json
 */
import { buildDissolvedRumor, dissolvedGroupKey, KIND_SEAL_PLAINTEXT, mintCommunity, random32, controlSignerGroupKey, openWrap, baseRekeyGroupKey, buildRekeyRumors, epochKeyCommitment, KIND_SEAL_ENCRYPTED, sealDissolved, sealRumor, wrapSeal, buildBundleEvent, bytesToHex, controlGroups, currentControlWriteGroup, sealEdition } from '@armada-bridge/concord-core';
import { generateSecretKey } from 'nostr-tools/pure';
import { localIdentity } from '../../packages/bridge/src/concord/signer';
import { communityInteropParts } from './community-interop';

export async function communityLifecycleFixture() {
  const { f, link, token, bundle, controls, fixture } = await communityInteropParts();
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
  // The member's tombstone above honestly names its signer, so it only catches
  // a client that checks no authorship at all. Each of these defeats exactly
  // one check instead. forgedAuthor names the owner inside but is sealed by a
  // stranger: only openWrap's seal-signer/author match refuses it. replayed is
  // the owner's genuine tombstone for another community the owner runs, lifted
  // and re-wrapped at this community's dissolved address (anyone can derive it
  // from the public community id): only the eid binding refuses it, and
  // control.ts calls accepting it "the vulnerability itself".
  const dissolvedAt = dissolvedGroupKey(f.community.id);
  const stranger = localIdentity(generateSecretKey());
  const forgedAuthorDissolvedEvents = [wrapSeal(await sealRumor(buildDissolvedRumor(f.owner.pk, f.community.id),
    KIND_SEAL_PLAINTEXT, dissolvedAt, stranger.signer), dissolvedAt)];
  const { community: sibling } = mintCommunity('Synthetic sibling community', f.owner.pk, f.community.relays);
  const replayedDissolvedEvents = [wrapSeal(await sealRumor(buildDissolvedRumor(f.owner.pk, sibling.id),
    KIND_SEAL_PLAINTEXT, dissolvedGroupKey(sibling.id), f.owner.signer), dissolvedAt)];
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
  // Only what reopening and stop detection read. Carrying the live fixture's
  // chat and moderation carriers too would make this file churn, as a new
  // community, every time a vector is added to community-interop.json.
  const { description, sourceRevision, inviteUrl, bundleEvent, controlEvents, expected } = fixture;
  return {
    refreshedBundleEvent, nextEpochControlEvents,
    baseRekeyEvents, dissolvedEvents, impostorDissolvedEvents, forgedAuthorDissolvedEvents, replayedDissolvedEvents,
    nextEpoch: Number(nextEpoch),
    description, sourceRevision, inviteUrl, bundleEvent, controlEvents,
    // The expected block clients already read from this file (native's session
    // test reads member and channels), not whatever the live fixture adds later.
    expected: {
      communityId: expected.communityId, owner: expected.owner, member: expected.member, moderator: expected.moderator,
      bannedMember: expected.bannedMember, channels: expected.channels, message: expected.message,
    },
  };
}
if (import.meta.main) console.log(JSON.stringify(await communityLifecycleFixture(), null, 2));
