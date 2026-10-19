import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { observeWorkerCapacity } from "./runtime";
import { collectMetrics } from "./metrics";
import { PolicyStore, migrateModeration } from "./policyStore";
import { PublicCapacityGuard, PublicCapacityStore, evaluatePublicCapacity, assertPublicChatAllowed, type PublicCapacitySnapshot } from "./publicCapacity";
import { ConcordActions } from "./concordActions";
import { controlState } from "./relayPolicy";
import { buildRoleEdition, moderatorRole, sealEdition, currentControlWriteGroup, buildRumor, channelBindingTags, sealRumor, KIND_SEAL_ENCRYPTED } from "@armada-bridge/concord-core";
import { wrapSeal } from "@armada-bridge/concord-core";
import type { PublicCapacityContract } from "./capacityContract";
const contract = { sourceSha: "1".repeat(40), platform: "linux/amd64", maxima: { historyCount: 128, historyBytes: 1000000, rekeyCount: 16, streamCount: 64, inFlight: 4, innerAdmissionMs: 1000 }, thresholds: { warningHistoryCount: 32, pauseHistoryCount: 64, urgentReserve: 16 }, maxSampleAgeMs: 30000 } as PublicCapacityContract;
const org = crypto.randomUUID(), f = await moderationFixture(), communities = new Map([[f.community.idHex, org]]);
const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
const sample = (count = 1): PublicCapacitySnapshot => ({ orgId: org, communityId: f.community.idHex, observedAt: Date.now(), historyCount: count, historyBytes: 1000, rekeyCount: 0, streamCount: 3, inFlight: 1, innerAdmissionMs: 1 });
beforeAll(async () => { await migrateModeration(sql); await new PolicyStore(sql).install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0); });
afterAll(async () => { await sql`DELETE FROM moderation.public_capacity_state WHERE org_id = ${org}`; await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`; await sql.end(); });
test("pure capacity boundary counts overshoot, rejects stale/invalid samples and never guesses a contract", () => {
 expect(evaluatePublicCapacity(sample(), contract, Date.now()).state).toBe("normal");
 expect(evaluatePublicCapacity(sample(32), contract, Date.now()).state).toBe("warning");
 const paused = evaluatePublicCapacity(sample(63), contract, Date.now()); expect(paused.state).toBe("paused"); expect(() => assertPublicChatAllowed(paused)).toThrow();
 expect(evaluatePublicCapacity({ ...sample(), observedAt: 1 }, contract, Date.now()).state).toBe("unknown");
 expect(evaluatePublicCapacity({ ...sample(), historyBytes: NaN }, contract, Date.now()).state).toBe("unknown");
 expect(evaluatePublicCapacity(sample(), undefined, Date.now()).state).toBe("unknown");
 expect(evaluatePublicCapacity(sample(80), contract, Date.now()).remainingBudget).toBe(0);
});
test("durable pause survives restart, missing contract and fresh low sample until explicit resume", async () => {
 const store = new PublicCapacityStore(sql, contract); expect((await store.observe(sample())).state).toBe("normal");
 await store.pause({ orgId: org, communityId: f.community.idHex, reasonCode: "operator_pause" });
 expect((await new PublicCapacityStore(sql, contract).observe(sample())).state).toBe("paused");
 expect((await new PublicCapacityStore(sql, undefined).observe(sample())).state).toBe("paused");
 await expect(store.resume({ orgId: org, communityId: f.community.idHex, actorId: "synthetic-operator", contractHash: "0".repeat(64) })).rejects.toThrow();
 expect((await store.resume({ orgId: org, communityId: f.community.idHex, actorId: "synthetic-operator", contractHash: store.contractHash! })).state).toBe("normal");
});
test("native admission fails closed before carrier mutation; finite reserve keeps only authorized moderation", async () => {
 const capacity = new PublicCapacityStore(sql, contract); await capacity.observeCurrent(org, f.community.idHex);
 const guarded = new PolicyStore(sql, { capacity: { communities, contract } });
 expect((await guarded.admit(f.allowed)).action).toBe("accept");
 await capacity.pause({ orgId: org, communityId: f.community.idHex, reasonCode: "operator_pause" });
 const extra = wrapSeal(f.allowedSeal, f.chatKey); expect((await guarded.admit(extra)).action).toBe("reject");
 expect((await sql`SELECT 1 FROM moderation.carriers WHERE event_id = ${extra.id}`).length).toBe(0);
 expect((await new PolicyStore(sql, { capacity: { communities, contract: undefined } }).admit(f.allowed)).action).toBe("reject");
});

test("worker observes counts with operator authority, validator is read-only after repeated bootstrap", async () => {
 await migrateModeration(sql);
 const operator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
 try { await observeWorkerCapacity(operator, { communities, contract }, f.community.idHex); } finally { await operator.end(); }
 const [row] = await sql`SELECT * FROM moderation.public_capacity_state WHERE org_id = ${org}`;
 expect(Number(row.history_count)).toBe(f.policy.controlEvents.length); expect(row.gate_elapsed_ms).toBeNull();
 await sql.begin(async tx => { await tx.unsafe("SET LOCAL ROLE moderation_validator"); expect((await tx`SELECT state FROM moderation.public_capacity_state WHERE org_id = ${org}`).length).toBe(1); });
 for (const role of ["moderation_validator", "moderation_api", "moderation_reports"]) {
   await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.public_capacity_state SET state = 'normal' WHERE org_id = ${org}`; })).rejects.toThrow();
 }
 const metrics = await collectMetrics(sql); expect(metrics).toContain("concord_public_capacity_paused 1\n"); expect(metrics).toContain("concord_public_capacity_history_bytes "); expect(metrics).toContain("concord_public_capacity_full_admission_latency_known 0\n"); expect(metrics).not.toContain(org); expect(metrics).not.toContain(f.community.idHex);
});

test("public producers stop at the durable latch and missing scope before any external effect", async () => {
 const guard = new PublicCapacityGuard(sql, { communities, contract });
 await expect(guard.assertPublicProducer(f.community.idHex)).rejects.toThrow();
 const capacity = new PublicCapacityStore(sql, contract); await capacity.resume({ orgId: org, communityId: f.community.idHex, actorId: "synthetic-operator", contractHash: capacity.contractHash! });
 await expect(guard.assertPublicProducer(f.community.idHex)).resolves.toBeUndefined();
 await expect(guard.assertPublicProducer("ff".repeat(32))).rejects.toThrow();
 await expect(new PublicCapacityGuard(sql, { communities, contract: undefined }).assertPublicProducer(f.community.idHex)).rejects.toThrow();
});

test("actual validator permits cited moderation in reserve, blocks elective control and self-delete, then exhausts reserve", async () => {
 const g = await moderationFixture(), group = g.community.idHex, scope = new Map([[group, org]]), installer = new PolicyStore(sql);
 const n = g.policy.controlEvents.length;
 const bounded = { ...contract, maxima: { ...contract.maxima, inFlight: 1 }, thresholds: { warningHistoryCount: n, pauseHistoryCount: n + 2, urgentReserve: 2 } };
 const validator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_validator" }, onnotice() {} });
 try {
   await installer.install(g.policy, [g.chatStream, g.controlStream, g.guestbookStream], 0);
   const capacity = new PublicCapacityStore(sql, bounded), guarded = new PolicyStore(validator, { capacity: { communities: scope, contract: bounded } });
   await capacity.observeCurrent(org, group); expect((await guarded.admit(g.allowed)).action).toBe("accept");
   await capacity.pause({ orgId: org, communityId: group, reasonCode: "operator_pause" });
   const actions = new ConcordActions(g.community, g.moderator, () => installer.getPolicy(group) as any);
   const removal = (await actions.prepare(g.decision))[0]; expect((await guarded.admit(removal)).action).toBe("accept");
   const head = controlState(g.policy).folded.heads.get(g.roleId)!;
   const elective = await sealEdition(buildRoleEdition(moderatorRole(g.roleId), { actorPubkey: g.owner.pk, version: head.version + 1n, prevHash: head.hash }), currentControlWriteGroup(g.community), g.owner.signer);
   expect((await guarded.admit(elective)).action).toBe("reject"); expect((await sql`SELECT 1 FROM moderation.accepted_control WHERE event_id = ${elective.id}`).length).toBe(0);
   const selfDelete = wrapSeal(await sealRumor(buildRumor({ pubkey: g.member.pk, kind: 5, content: "", tags: [...channelBindingTags(g.channelId, BigInt(g.chatStream.epoch)), ["e", g.allowedRumorId]], ms: Date.now() }), KIND_SEAL_ENCRYPTED, g.chatKey, g.member.signer), g.chatKey);
   expect((await guarded.admit(selfDelete)).action).toBe("reject");
   const ban = { ...g.decision, action: "ban_member" as const };
   const first = (await actions.prepare(ban))[0]; expect((await guarded.admit(first)).action).toBe("accept");
   const second = (await actions.prepare({ ...ban, action: "unban_member" }))[0]; expect((await guarded.admit(second)).action).toBe("accept");
   const third = (await actions.prepare(ban))[0]; expect((await guarded.admit(third)).action).toBe("reject");
   expect((await sql`SELECT 1 FROM moderation.accepted_control WHERE event_id = ${third.id}`).length).toBe(0);
   expect((await sql`SELECT state FROM moderation.public_capacity_state WHERE org_id = ${org} AND community_id = ${group}`)[0].state).toBe("paused");
 } finally { await validator.end(); await sql`DELETE FROM moderation.public_capacity_state WHERE community_id = ${group}`; await sql`DELETE FROM moderation.community_policy WHERE community_id = ${group}`; }
});

test("capacity reserve serializes concurrent authorized control growth without overshoot", async () => {
 const g = await moderationFixture(), group = g.community.idHex, installer = new PolicyStore(sql), n = g.policy.controlEvents.length;
 const bounded = { ...contract, maxima: { ...contract.maxima, inFlight: 1 }, thresholds: { warningHistoryCount: n, pauseHistoryCount: n + 1, urgentReserve: 2 } };
 const validator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_validator" }, onnotice() {} });
 try {
   await installer.install(g.policy, [g.chatStream, g.controlStream, g.guestbookStream], 0);
   await new PublicCapacityStore(sql, bounded).pause({ orgId: org, communityId: group, reasonCode: "operator_pause" });
   const actions = new ConcordActions(g.community, g.moderator, async () => g.policy);
   const a = (await actions.prepare({ ...g.decision, action: "ban_member" }))[0], b = (await actions.prepare({ ...g.decision, action: "unban_member", author: g.bannedMember.pk }))[0];
   const guarded = new PolicyStore(validator, { capacity: { communities: new Map([[group, org]]), contract: bounded } });
   expect((await Promise.all([guarded.admit(a), guarded.admit(b)])).map(r => r.action).sort()).toEqual(["accept", "reject"]);
   expect(Number((await sql`SELECT count(*) AS n FROM moderation.accepted_control WHERE community_id = ${group}`)[0].n)).toBe(1);
 } finally { await validator.end(); await sql`DELETE FROM moderation.public_capacity_state WHERE community_id = ${group}`; await sql`DELETE FROM moderation.community_policy WHERE community_id = ${group}`; }
});

test("timing sink failure cannot turn a committed acceptance into rejection", async () => {
 const g = await moderationFixture();
 try {
   const store = new PolicyStore(sql, { onAdmissionTiming: () => { throw new Error("synthetic telemetry failure"); } });
   await store.install(g.policy, [g.chatStream, g.controlStream, g.guestbookStream], 0);
   expect((await store.admit(g.allowed)).action).toBe("accept");
   expect((await sql`SELECT 1 FROM moderation.carriers WHERE event_id = ${g.allowed.id}`).length).toBe(1);
 } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${g.community.idHex}`; }
});

test("contract changes require explicit operator resume against a fresh current count", async () => {
 const changed = new PublicCapacityStore(sql, { ...contract, maxSampleAgeMs: contract.maxSampleAgeMs + 1 });
 expect((await changed.observeCurrent(org, f.community.idHex)).state).toBe("unknown");
 await expect(changed.assertPublicProducer(org, f.community.idHex)).rejects.toThrow();
 expect((await changed.resume({ orgId: org, communityId: f.community.idHex, actorId: "synthetic-operator", contractHash: changed.contractHash! })).state).toBe("normal");
 await expect(changed.assertPublicProducer(org, f.community.idHex)).resolves.toBeUndefined();
});

test("producer refuses stale policy even when capacity observation remains fresh", async () => {
 const store = new PublicCapacityStore(sql, contract);
 await sql`UPDATE moderation.community_policy SET payload = payload || '{"validUntil":0}'::jsonb WHERE community_id = ${f.community.idHex}`;
 await expect(store.assertPublicProducer(org, f.community.idHex)).rejects.toThrow();
 await expect(store.pause({ orgId: org, communityId: f.community.idHex, reasonCode: "stale_policy_pause" })).resolves.toMatchObject({ state: "paused" });
 expect((await sql`SELECT state FROM moderation.public_capacity_state WHERE org_id = ${org} AND community_id = ${f.community.idHex}`)[0].state).toBe("paused");
});
