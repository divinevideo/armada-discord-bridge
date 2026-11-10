import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { buildChannelEdition, buildRoleEdition, bytesToHex, currentControlWriteGroup, hex32, moderatorRole, openWrap, random32, sealEdition, wrapSeal } from "@armada-bridge/concord-core";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { ConcordActions } from "./concordActions";
import { PolicyStore, migrateModeration } from "./policyStore";
import { PublicCapacityStore } from "./publicCapacity";
import { controlState, inspectRelayEvent } from "./relayPolicy";
import { observeWorkerAuthority } from "./workerMetrics";

const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
const validator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_validator" }, onnotice() {} });
const fixtures: { community: { idHex: string } }[] = [];
beforeAll(() => migrateModeration(sql));
afterAll(async () => {
  for (const f of fixtures) {
    await sql`DELETE FROM moderation.public_capacity_state WHERE community_id = ${f.community.idHex}`;
    await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`;
  }
  await validator.end(); await sql.end();
});
async function fixture() {
  const f = await moderationFixture(), org = crypto.randomUUID(), installer = new PolicyStore(sql);
  const communities = new Map([[f.community.idHex, org]]);
  await installer.install({ ...f.policy, rootEpoch: "0", controlEvents: [], banned: [], validUntil: Date.now() + 60_000 }, [f.controlStream, f.guestbookStream], 0);
  const capacity = new PublicCapacityStore(sql, undefined);
  await capacity.observeCurrent(org, f.community.idHex);
  const result = { ...f, org, installer, capacity, communities, guarded: new PolicyStore(validator, { capacity: { communities, contract: undefined } }) };
  fixtures.push(result);
  return result;
}
function role(f: Awaited<ReturnType<typeof fixture>>, name = "Setup role") {
  return sealEdition(buildRoleEdition({ ...moderatorRole(bytesToHex(random32())), name }, { actorPubkey: f.owner.pk, version: 1n }), currentControlWriteGroup(f.community), f.owner.signer);
}

test("the owner can initialize moderation without a load-test file, while ordinary writes remain closed", async () => {
  const f = await fixture();
  for (const event of f.policy.controlEvents.slice(0, 3)) expect((await f.guarded.admit(event)).action).toBe("accept");
  const policy = (await f.installer.getPolicy(f.community.idHex))!;
  expect(observeWorkerAuthority(f.community, f.moderator.pk, policy).available).toBe(true);
  expect(policy.controlEvents).toHaveLength(3);
  expect((await f.guarded.admit(f.policy.controlEvents[0])).action).toBe("accept");
  const rewrapped = wrapSeal(openWrap(f.policy.controlEvents[0], f.controlStream.key).seal, currentControlWriteGroup(f.community));
  expect((await f.guarded.admit(rewrapped)).action).toBe("reject");
  const profile = await f.owner.signer.signEvent({ kind: 0, content: "{}", tags: [], created_at: Math.floor(Date.now() / 1000) });
  expect((await f.guarded.admit(profile)).msg).toBe("rate-limited: room is at capacity, try again later");
  expect((await f.guarded.admit(f.unauthorizedControl)).action).toBe("reject");
  expect((await f.guarded.admit({ ...f.policy.controlEvents[0], sig: "0".repeat(128) })).action).toBe("reject");
});

test("setup has a durable count bound, including concurrent owner writes", async () => {
  const f = await fixture();
  for (let i = 0; i < 15; i++) expect((await f.guarded.admit(await role(f))).action).toBe("accept");
  const events = await Promise.all([role(f), role(f)]);
  expect((await Promise.all(events.map(e => f.guarded.admit(e)))).map(r => r.action).sort()).toEqual(["accept", "reject"]);
  expect((await f.installer.getPolicy(f.community.idHex))!.controlEvents).toHaveLength(16);
  expect((await new PolicyStore(validator, { capacity: { communities: f.communities, contract: undefined } }).admit(await role(f))).action).toBe("reject");
});

test("setup rejects oversized control history and honors an operator pause", async () => {
  const f = await fixture(), oversized = await sealEdition(buildChannelEdition(random32(), { name: "Setup", private: false, custom: { synthetic: "x".repeat(50_000) } }, { actorPubkey: f.owner.pk, version: 1n }), currentControlWriteGroup(f.community), f.owner.signer);
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(65_536);
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(100_000);
  expect((await f.guarded.admit(oversized)).action).toBe("reject");
  await f.capacity.pause({ orgId: f.org, communityId: f.community.idHex, reasonCode: "operator_pause" });
  expect((await f.guarded.admit(await role(f))).action).toBe("reject");
  expect((await f.installer.getPolicy(f.community.idHex))!.controlEvents).toHaveLength(0);
});

test("setup requires a fresh initial policy and cannot reactivate a previously configured deployment", async () => {
  const f = await fixture(), event = await role(f);
  await sql`UPDATE moderation.community_policy SET payload = payload || '{"validUntil":0}'::jsonb WHERE community_id = ${f.community.idHex}`;
  expect((await f.guarded.admit(event)).action).toBe("reject");
  await sql`UPDATE moderation.community_policy SET payload = payload || ${sql.json({ validUntil: Date.now() + 60_000 })} WHERE community_id = ${f.community.idHex}`;
  await sql`UPDATE moderation.public_capacity_state SET contract_hash = ${"1".repeat(64)}, state = 'unknown' WHERE community_id = ${f.community.idHex}`;
  expect((await f.guarded.admit(event)).action).toBe("reject");
});

test("setup refuses stale observations, later root epochs and existing message traffic", async () => {
  const f = await fixture(), event = await role(f);
  await sql`UPDATE moderation.public_capacity_state SET observed_at = clock_timestamp() - interval '1 minute' WHERE community_id = ${f.community.idHex}`;
  expect((await f.guarded.admit(event)).action).toBe("reject");
  await f.capacity.observeCurrent(f.org, f.community.idHex);
  await sql`UPDATE moderation.community_policy SET payload = payload || '{"rootEpoch":"1"}'::jsonb WHERE community_id = ${f.community.idHex}`;
  expect((await f.guarded.admit(event)).action).toBe("reject");
  await sql`UPDATE moderation.community_policy SET payload = payload || '{"rootEpoch":"0"}'::jsonb WHERE community_id = ${f.community.idHex}`;
  const current = (await f.installer.getPolicy(f.community.idHex))!;
  await f.installer.install({ ...current, revision: current.revision + 1, controlEvents: f.policy.controlEvents, validUntil: Date.now() + 60_000 }, [f.controlStream, f.guestbookStream, f.chatStream], current.revision);
  expect((await f.installer.admit(f.allowed)).action).toBe("accept");
  expect((await f.guarded.admit(event)).action).toBe("reject");
});

test("delegated moderation and later editions still need normal capacity admission", async () => {
  const f = await fixture();
  for (const event of f.policy.controlEvents.slice(0, 3)) expect((await f.guarded.admit(event)).action).toBe("accept");
  const policy = (await f.installer.getPolicy(f.community.idHex))!;
  await f.installer.install({ ...policy, revision: policy.revision + 1, validUntil: Date.now() + 60_000 }, [f.controlStream, f.guestbookStream, f.chatStream], policy.revision);
  const actions = new ConcordActions(f.community, { pk: f.moderator.pk, signer: f.moderator.signer }, () => f.installer.getPolicy(f.community.idHex) as any);
  const ban = (await actions.prepare({ ...f.decision, action: "ban_member" }))[0];
  const current = (await f.installer.getPolicy(f.community.idHex))!;
  expect((await inspectRelayEvent(ban, { policy: current, stream: f.controlStream, now: Date.now, isRemoved: async () => false, authorOf: async () => undefined })).result.action).toBe("accept");
  expect((await f.guarded.admit(ban)).action).toBe("reject");
  expect((await f.guarded.admit(f.allowed)).action).toBe("reject");
  const head = controlState(current).folded.heads.get(f.channelId)!;
  const edit = await sealEdition(buildChannelEdition(hex32(f.channelId), { name: "Changed", private: false }, { actorPubkey: f.owner.pk, version: 2n, prevHash: head.hash }), currentControlWriteGroup(f.community), f.owner.signer);
  expect((await inspectRelayEvent(edit, { policy: current, stream: f.controlStream, now: Date.now, isRemoved: async () => false, authorOf: async () => undefined })).result.action).toBe("accept");
  expect((await f.guarded.admit(edit)).action).toBe("reject");
});
