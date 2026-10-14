import { expect, test } from "bun:test";
import { generateSecretKey } from "nostr-tools/pure";
import { buildRoleEdition, buildGrantEdition, buildBanlistEdition, moderatorRole, currentControlWriteGroup, sealEdition, openWrap, grantLocator, bytesToHex, parseEdition, foldControlState } from "@armada-bridge/concord-core";
import { localIdentity } from "../../bridge/src/concord/signer";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { ConcordActions } from "./concordActions";
import type { StoredDecision } from "./decisions";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";

test("moderation uses current grants and valid citations; owner and peers are protected", async () => {
  const f = await moderationFixture();
  const actions = new ConcordActions(f.community, f.moderator, async () => f.policy);
  const [event] = await actions.prepare(f.decision);
  const opened = openWrap(event, f.chatStream.key);
  expect(opened.kind).toBe(5);
  expect(opened.author).toBe(f.moderator.pk);
  expect(opened.tags.find((tag) => tag[0] === "vac")?.[1]).toBe(bytesToHex(grantLocator(f.community.id, Buffer.from(f.moderator.pk, "hex"))));
  await expect(actions.authorize({ ...f.decision, author: f.owner.pk })).rejects.toThrow();
  await expect(actions.authorize({ ...f.decision, author: f.moderator.pk })).rejects.toThrow();
  f.policy.complete = false;
  await expect(actions.authorize(f.decision)).rejects.toThrow();
});
test("a revoked moderator cannot publish, and a ban preserves existing entries", async () => {
  const f = await moderationFixture();
  const actions = new ConcordActions(f.community, f.moderator, async () => f.policy);
  const [event] = await actions.prepare({ ...f.decision, action: "ban_member" });
  const edition = parseEdition(openWrap(event, f.controlStream.key));
  expect(JSON.parse(edition.content)).toContain(f.member.pk);
  expect(JSON.parse(edition.content)).toContain(f.bannedMember.pk);
  const editions = f.policy.controlEvents.map((wrap) => parseEdition(openWrap(wrap, f.controlStream.key)));
  const folded = foldControlState([...editions, edition], f.community.id, f.owner.pk);
  expect(folded.banned.has(f.member.pk)).toBe(true);
  const grant = editions.find((item) => bytesToHex(item.entityId) === bytesToHex(grantLocator(f.community.id, Buffer.from(f.moderator.pk, "hex"))))!;
  const revoke = await sealEdition(buildGrantEdition(f.community.id, { member: f.moderator.pk, roleIds: [] }, { actorPubkey: f.owner.pk, version: 2n, prevHash: grant.selfHash }), currentControlWriteGroup(f.community), f.owner.signer);
  f.policy.controlEvents.push(revoke);
  await expect(actions.prepare(f.decision)).rejects.toThrow();
});

test("a competing banlist edit makes a prepared action stale instead of overwriting it", async () => {
  const f = await moderationFixture();
  const actions = new ConcordActions(f.community, f.moderator, async () => f.policy);
  const decision = { ...f.decision, action: "ban_member" as const };
  const events = await actions.prepare(decision);
  const candidate = parseEdition(openWrap(events[0], f.controlStream.key));
  const competing = await sealEdition(buildBanlistEdition(f.community.id, [f.bannedMember.pk, "ef".repeat(32)], { actorPubkey: f.owner.pk, version: candidate.version, prevHash: candidate.prevHash }), currentControlWriteGroup(f.community), f.owner.signer);
  f.policy.controlEvents.push(competing);
  await expect(actions.validatePrepared(decision, events)).rejects.toThrow();
});
test("a large canonical banlist yields a visible preparation failure without truncating members", async () => {
  const f = await moderationFixture();
  const head = parseEdition(openWrap(f.policy.controlEvents.at(-1)!, f.controlStream.key));
  const members = Array.from({ length: 600 }, (_, index) => index.toString(16).padStart(64, "0"));
  const full = await sealEdition(buildBanlistEdition(f.community.id, members, { actorPubkey: f.owner.pk, version: 2n, prevHash: head.selfHash }), currentControlWriteGroup(f.community), f.owner.signer);
  f.policy.controlEvents.push(full);
  const actions = new ConcordActions(f.community, f.moderator, async () => f.policy);
  await expect(actions.prepare({ ...f.decision, action: "ban_member" })).rejects.toThrow();
  expect(JSON.parse(parseEdition(openWrap(full, f.controlStream.key)).content)).toHaveLength(600);
});
