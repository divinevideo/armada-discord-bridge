import { bytesToHex, canActOnMember, checkChannelBinding, citationFromTags, citationSatisfied, communityIdOf, foldControlState, hex32, isAuthorized, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT, openWrap, parseEdition, parseRekey, Permissions } from "@armada-bridge/concord-core";
import type { ParsedEdition } from "@armada-bridge/concord-core";
import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import type { AdmissionContext, AdmissionResult, CarrierRecord, CommunityPolicy, RoomTarget } from "./contracts";
import { ControlEditionCache } from "./controlEditionCache";

export const MAX_EVENT_BYTES = 100_000;
export const HEX_ID = /^[0-9a-f]{64}$/;
const CHAT_KINDS = new Set([9, 1111, 7, 5, 3302, 1740, 23311]);
const PUBLIC_KINDS = new Set([0, 10050, 10304, 30030, 33301]);
const controlEditions = new ControlEditionCache();

function requireThat(condition: unknown): asserts condition {
  if (!condition) throw new Error("policy rejected");
}
/** Strip verification memo symbols and validate the actual bytes every time. */
export function verifiedEvent(input: NostrEvent): NostrEvent {
  const serialized = JSON.stringify(input);
  requireThat(Buffer.byteLength(serialized) <= MAX_EVENT_BYTES);
  const event = JSON.parse(serialized) as NostrEvent;
  requireThat(verifyEvent(event));
  requireThat(event.tags.length <= 256 && event.tags.every((tag) => tag.length <= 16));
  return event;
}

export function controlState(policy: CommunityPolicy) {
  requireThat(HEX_ID.test(policy.communityId) && HEX_ID.test(policy.owner) && HEX_ID.test(policy.ownerSalt));
  requireThat(bytesToHex(communityIdOf(hex32(policy.owner), hex32(policy.ownerSalt))) === policy.communityId);
  requireThat(policy.controlEvents.length <= 4096 && policy.controlStreams.length > 0);
  const editions: ParsedEdition[] = [];
  for (const raw of policy.controlEvents) {
    const descriptor = policy.controlStreams.find((s) => s.key.pk === raw.pubkey);
    requireThat(descriptor && descriptor.plane === "control" && descriptor.communityId === policy.communityId && !("sk" in descriptor.key));
    editions.push(controlEditions.read(raw, descriptor, () => parseEdition(openWrap(verifiedEvent(raw), descriptor.key))));
  }
  return { editions, folded: foldControlState(editions, hex32(policy.communityId), policy.owner) };
}

export async function inspectRelayEvent(input: NostrEvent, context: AdmissionContext): Promise<{ result: AdmissionResult; carrier?: CarrierRecord; references?: { target: RoomTarget; eventId: string; ids: string[] }; observedAuthor?: string; control?: NostrEvent; removals?: RoomTarget[]; rekey?: { communityId: string; epoch: string; event: NostrEvent }; retraction?: boolean }> {
  const id = typeof input?.id === "string" && HEX_ID.test(input.id) ? input.id : "0".repeat(64);
  const reject: AdmissionResult = { id, action: "reject", msg: "blocked: room policy unavailable or event not permitted" };
  let references: { target: RoomTarget; eventId: string; ids: string[] } | undefined;
  try {
    const event = verifiedEvent(input);
    const policy = context.policy;
    requireThat(policy && Number.isSafeInteger(policy.revision) && policy.revision > 0);
    const { editions, folded } = controlState(policy);
    const fresh = policy.complete && folded.incomplete.length === 0 && context.now() < policy.validUntil;
    requireThat(!policy.banned.includes(policy.owner));
    const banned = new Set([...policy.banned, ...folded.banned]);
    const accept: AdmissionResult = { id, action: "accept" };
    if (event.kind !== 1059 && event.kind !== 21059) {
      requireThat(fresh && PUBLIC_KINDS.has(event.kind) && !banned.has(event.pubkey));
      if (event.kind === 33301) {
        requireThat(folded.liveInviteLinks.has(event.pubkey));
        const d = event.tags.filter((t) => t[0] === "d");
        requireThat(d.length === 1 && d[0][1] === "");
      } else {
        requireThat(policy.publicAuthors.includes(event.pubkey) || context.publicAuthorKnown);
      }
      return { result: accept };
    }
    const descriptor = context.stream;
    requireThat(descriptor && descriptor.communityId === policy.communityId && descriptor.key.pk === event.pubkey && !("sk" in descriptor.key));
    requireThat(descriptor.key.convKey.length === 32 && /^(0|[1-9][0-9]*)$/.test(descriptor.epoch));
    const opened = openWrap(event, descriptor.key);
    if (descriptor.plane === "chat" && descriptor.channelId && [3302, 7].includes(opened.kind) && opened.sealKind === KIND_SEAL_ENCRYPTED && event.kind === 1059) {
      checkChannelBinding(opened, descriptor.channelId, BigInt(descriptor.epoch));
      // Verified recovery metadata is independent of current author admission:
      // a banned author's already stored edits must still be discoverable.
      const referenced = opened.tags.find((tag) => tag[0] === "e")?.[1];
      references = { target: { communityId: policy.communityId, channelId: descriptor.channelId, rumorId: opened.rumorId }, eventId: event.id,
        ids: referenced && HEX_ID.test(referenced) ? [referenced] : [] };
    }
    if (descriptor.plane !== "chat") requireThat(!event.tags.some((tag) => tag[0] === "expiration") && !opened.tags.some((tag) => tag[0] === "expiration"));
    if (descriptor.plane === "control") {
      requireThat(event.kind === 1059 && opened.sealKind === KIND_SEAL_PLAINTEXT && opened.kind === 3308);
      requireThat(!opened.tags.some((tag) => tag[0] === "channel" || tag[0] === "epoch"));
      requireThat(opened.author === policy.owner || (fresh && !banned.has(opened.author)));
      const candidate = parseEdition(opened);
      const next = foldControlState([...editions, candidate], hex32(policy.communityId), policy.owner, folded.heads);
      const head = next.headEditions.get(bytesToHex(candidate.entityId));
      requireThat(head && bytesToHex(head.selfHash) === bytesToHex(candidate.selfHash));
      return { result: accept, control: event };
    }
    requireThat(fresh && !banned.has(opened.author) && opened.sealKind === KIND_SEAL_ENCRYPTED);
    if (descriptor.plane === "rekey") {
      requireThat(event.kind === 1059);
      const rotation = parseRekey(opened);
      requireThat(rotation.scopeIdHex === "0".repeat(64) && rotation.newEpoch.toString() === descriptor.epoch && rotation.prevEpoch.toString() === descriptor.previousEpoch && rotation.prevCommit === descriptor.previousCommit);
      requireThat(rotation.newEpoch === rotation.prevEpoch + 1n && rotation.chunkCount <= 1024);
      requireThat(isAuthorized(folded.roster, opened.author, policy.owner, Permissions.BAN) && citationSatisfied(folded, hex32(policy.communityId), opened.author, rotation.authority));
      return { result: accept, rekey: { communityId: policy.communityId, epoch: descriptor.epoch, event } };
    }
    if (descriptor.plane === "guestbook") {
      requireThat(event.kind === 1059 && !opened.tags.some((tag) => tag[0] === "channel" || tag[0] === "epoch"));
      if (opened.kind === 3306) requireThat(opened.content === "join" || opened.content === "leave");
      else if (opened.kind === 3309) {
        const targets = opened.tags.filter((tag) => tag[0] === "p");
        requireThat(targets.length === 1 && HEX_ID.test(targets[0][1]));
        requireThat(citationSatisfied(folded, hex32(policy.communityId), opened.author, citationFromTags(opened.tags)));
        requireThat(canActOnMember(folded.roster, opened.author, policy.owner, targets[0][1], Permissions.KICK));
      } else if (opened.kind === 3312) {
        requireThat(policy.snapshotAuthorities.includes(opened.author));
        const members = JSON.parse(opened.content);
        requireThat(Array.isArray(members) && members.length <= 400 && members.every((member) => typeof member === "string" && HEX_ID.test(member)));
      } else return { result: reject };
      // A self-signed Leave only withdraws its author (an additive signal for
      // the capacity gate, never an admission grant).
      return { result: accept, observedAuthor: opened.kind === 3306 && opened.content === "join" ? opened.author : undefined, retraction: opened.kind === 3306 && opened.content === "leave" };
    }
    requireThat(!policy.rekeyPending);
    requireThat(descriptor.plane === "chat" && descriptor.channelId && CHAT_KINDS.has(opened.kind));
    const channel = folded.channels.get(descriptor.channelId);
    requireThat(channel && !channel.deleted && !channel.metadata.private);
    checkChannelBinding(opened, descriptor.channelId, BigInt(descriptor.epoch));
    requireThat(descriptor.retiredAt === undefined || opened.createdAt <= descriptor.retiredAt);
    requireThat((opened.kind === 23311) === (event.kind === 21059));
    const target: RoomTarget = { communityId: policy.communityId, channelId: descriptor.channelId, rumorId: opened.rumorId };
    const targetRumorIds = references?.ids ?? [];
    // Recovery may need to reindex an already stored edit even when its target
    // is now removed. These are verified references, never an admission grant.
    requireThat(!(await context.isRemoved(target)));
    for (const rumorId of targetRumorIds) requireThat(!(await context.isRemoved({ ...target, rumorId })));
    let selfAuthored = false;
    if (opened.kind === 5 || opened.kind === 3302) {
      const targets = opened.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1]);
      requireThat(targets.length > 0 && targets.length <= 100 && targets.every((value) => HEX_ID.test(value)));
      selfAuthored = true;
      for (const rumorId of targets) {
        const author = await context.authorOf({ ...target, rumorId });
        requireThat(author && (author === opened.author || (opened.kind === 5 && citationSatisfied(folded, hex32(policy.communityId), opened.author, citationFromTags(opened.tags)) && canActOnMember(folded.roster, opened.author, policy.owner, author, Permissions.MANAGE_MESSAGES))));
        if (author !== opened.author) selfAuthored = false;
      }
    }
    if (opened.kind === 1740) requireThat(isAuthorized(folded.roster, opened.author, policy.owner, Permissions.MANAGE_METADATA));
    const expiration = opened.tags.filter((tag) => tag[0] === "expiration");
    const outerExpiration = event.tags.filter((tag) => tag[0] === "expiration");
    requireThat(expiration.length <= 1 && outerExpiration.length === expiration.length);
    if (expiration.length) requireThat(outerExpiration[0][1] === expiration[0][1] && ![5, 1740, 23311].includes(opened.kind));
    const expiresAt = expiration.length ? Number(expiration[0][1]) * 1000 : undefined;
    if (expiration.length) requireThat(/^[0-9]+$/.test(expiration[0][1]) && Number.isSafeInteger(expiresAt) && expiresAt! > context.now());
    requireThat(context.now() < policy.validUntil);
    return { result: accept, references, observedAuthor: opened.author, retraction: opened.kind === 5 && selfAuthored, removals: opened.kind === 5 ? opened.tags.filter((tag) => tag[0] === "e").map((tag) => ({ ...target, rumorId: tag[1] })) : undefined, carrier: { ...target, eventId: event.id, author: opened.author, kind: opened.kind, expiresAt, policyRevision: policy.revision, targetRumorIds } };
  } catch {
    return { result: reject, references };
  }
}

export async function evaluateRelayEvent(event: NostrEvent, context: AdmissionContext): Promise<AdmissionResult> {
  return (await inspectRelayEvent(event, context)).result;
}
