import { banlistLocator, buildBanlistEdition, buildRumor, bytesToHex, canActOnMember, checkChannelBinding, channelBindingTags, channelsView, citationFromTags, citationSatisfied, citationToTag, currentControlWriteGroup, foldControlState, grantLocator, hex32, KIND_SEAL_ENCRYPTED, openWrap, parseEdition, Permissions, sealEdition, sealRumor, wrapSeal } from "@armada-bridge/concord-core";
import type { CommunityV2, StreamSigner } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";
import type { CommunityPolicy } from "./contracts";
import type { StoredDecision } from "./decisions";
import { controlState, verifiedEvent } from "./relayPolicy";
export class ConcordActions {
  constructor(readonly community: CommunityV2, readonly identity: { pk: string; signer: StreamSigner }, private readonly refresh: () => Promise<CommunityPolicy>) {
    if (identity.pk === community.owner) throw new Error("Moderation workload must not use the owner identity");
  }
  async authorize(decision: StoredDecision) {
    const policy = await this.refresh();
    if (decision.target.communityId !== this.community.idHex || policy.communityId !== this.community.idHex || decision.expiresAt.getTime() <= Date.now() || !policy.complete || policy.rekeyPending || policy.validUntil <= Date.now()) throw new Error("Current room authority unavailable");
    const state = controlState(policy);
    const channel = state.folded.channels.get(decision.target.channelId);
    if (state.folded.incomplete.length || !channel || channel.deleted || channel.metadata.private || policy.banned.includes(this.identity.pk) || state.folded.banned.has(this.identity.pk)) throw new Error("Current room authority unavailable");
    const permission = decision.action === "remove_message" ? Permissions.MANAGE_MESSAGES : Permissions.BAN;
    if (!canActOnMember(state.folded.roster, this.identity.pk, policy.owner, decision.author, permission)) throw new Error("Moderator lacks authority over this member");
    const entityId = grantLocator(this.community.id, hex32(this.identity.pk));
    const grant = state.folded.heads.get(bytesToHex(entityId));
    if (!grant) throw new Error("Moderator grant missing");
    const authority = { entityId, version: grant.version, editionHash: grant.hash };
    if (!citationSatisfied(state.folded, this.community.id, this.identity.pk, authority)) throw new Error("Moderator citation invalid");
    return { ...state, policy, authority };
  }
  async prepare(decision: StoredDecision): Promise<NostrEvent[]> {
    const { folded, authority } = await this.authorize(decision);
    let event: NostrEvent;
    if (decision.action === "remove_message") {
      const channel = channelsView(this.community, folded).find((channel) => channel.idHex === decision.target.channelId);
      if (!channel) throw new Error("Current channel key unavailable");
      const rumor = buildRumor({ pubkey: this.identity.pk, kind: 5, content: "", tags: [...channelBindingTags(channel.idHex, channel.current.epoch), ["e", decision.target.rumorId], citationToTag(authority)], ms: Date.now() });
      event = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, this.identity.signer), channel.current.group);
    } else {
      const banned = new Set(folded.banned);
      if (decision.action === "ban_member") banned.add(decision.author); else banned.delete(decision.author);
      const head = folded.heads.get(bytesToHex(banlistLocator(this.community.id)));
      const rumor = buildBanlistEdition(this.community.id, [...banned].sort(), { actorPubkey: this.identity.pk, version: (head?.version ?? 0n) + 1n, prevHash: head?.hash, authority });
      event = await sealEdition(rumor, currentControlWriteGroup(this.community), this.identity.signer);
    }
    // Deployment interoperability ceiling, not a new Concord ban-count rule.
    // Actual NIP-44 sealing above also refuses any oversized intermediate layer.
    if (Buffer.byteLength(JSON.stringify(["EVENT", event])) > 65_535) throw new Error("Concord moderation event exceeds supported wire size");
    await this.validatePrepared(decision, [event]);
    return [event];
  }
  async validatePrepared(decision: StoredDecision, events: NostrEvent[]): Promise<void> {
    const { editions, folded } = await this.authorize(decision);
    if (events.length !== 1) throw new Error("Unexpected moderation event set");
    const event = verifiedEvent(events[0]);
    if (decision.action === "remove_message") {
      const channel = channelsView(this.community, folded).find((c) => c.idHex === decision.target.channelId);
      const stream = channel?.streams.find((s) => s.group.pk === event.pubkey);
      if (!stream) throw new Error("Channel key changed");
      const opened = openWrap(event, stream.group);
      checkChannelBinding(opened, decision.target.channelId, stream.epoch);
      if (opened.sealKind !== KIND_SEAL_ENCRYPTED) throw new Error("Deletion seal must be encrypted");
      if (opened.author !== this.identity.pk || opened.kind !== 5 || opened.tags.filter((tag) => tag[0] === "e").length !== 1 || !opened.tags.some((tag) => tag[0] === "e" && tag[1] === decision.target.rumorId) || !citationSatisfied(folded, this.community.id, opened.author, citationFromTags(opened.tags))) throw new Error("Prepared deletion not authorized");
    } else {
      const opened = openWrap(event, currentControlWriteGroup(this.community));
      const edition = parseEdition(opened);
      if (opened.author !== this.identity.pk || bytesToHex(edition.entityId) !== bytesToHex(banlistLocator(this.community.id))) throw new Error("Prepared banlist has wrong authority or scope");
      const current = folded.heads.get(bytesToHex(edition.entityId));
      const alreadyApplied = current && bytesToHex(current.hash) === bytesToHex(edition.selfHash);
      if (!alreadyApplied && (edition.version !== (current?.version ?? 0n) + 1n || (current && (!edition.prevHash || bytesToHex(edition.prevHash) !== bytesToHex(current.hash))))) throw new Error("Prepared banlist would overwrite a concurrent edit");
      const next = foldControlState([...editions, edition], this.community.id, this.community.owner, folded.heads);
      const head = next.headEditions.get(bytesToHex(edition.entityId));
      if (!head || bytesToHex(head.selfHash) !== bytesToHex(edition.selfHash) || next.banned.has(decision.author) !== (decision.action === "ban_member")) throw new Error("Prepared banlist is stale or unauthorized");
    }
  }
}
