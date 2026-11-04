/**
 * Lifecycle carriers for the shared community: an owner rotation, dissolution
 * tombstones, and the refreshed invite a stopped client reopens with. Kept out
 * of community-interop.json, whose community they would otherwise end.
 * Synthetic identities only; never accesses a relay or production secrets.
 *
 *   bun scripts/fixtures/community-lifecycle.ts > test-fixtures/concord/community-lifecycle.json
 */
import { REKEY_BLOBS_PER_EVENT, buildDissolvedRumor, dissolvedGroupKey, KIND_SEAL_PLAINTEXT, mintCommunity, random32, controlSignerGroupKey, openWrap, baseRekeyGroupKey, buildRekeyRumors, epochKeyCommitment, KIND_SEAL_ENCRYPTED, sealDissolved, sealRumor, wrapSeal, buildBundleEvent, bytesToHex, controlGroups, currentControlWriteGroup, sealEdition } from '@armada-bridge/concord-core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { localIdentity } from '../../packages/bridge/src/concord/signer';
import { communityInteropParts } from './community-interop';

export async function communityLifecycleFixture() {
  const { f, link, token, bundle, controls, fixture } = await communityInteropParts();
  // Rekey carriers exclude this member. Recovery uses a separately refreshed
  // public invite; a client must not interpret stop detection as key adoption.
  const nextEpoch = f.community.rootEpoch + 1n;
  const rekeyGroup = baseRekeyGroupKey(f.community.root, f.community.id, nextEpoch);
  const rotation = {
    scope: { kind: 'root' as const }, newEpoch: nextEpoch, prevEpoch: f.community.rootEpoch,
    prevCommit: bytesToHex(epochKeyCommitment(f.community.rootEpoch, f.community.root)),
  };
  const rotateAs = async (rotator: typeof f.owner, blobs: Parameters<typeof buildRekeyRumors>[2]) =>
    Promise.all(buildRekeyRumors(rotator.pk, rotation, blobs, Date.now()).map(async rumor => wrapSeal(
      await sealRumor(rumor, KIND_SEAL_ENCRYPTED, rekeyGroup, rotator.signer), rekeyGroup)));
  const baseRekeyEvents = await rotateAs(f.owner, []);
  // Rotation negatives. The base rekey address derives from community_root,
  // which every invite holder has, so anyone can publish a complete rotation
  // that chains off the current key: only the Refounding gate (unbanned, holds
  // BAN, cites a Grant the fold confirms) refuses a member's. The other is the
  // owner's own rotation with its second chunk never published, which is
  // authorized and continuous but must not be acted on while incomplete.
  // portal/severance.ts names both as negatives the reference has to refuse.
  // Fold each set on its own: the half-published one shares the owner
  // rotation's key, as a partly published copy of it would.
  const impostorRekeyEvents = await rotateAs(f.member, []);
  const decoyBlob = () => ({ locator: bytesToHex(random32()),
    wrapped: nip44Encrypt(bytesToHex(random32()), getConversationKey(generateSecretKey(), getPublicKey(generateSecretKey()))) });
  const [firstOfTwoChunks] = await rotateAs(f.owner, Array.from({ length: REKEY_BLOBS_PER_EVENT + 1 }, decoyBlob));
  const halfPublishedRekeyEvents = [firstOfTwoChunks];
  const dissolvedEvents = [await sealDissolved(f.community.id, f.owner.pk, f.owner.signer)];
  const impostorDissolvedEvents = [await sealDissolved(f.community.id, f.member.pk, f.member.signer)];
  // The member's tombstone above honestly names its signer, so it only catches
  // a client that checks no authorship at all. Each of these defeats exactly
  // one check instead. forgedAuthor names the owner inside but is sealed by a
  // stranger: only openWrap's seal-signer/author match refuses it. replayed is
  // the owner's genuine tombstone for another community the owner runs, lifted
  // and re-wrapped at this community's dissolved address (anyone can derive it
  // from the public community id): only the eid binding refuses it, which
  // buildDissolvedRumor exists to provide ("a seal minted for X fail[s] the
  // check at Y"). zeroEid is the owner's own tombstone with the frozen all-zero
  // eid, which names no community: isDissolvedOpened refuses it rather than
  // grandfathering it and calls accepting it "the vulnerability itself", since
  // such a seal could be replayed at every community the owner runs.
  const dissolvedAt = dissolvedGroupKey(f.community.id);
  const stranger = localIdentity(generateSecretKey());
  const forgedAuthorDissolvedEvents = [wrapSeal(await sealRumor(buildDissolvedRumor(f.owner.pk, f.community.id),
    KIND_SEAL_PLAINTEXT, dissolvedAt, stranger.signer), dissolvedAt)];
  const { community: sibling } = mintCommunity('Synthetic sibling community', f.owner.pk, f.community.relays);
  const replayedDissolvedEvents = [wrapSeal(await sealRumor(buildDissolvedRumor(f.owner.pk, sibling.id),
    KIND_SEAL_PLAINTEXT, dissolvedGroupKey(sibling.id), f.owner.signer), dissolvedAt)];
  const zeroEidDissolvedEvents = [wrapSeal(await sealRumor(buildDissolvedRumor(f.owner.pk, new Uint8Array(32)),
    KIND_SEAL_PLAINTEXT, dissolvedAt, f.owner.signer), dissolvedAt)];
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
    baseRekeyEvents, impostorRekeyEvents, halfPublishedRekeyEvents,
    dissolvedEvents, impostorDissolvedEvents, forgedAuthorDissolvedEvents, replayedDissolvedEvents, zeroEidDissolvedEvents,
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
