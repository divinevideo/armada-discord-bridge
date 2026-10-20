import { base64ToBytes, baseRekeyGroupKey, bytesToHex, canActOnMember, checkContinuity, citationSatisfied, decodeWrappedBaseKey, findBlob, groupRotations, isAuthorized, myLocator, openWrap, parseRekey, rotationPublishedAtMs, Permissions } from "@armada-bridge/concord-core";
import type { CommunityV2 } from "@armada-bridge/concord-core";
import type { LocalIdentity } from "../../bridge/src/concord/signer";
import type { NostrEvent } from "nostr-tools/pure";
import type { CommunityPolicy } from "./contracts";
import { controlState, verifiedEvent } from "./relayPolicy";
/** Rekey recovery is explicit: a changed mounted community entry must match a
 * complete authorized rotation and the moderation member's own decrypted blob. */
export async function verifyRecoveredRoot(community: CommunityV2, identity: LocalIdentity, previous: CommunityPolicy, events: NostrEvent[]): Promise<void> {
  const held = community.heldRoots.find((root) => root.epoch === BigInt(previous.rootEpoch ?? "0"));
  if (!held || community.rootEpoch !== held.epoch + 1n) throw new Error("Rekey continuity material missing");
  const { folded } = controlState(previous);
  if (folded.incomplete.length) throw new Error("Rekey authority incomplete");
  const group = baseRekeyGroupKey(held.key, community.id, community.rootEpoch);
  const parsed = [];
  for (const raw of events) {
    try { parsed.push(parseRekey(openWrap(verifiedEvent(raw), group))); } catch { /* Unrelated candidates are not rotations. */ }
  }
  const winners: { root: Uint8Array; controlPk?: string; controlRoot?: Uint8Array; rotator: string; retiredAt: number }[] = [];
  for (const rotation of groupRotations(parsed)) {
    if (!rotation.complete || rotation.scopeIdHex !== "0".repeat(64) || rotation.newEpoch !== community.rootEpoch || !checkContinuity(rotation, held.epoch, held.key).ok || folded.banned.has(rotation.rotator) || !isAuthorized(folded.roster, rotation.rotator, community.owner, Permissions.BAN) || !citationSatisfied(folded, community.id, rotation.rotator, rotation.authority)) continue;
    // Every chunk must cite the same grant; grouping by coordinates alone does not prove that.
    if ([...rotation.chunks.values()].some((chunk) => JSON.stringify(chunk.authority, (_, value) => typeof value === "bigint" ? value.toString() : value) !== JSON.stringify(rotation.authority, (_, value) => typeof value === "bigint" ? value.toString() : value))) continue;
    const protectedMembers = new Set([community.owner, ...folded.roster.grants.map((grant) => grant.member)].filter((member) => !canActOnMember(folded.roster, rotation.rotator, community.owner, member, Permissions.BAN)));
    if ([...protectedMembers].some((member) => !findBlob(rotation, myLocator(rotation.rotator, member, rotation.scopeIdHex, rotation.newEpoch)))) continue;
    const own = findBlob(rotation, myLocator(rotation.rotator, identity.pk, rotation.scopeIdHex, rotation.newEpoch));
    if (!own) continue;
    try {
      const material = decodeWrappedBaseKey(base64ToBytes(await identity.signer.nip44.decrypt(rotation.rotator, own.wrapped)), community.id, rotation.newEpoch);
      winners.push({ root: material.newRoot, controlPk: material.controlPk, controlRoot: material.controlRoot, rotator: rotation.rotator, retiredAt: Math.floor(rotationPublishedAtMs(rotation) / 1000) });
    } catch { /* Invalid member blobs never authorize key replacement. */ }
  }
  winners.sort((a, b) => bytesToHex(a.root).localeCompare(bytesToHex(b.root)));
  const winner = winners[0];
  if (!winner || held.retiredAt !== winner.retiredAt || bytesToHex(winner.root) !== bytesToHex(community.root) || winner.controlPk !== community.controlPk || winner.rotator !== community.refounder || !winner.controlRoot || !community.controlRoot || bytesToHex(winner.controlRoot) !== bytesToHex(community.controlRoot)) throw new Error("Mounted rekey material is not the complete authorized winning rotation");
}
