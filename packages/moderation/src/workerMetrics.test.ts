import { expect, test } from "bun:test";
import type postgres from "postgres";
import { banlistLocator, buildGrantEdition, buildBanlistEdition, buildChannelEdition, buildRoleEdition, moderatorRole, Permissions, bytesToHex, currentControlWriteGroup, grantLocator, hex32, sealEdition } from "@armada-bridge/concord-core";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { controlState } from "./relayPolicy";
import { observeWorkerAuthority, workerMetricsResponse } from "./workerMetrics";

test("worker authority observes the verified current grant and expires without another refresh", async () => {
  const f = await moderationFixture();
  const observation = observeWorkerAuthority(f.community, f.moderator.pk, f.policy);
  expect(observation.available).toBe(true);
  const sql = (async () => []) as unknown as postgres.Sql;
  expect(await (await workerMetricsResponse(sql, observation)).text()).toBe("# TYPE concord_worker_authority_available gauge\nconcord_worker_authority_available 1\n");
  expect(await (await workerMetricsResponse(sql, observation, f.policy.validUntil)).text()).toBe("# TYPE concord_worker_authority_available gauge\nconcord_worker_authority_available 0\n");
  expect(await (await workerMetricsResponse(sql, undefined)).text()).toBe("# TYPE concord_worker_authority_available gauge\nconcord_worker_authority_available 0\n");
});

test("revoked or missing grants and banned workers cannot report authority", async () => {
  const f = await moderationFixture();
  const state = controlState(f.policy);
  const grantId = bytesToHex(grantLocator(f.community.id, hex32(f.moderator.pk)));
  const grant = state.folded.heads.get(grantId)!;
  const revoked = await sealEdition(buildGrantEdition(f.community.id, { member: f.moderator.pk, roleIds: [] }, { actorPubkey: f.owner.pk, version: 2n, prevHash: grant.hash }), currentControlWriteGroup(f.community), f.owner.signer);
  expect(observeWorkerAuthority(f.community, f.moderator.pk, { ...f.policy, controlEvents: [...f.policy.controlEvents, revoked] }).available).toBe(false);
  expect(observeWorkerAuthority(f.community, f.member.pk, f.policy).available).toBe(false);
  const banned = await sealEdition(buildBanlistEdition(f.community.id, [f.moderator.pk], { actorPubkey: f.owner.pk, version: 2n, prevHash: state.folded.heads.get(bytesToHex(banlistLocator(f.community.id)))!.hash }), currentControlWriteGroup(f.community), f.owner.signer);
  const bannedPolicy = { ...f.policy, controlEvents: [...f.policy.controlEvents, banned] };
  expect(controlState(bannedPolicy).folded.banned.has(f.moderator.pk)).toBe(true);
  expect(controlState(bannedPolicy).folded.incomplete).toHaveLength(0);
  expect(observeWorkerAuthority(f.community, f.moderator.pk, bannedPolicy).available).toBe(false);
  expect(observeWorkerAuthority(f.community, f.moderator.pk, { ...f.policy, banned: [f.moderator.pk] }).available).toBe(false);
});

test("a caller's fold of the policy is used instead of folding the control history again", async () => {
  const f = await moderationFixture();
  const grant = controlState(f.policy).folded.heads.get(bytesToHex(grantLocator(f.community.id, hex32(f.moderator.pk))))!;
  const revoked = await sealEdition(buildGrantEdition(f.community.id, { member: f.moderator.pk, roleIds: [] }, { actorPubkey: f.owner.pk, version: 2n, prevHash: grant.hash }), currentControlWriteGroup(f.community), f.owner.signer);
  // Deliberately mismatched: only the passed fold carries the revocation.
  const { folded } = controlState({ ...f.policy, controlEvents: [...f.policy.controlEvents, revoked] });
  expect(observeWorkerAuthority(f.community, f.moderator.pk, f.policy).available).toBe(true);
  expect(observeWorkerAuthority(f.community, f.moderator.pk, f.policy, Date.now(), folded).available).toBe(false);
});

test("missing write key, stale, incomplete, rekey and unverified policy never report authority", async () => {
  const f = await moderationFixture();
  expect(observeWorkerAuthority({ ...f.community, controlRoot: undefined }, f.moderator.pk, f.policy).available).toBe(false);
  // Corrupt the whole set rather than keep one event: a lone event lacks the
  // role and grant, so it would fail without any signature being checked.
  const unverified = { ...f.policy, controlEvents: f.policy.controlEvents.map((event) => ({ ...event, sig: "0".repeat(128) })) };
  for (const policy of [{ ...f.policy, validUntil: Date.now() - 1 }, { ...f.policy, complete: false }, { ...f.policy, rekeyPending: true }, unverified]) {
    expect(observeWorkerAuthority(f.community, f.moderator.pk, policy).available).toBe(false);
  }
  const gap = await sealEdition(buildChannelEdition(hex32(f.channelId), { name: "gap", private: false }, { actorPubkey: f.owner.pk, version: 3n, prevHash: hex32("ab".repeat(32)) }), currentControlWriteGroup(f.community), f.owner.signer);
  const incomplete = { ...f.policy, controlEvents: [...f.policy.controlEvents, gap] };
  expect(controlState(incomplete).folded.incomplete.length).toBeGreaterThan(0);
  expect(observeWorkerAuthority(f.community, f.moderator.pk, incomplete).available).toBe(false);
});

test("worker SQL failure fails the scrape instead of publishing a healthy cached observation", async () => {
  const sql = (async () => { throw new Error("private connection detail"); }) as unknown as postgres.Sql;
  const response = await workerMetricsResponse(sql, { available: true, validUntil: Date.now() + 60_000 });
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("unavailable");
});

test("both moderation permissions and the matching control write key are required", async () => {
  const f = await moderationFixture();
  const roleHead = controlState(f.policy).folded.heads.get(f.roleId)!;
  for (const permissions of [Permissions.BAN, Permissions.MANAGE_MESSAGES]) {
    const narrowed = await sealEdition(buildRoleEdition({ ...moderatorRole(f.roleId), permissions }, { actorPubkey: f.owner.pk, version: 2n, prevHash: roleHead.hash }), currentControlWriteGroup(f.community), f.owner.signer);
    const policy = { ...f.policy, controlEvents: [...f.policy.controlEvents, narrowed] };
    expect(controlState(policy).folded.incomplete).toHaveLength(0);
    expect(observeWorkerAuthority(f.community, f.moderator.pk, policy).available).toBe(false);
  }
  expect(observeWorkerAuthority({ ...f.community, controlRoot: new Uint8Array(32).fill(7) }, f.moderator.pk, f.policy).available).toBe(false);
  expect(observeWorkerAuthority(f.community, f.owner.pk, f.policy).available).toBe(false);
});
