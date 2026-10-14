/** Synthetic identities only. This generator never prints signing or read keys. */
import { buildChannelEdition, buildRumor, bytesToHex, channelBindingTags, channelGroupKey, currentControlGroup, currentControlWriteGroup, currentGuestbookGroup, hex32, mintCommunity, openWrap, sealEdition, sealRumor, wrapSeal, KIND_SEAL_ENCRYPTED } from "@armada-bridge/concord-core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import type { CommunityPolicy, StreamDescriptor } from "../../packages/moderation/src/contracts";
function identity() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { pk, signer: { signEvent: async (event: EventTemplate) => finalizeEvent(event, sk) } };
}
export async function relayFixture() {
  const owner = identity(), member = identity(), bannedMember = identity();
  const { community } = mintCommunity("Synthetic relay test", owner.pk, ["wss://relay.example"]);
  const channelId = "ab".repeat(32);
  const chatKey = channelGroupKey(community.root, hex32(channelId), 0);
  const describe = (plane: StreamDescriptor["plane"], key: { pk: string; convKey: Uint8Array; restricted?: boolean }): StreamDescriptor => ({ communityId: community.idHex, ...(plane === "chat" ? { channelId } : {}), plane, epoch: "0", key: { pk: key.pk, convKey: key.convKey, restricted: key.restricted } });
  const chatStream = describe("chat", chatKey);
  const controlStream = describe("control", currentControlGroup(community));
  const guestbookStream = describe("guestbook", currentGuestbookGroup(community));
  const channelRumor = buildChannelEdition(hex32(channelId), { name: "general", private: false }, { actorPubkey: owner.pk, version: 1n });
  const controlEvent = await sealEdition(channelRumor, currentControlWriteGroup(community), owner.signer);
  const unauthorizedControl = await sealEdition(buildChannelEdition(hex32(channelId), { name: "changed", private: false }, { actorPubkey: member.pk, version: 2n }), currentControlWriteGroup(community), member.signer);
  const chat = async (author: typeof member) => sealRumor(buildRumor({ pubkey: author.pk, kind: 9, content: "Synthetic relay message", tags: channelBindingTags(channelId, 0n), ms: Date.now() }), KIND_SEAL_ENCRYPTED, chatKey, author.signer);
  const allowedSeal = await chat(member);
  const policy: CommunityPolicy = {
    communityId: community.idHex, owner: owner.pk, ownerSalt: bytesToHex(community.ownerSalt),
    revision: 1, complete: true, validUntil: Date.now() + 60_000,
    controlStreams: [controlStream], controlEvents: [controlEvent], banned: [bannedMember.pk],
    publicAuthors: [owner.pk, member.pk], snapshotAuthorities: [],
  };
  return { owner, member, bannedMember, channelId, chatKey, chatStream, controlStream, guestbookStream, controlEvent, unauthorizedControl, allowedSeal, allowedRumorId: openWrap(wrapSeal(allowedSeal, chatKey), chatStream.key).rumorId, policy, allowed: wrapSeal(allowedSeal, chatKey), banned: wrapSeal(await chat(bannedMember), chatKey) };
}
