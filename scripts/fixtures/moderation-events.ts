import { generateSecretKey } from "nostr-tools/pure";
import { buildRoleEdition, buildGrantEdition, buildBanlistEdition, moderatorRole, currentControlWriteGroup, sealEdition, openWrap, grantLocator, bytesToHex, parseEdition, foldControlState } from "@armada-bridge/concord-core";
import { localIdentity } from "../../packages/bridge/src/concord/signer";
import { relayFixture } from "./relay-events";
import type { StoredDecision } from "../../packages/moderation/src/decisions";
export async function moderationFixture() {
  const f = await relayFixture(), moderator = localIdentity(generateSecretKey());
  const roleId = "de".repeat(32);
  const common = { actorPubkey: f.owner.pk, version: 1n };
  const role = await sealEdition(buildRoleEdition(moderatorRole(roleId), common), currentControlWriteGroup(f.community), f.owner.signer);
  const grant = await sealEdition(buildGrantEdition(f.community.id, { member: moderator.pk, roleIds: [roleId] }, common), currentControlWriteGroup(f.community), f.owner.signer);
  const banlist = await sealEdition(buildBanlistEdition(f.community.id, [f.bannedMember.pk], common), currentControlWriteGroup(f.community), f.owner.signer);
  const policy = { ...f.policy, controlEvents: [...f.policy.controlEvents, role, grant, banlist] };
  const decision: StoredDecision = { decisionId: crypto.randomUUID(), orgId: "synthetic", caseId: crypto.randomUUID(), target: { communityId: f.community.idHex, channelId: f.channelId, rumorId: f.allowedRumorId }, author: f.member.pk, action: "remove_message", discordGuildConfirmed: false, expiresAt: new Date(Date.now() + 60_000) };
  return { ...f, moderator, policy, decision, roleId };
}
