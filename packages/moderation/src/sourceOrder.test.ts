import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { Decisions, type DecisionStatus, type VerifiedCoopActor } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { migrateModeration } from "./policyStore";
import { createModerationApi, signCoopRequest } from "./api";
const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
const org = crypto.randomUUID(), community = "8".repeat(64), author = "9".repeat(64);
const actor = { orgId: org, actorId: "synthetic-ordering-staff", permissions: ["view", "ban_member", "unban_member", "remove_message", "retry"] };
const cipher = new EvidenceCipher(randomBytes(32), 3600, 100_000);
const decisions = new Decisions(sql, cipher, new Map([[community, org]]));
const secret = randomBytes(32);
const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([org, "other-org"]), reports: { async submitReport() { throw Error("unused"); } }, decisions });
let caseId: string;
async function evidence(member = author, communityId = community) {
 const id = crypto.randomUUID();
 await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
 VALUES (${id}, ${org}, ${communityId}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${member}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
 return id;
}
function request(revision: string, action: "ban_member" | "unban_member" = "ban_member", id = caseId) {
 return { caseId: id, executionId: crypto.randomUUID(), action, reason: "Synthetic order regression", scope: "community" as const, discordGuildConfirmed: false, sourceOrder: { version: 1 as const, revision } };
}
async function call(path: string, body?: unknown, staff: VerifiedCoopActor = actor) {
 const method = body === undefined ? "GET" : "POST", text = body === undefined ? "" : JSON.stringify(body);
 return api(new Request("https://rooms.example" + path, { method, ...(body === undefined ? {} : { body: text }), headers: signCoopRequest(secret, staff, method, path, text) }));
}
beforeAll(async () => { await migrateModeration(sql); caseId = await evidence(); });
afterAll(async () => { await sql`DELETE FROM moderation.decisions WHERE org_id = ${org}`; await sql`DELETE FROM moderation.cases WHERE org_id = ${org}`; await sql.end(); });
test("source order refuses a never accepted delayed older cross-case intent and preserves exact replay", async () => {
 const old = request("1"), newer = request("2", "unban_member", await evidence());
 const accepted = await call("/v1/decisions", newer);
 expect(accepted.status).toBe(202);
 const status = await accepted.json() as DecisionStatus;
 expect(status).toMatchObject({ executionId: newer.executionId, sourceOrder: newer.sourceOrder });
 const late = await call("/v1/decisions", old);
 expect(late.status).toBe(409);
 expect(await late.json()).toEqual({ error: "member_intent_superseded", executionId: old.executionId, currentRevision: "2", supersededByExecutionId: newer.executionId });
 expect((await sql`SELECT 1 FROM moderation.decisions WHERE execution_id = ${old.executionId}`)).toHaveLength(0);
 const conflicting = await call("/v1/decisions", request("2"));
 expect(conflicting.status).toBe(409); expect(await conflicting.json()).toMatchObject({ error: "member_intent_order_conflict" });
 const next = request("3"); expect((await call("/v1/decisions", next)).status).toBe(202);
 await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 7 WHERE decision_id = ${status.decisionId}`;
 expect(await (await call("/v1/decisions", newer)).json()).toMatchObject({ decisionId: status.decisionId, deliveries: expect.arrayContaining([expect.objectContaining({ state: "failed", attempts: 7 })]) });
 expect((await call("/v1/decisions", { ...newer, sourceOrder: { version: 1, revision: "4" } })).status).toBe(400);
 for (const change of [{ reason: "changed" }, { action: "ban_member" }, { discordGuildConfirmed: true }]) expect((await call("/v1/decisions", { ...newer, ...change })).status).toBe(400);
 const lookup = await call(`/v1/decision-executions/${newer.executionId}`);
 expect(lookup.status).toBe(200); expect(await lookup.json()).toMatchObject({ decisionId: status.decisionId, executionId: newer.executionId });
 expect((await call(`/v1/decision-executions/${newer.executionId}`, undefined, { ...actor, orgId: "other-org" })).status).toBe(404);
 expect((await call(`/v1/decision-executions/${newer.executionId}`, undefined, { ...actor, permissions: [] })).status).toBe(404);
 expect((await call(`/v1/decision-executions/${crypto.randomUUID()}`)).status).toBe(404);
});
test("new membership needs canonical positive bigint source order while removal remains compatible", async () => {
 const { sourceOrder, ...unfenced } = request("1");
 const missing = await call("/v1/decisions", unfenced);
 expect(missing.status).toBe(409); expect(await missing.json()).toMatchObject({ error: "member_intent_order_required" });
 for (const revision of ["0", "01", "-1", "1.0", "9223372036854775808", 1, null]) expect((await call("/v1/decisions", { ...request("1"), sourceOrder: { version: 1, revision } })).status).toBe(400);
 for (const sourceOrder of [{ version: 2, revision: "1" }, { version: 1, revision: "1", extra: true }, null]) expect((await call("/v1/decisions", { ...request("1"), sourceOrder })).status).toBe(400);
 const removal = await call("/v1/decisions", { ...unfenced, action: "remove_message", scope: "message" });
 expect(removal.status).toBe(202); expect(await removal.json()).toMatchObject({ executionId: unfenced.executionId, sourceOrder: null });
});
test("legacy fingerprint replays precede fencing, including expired evidence", async () => {
 const { sourceOrder, ...legacy } = request("1", "ban_member", await evidence("1".repeat(64)));
 const id = crypto.randomUUID(), fingerprint = createHash("sha256").update(JSON.stringify([org, actor.actorId, legacy.caseId, legacy.executionId, legacy.action, legacy.reason, legacy.scope, legacy.discordGuildConfirmed])).digest("hex");
 await sql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at, fingerprint_version)
 VALUES (${id}, ${org}, ${legacy.executionId}, ${fingerprint}, ${legacy.caseId}, ${community}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"1".repeat(64)}, 'ban_member', false, clock_timestamp() + interval '1 hour', 1)`;
 await sql`INSERT INTO moderation.deliveries (decision_id, target, state, attempts) VALUES (${id}, 'concord', 'failed', 4)`;
 const newer = request("1", "unban_member", legacy.caseId); expect((await call("/v1/decisions", newer)).status).toBe(202);
 await sql`DELETE FROM moderation.cases WHERE case_id = ${legacy.caseId}`;
 const replay = await call("/v1/decisions", legacy); expect(replay.status).toBe(202);
 expect(await replay.json()).toMatchObject({ decisionId: id, sourceOrder: null, deliveries: [{ state: "failed", attempts: 4 }] });
 expect((await call("/v1/decisions", { ...legacy, sourceOrder: { version: 1, revision: "1" } })).status).toBe(400);
 expect((await call("/v1/decisions", { ...legacy, reason: "changed" })).status).toBe(400);
 await expect(decisions.retry(id, actor)).rejects.toThrow(/supersedes/);
});
test("head survives decision pruning and restart; max bigint is exact and targets stay independent", async () => {
 const target = await evidence("2".repeat(64)), high = request("9223372036854775807", "ban_member", target);
 const accepted = await decisions.acceptDecision(high, actor);
 await sql`DELETE FROM moderation.decisions WHERE decision_id = ${accepted.decisionId}`;
 const restarted = new Decisions(sql, cipher, new Map([[community, org]]));
 await expect(restarted.acceptDecision(request("9223372036854775806", "unban_member", target), actor)).rejects.toMatchObject({ code: "member_intent_superseded" });
 expect((await restarted.acceptDecision(request("1", "ban_member", await evidence("3".repeat(64))), actor)).sourceOrder).toEqual({ version: 1, revision: "1" });
 const [head] = await sql`SELECT latest_revision::text AS revision FROM moderation.member_order_heads WHERE org_id = ${org} AND community_id = ${community} AND author = ${"2".repeat(64)}`;
 expect(head.revision).toBe("9223372036854775807");
});
test("actual API role advances fenced heads atomically without granting counter deletion", async () => {
 const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
 try {
 const restricted = new Decisions(apiSql, cipher, new Map([[community, org]])), target = await evidence("4".repeat(64));
 const inputs = [request("1", "ban_member", target), request("2", "unban_member", target)];
 const outcomes = await Promise.allSettled(inputs.map(i => restricted.acceptDecision(i, actor)));
 expect(outcomes[1].status).toBe("fulfilled");
 const [head] = await sql`SELECT latest_revision::text AS revision, latest_execution_id FROM moderation.member_order_heads WHERE org_id = ${org} AND author = ${"4".repeat(64)}`;
 expect(head).toEqual({ revision: "2", latest_execution_id: inputs[1].executionId });
 await expect(apiSql`DELETE FROM moderation.member_order_heads WHERE org_id = ${org}`.execute()).rejects.toThrow(/permission denied/);
 } finally { await apiSql.end(); }
});
test("delivery supersession and Retry use source revisions despite inverted acceptance timestamps", async () => {
 const target = await evidence("5".repeat(64));
 const a = await decisions.acceptDecision(request("1", "ban_member", target), actor);
 const b = await decisions.acceptDecision(request("2", "unban_member", target), actor);
 // Time-travel synthetic fixtures only; runtime roles retain immutable timestamps.
 await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET created_at = clock_timestamp() + interval '1 day' WHERE decision_id = ${a.decisionId}`; });
 await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 1 WHERE decision_id = ${a.decisionId}`;
 await expect(decisions.retry(a.decisionId, actor)).rejects.toThrow(/supersedes/);
 await sql`UPDATE moderation.deliveries SET state = 'pending' WHERE decision_id = ${a.decisionId}`;
 await decisions.claim();
 expect((await decisions.get(a.decisionId, actor)).deliveries.every(d => d.resultCode === "superseded_by_newer_decision")).toBe(true);
 expect((await decisions.get(a.decisionId, actor)).supersededBy).toBe(b.decisionId);
});
test("delayed request released only after newer acceptance cannot create outbox or lower head", async () => {
 const target = await evidence("6".repeat(64)), old = request("1", "ban_member", target), fresh = request("2", "unban_member", target);
 let release!: () => void, entered!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
 const delayed = (async () => { entered(); await gate; return call("/v1/decisions", old); })();
 await ready;
 const accepted = await call("/v1/decisions", fresh); expect(accepted.status).toBe(202);
 release();
 const late = await delayed; expect(late.status).toBe(409);
 expect(await late.json()).toMatchObject({ error: "member_intent_superseded", supersededByExecutionId: fresh.executionId });
 expect(await sql`SELECT 1 FROM moderation.decisions WHERE execution_id = ${old.executionId}`).toHaveLength(0);
});
test("failed acceptance transaction rolls back its high-water mark with all deliveries", async () => {
 const target = await evidence("7".repeat(64)), failed = request("8", "ban_member", target);
 // Force an actual SQL failure after the head write, rather than simulating an
 // application failure before it. The temporary trigger is scoped to this org.
 await sql.unsafe(`CREATE FUNCTION moderation.source_order_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id = '${org}' THEN RAISE EXCEPTION 'synthetic post-head failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe("CREATE TRIGGER source_order_test_failure BEFORE INSERT ON moderation.decisions FOR EACH ROW EXECUTE FUNCTION moderation.source_order_test_failure()");
 try { await expect(decisions.acceptDecision(failed, actor)).rejects.toThrow(/synthetic post-head failure/); }
 finally { await sql.unsafe("DROP TRIGGER source_order_test_failure ON moderation.decisions; DROP FUNCTION moderation.source_order_test_failure()"); }
 expect(await sql`SELECT 1 FROM moderation.member_order_heads WHERE org_id = ${org} AND author = ${"7".repeat(64)}`).toHaveLength(0);
 expect(await sql`SELECT 1 FROM moderation.decisions WHERE execution_id = ${failed.executionId}`).toHaveLength(0);
 expect((await decisions.acceptDecision(request("1", "unban_member", target), actor)).sourceOrder?.revision).toBe("1");
});
test("runtime roles cannot reset heads or delete ordering history after repeated migration", async () => {
 await migrateModeration(sql);
 for (const role of ["moderation_api", "moderation_operator"]) {
 const restricted = postgres(process.env.DATABASE_URL!, { max: 1, connection: { options: `-c role=${role}` }, onnotice() {} });
 try {
 await expect(restricted`DELETE FROM moderation.member_order_heads WHERE org_id = ${org}`.execute()).rejects.toThrow(/permission denied/);
 await expect(restricted`UPDATE moderation.member_order_heads SET latest_revision = 1 WHERE org_id = ${org} AND latest_revision > 1`.execute()).rejects.toThrow();
 } finally { await restricted.end(); }
 }
});
test("old API INSERT defaults cannot introduce unfenced membership after cutover", async () => {
 const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
 try {
 await expect(apiSql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at)
 VALUES (${crypto.randomUUID()}, ${org}, ${crypto.randomUUID()}, ${"f".repeat(64)}, ${caseId}, ${community}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${author}, 'ban_member', false, clock_timestamp() + interval '1 hour')`.execute()).rejects.toThrow(/source_order/);
 } finally { await apiSql.end(); }
});
test("old executable unfenced removal remains replayable under the new default marker", async () => {
 const target = await evidence("a".repeat(64)), input = { caseId: target, executionId: crypto.randomUUID(), action: "remove_message" as const, reason: "Synthetic old removal", scope: "message" as const, discordGuildConfirmed: false };
 const fingerprint = createHash("sha256").update(JSON.stringify([org, actor.actorId, input.caseId, input.executionId, input.action, input.reason, input.scope, input.discordGuildConfirmed])).digest("hex"), id = crypto.randomUUID();
 const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
 try {
 await apiSql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at)
 VALUES (${id}, ${org}, ${input.executionId}, ${fingerprint}, ${target}, ${community}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"a".repeat(64)}, 'remove_message', false, clock_timestamp() + interval '1 hour')`;
 expect((await decisions.acceptDecision(input, actor)).decisionId).toBe(id);
 await expect(decisions.acceptDecision({ ...input, reason: "changed" }, actor)).rejects.toThrow(/conflict/);
 } finally { await apiSql.end(); }
});
test("durable newer head still fences old delivery Retry after the newer decision is pruned", async () => {
 const target = await evidence("c".repeat(64)), first = await decisions.acceptDecision(request("1", "ban_member", target), actor), second = await decisions.acceptDecision(request("2", "unban_member", target), actor);
 await sql`DELETE FROM moderation.decisions WHERE decision_id = ${second.decisionId}`;
 await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 1 WHERE decision_id = ${first.decisionId}`;
 await expect(decisions.retry(first.decisionId, actor)).rejects.toMatchObject({ code: "member_decision_superseded" });
 await sql`UPDATE moderation.deliveries SET state = 'pending' WHERE decision_id = ${first.decisionId}`;
 await decisions.claim();
 expect((await decisions.get(first.decisionId, actor)).deliveries.every(d => d.resultCode === "superseded_by_newer_decision")).toBe(true);
});
test("rollback preflight refuses revisioned history including heads with pruned decisions", async () => {
 const { readFile } = await import("node:fs/promises");
 const preflight = await readFile(new URL("../../../scripts/moderation-source-order-rollback-preflight.sql", import.meta.url), "utf8");
 await expect(sql.unsafe(preflight).execute()).rejects.toThrow(/rollback prohibited/);
 await expect(sql.begin(async tx => {
   await tx`DELETE FROM moderation.decisions`;
   await expect(tx.savepoint(async nested => { await nested.unsafe(preflight); })).rejects.toThrow(/rollback prohibited/);
   await tx`DELETE FROM moderation.member_order_heads`;
   await tx.unsafe(preflight);
   throw Error("synthetic transaction rollback");
 })).rejects.toThrow(/synthetic transaction rollback/);
});
test("legacy uncertain Concord publication blocks its revisioned successor until reconciled", async () => {
 const target = await evidence("e".repeat(64)), legacyId = crypto.randomUUID();
 await sql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at, fingerprint_version)
 VALUES (${legacyId}, ${org}, ${crypto.randomUUID()}, ${"f".repeat(64)}, ${target}, ${community}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"e".repeat(64)}, 'ban_member', false, clock_timestamp() + interval '1 hour', 1)`;
 await sql`INSERT INTO moderation.deliveries (decision_id, target, state, publication_attempted, result_code)
 VALUES (${legacyId}, 'concord', 'failed', true, 'concord_recovery_requires_operator')`;
 const next = await decisions.acceptDecision(request("1", "unban_member", target), actor);
 await sql`UPDATE moderation.deliveries SET state = 'verified' WHERE decision_id = ${next.decisionId} AND target <> 'concord'`;
 for (let claim; (claim = await decisions.claim());) {
   expect(claim.decision.decisionId).not.toBe(next.decisionId);
   await decisions.complete(claim, "verified", "synthetic_settled");
 }
 await sql`UPDATE moderation.deliveries SET state = 'verified', result_code = 'synthetic_reconciled' WHERE decision_id = ${legacyId}`;
 const released = await decisions.claim(); expect(released?.decision.decisionId).toBe(next.decisionId);
 await decisions.complete(released!, "verified", "synthetic_settled");
 // Time-travel synthetic fixtures only; runtime roles retain immutable timestamps.
 await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${next.decisionId}`; });
 await decisions.expire();
 await expect(decisions.acceptDecision(request("1", "ban_member", target), actor)).rejects.toMatchObject({ code: "member_intent_order_conflict" });
});
