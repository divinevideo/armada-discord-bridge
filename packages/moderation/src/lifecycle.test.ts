import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { migrateModeration, PolicyStore } from "./policyStore";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { EvidenceCipher } from "./evidence";
import { Lifecycle } from "./lifecycle";
import { Reports } from "./reports";
import { expireModerationRecords } from "./runtime";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const f = await moderationFixture();
const org = `synthetic-b2-${crypto.randomUUID()}`, community = f.community.idHex;
const cipher = new EvidenceCipher(randomBytes(32), 3600, 200000), communities = new Map([[community, org]]);
const actor = { orgId: org, actorId: "synthetic-admin", permissions: ["view", "manage_moderation_records", "view_held_evidence"] };
const lifecycle = new Lifecycle(sql, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
const reports = new Reports(sql, cipher, { resolve: async () => { throw new Error("unused"); } }, communities, 10, lifecycle);
beforeAll(async () => { await migrateModeration(sql); await new PolicyStore(sql).install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0); });
afterAll(async () => {
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`DELETE FROM moderation.lifecycle_events WHERE org_id = ${org}`; await tx`DELETE FROM moderation.evidence_holds WHERE org_id = ${org}`; await tx`DELETE FROM moderation.decisions WHERE org_id = ${org}`; await tx`DELETE FROM moderation.cases WHERE org_id = ${org}`; await tx`DELETE FROM moderation.member_order_heads WHERE org_id = ${org}`; await tx`DELETE FROM moderation.community_policy WHERE community_id = ${community}`; }); await sql.end();
});
async function caseRow() {
  const id = crypto.randomUUID(); const evidence = cipher.seal(`${org}:${id}`, { evidence: { content: "selected synthetic edit", createdAt: 1, editedAt: 2 }, reason: "synthetic report" });
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at) VALUES (${id}, ${org}, ${community}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, ${crypto.randomUUID()}, ${evidence}, clock_timestamp() + interval '1 hour')`; return id;
}
async function expireCase(id: string) { await sql`UPDATE moderation.cases SET expires_at = clock_timestamp() - interval '1 second' WHERE case_id = ${id}`; }
async function decisionRow(caseId: string, action = "remove_message") {
  const id = crypto.randomUUID(); await sql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, audit, expires_at, fingerprint_version) VALUES (${id}, ${org}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${caseId}, ${community}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, ${action}, false, ${cipher.seal(`${org}:${id}`, { actorId: actor.actorId, reason: "synthetic decision" })}, clock_timestamp() + interval '1 hour', 1)`;
  for (const target of ["concord", "discord", "divine_relay"]) await sql`INSERT INTO moderation.deliveries (decision_id, target, state) VALUES (${id}, ${target}, 'verified')`; return id;
}
test("hold preserves the exact expired snapshot, duplicate deadline and ordinary expiry", async () => {
  const caseId = await caseRow(), holdUntil = new Date(Date.now() + 120000).toISOString();
  const held = await lifecycle.placeEvidenceHold({ caseId, holdUntil, reason: "synthetic hold" }, actor);
  const [before] = await sql`SELECT evidence, expires_at FROM moderation.cases WHERE case_id = ${caseId}`;
  expect(await lifecycle.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 240000).toISOString(), reason: "duplicate" }, actor)).toEqual(held);
  await expireCase(caseId); await reports.expire();
  expect((await sql`SELECT evidence FROM moderation.cases WHERE case_id = ${caseId}`)[0].evidence).toEqual(before.evidence);
  await expect(reports.getCase(caseId, actor)).rejects.toThrow();
  const read = await lifecycle.readHeldEvidence({ caseId, reason: "synthetic access" }, actor);
  expect(read).toMatchObject({ content: "selected synthetic edit", editedAt: 2 });
  expect((await sql`SELECT event_id FROM moderation.lifecycle_events WHERE case_id = ${caseId} AND kind = 'held_evidence_access'`).length).toBe(1);
  await expect(lifecycle.readHeldEvidence({ caseId, reason: "denied" }, { ...actor, permissions: ["view"] })).rejects.toThrow();
  await expect(lifecycle.readHeldEvidence({ caseId, reason: "denied" }, { ...actor, orgId: "other" })).rejects.toThrow();
  await lifecycle.releaseEvidenceHold({ holdId: held.holdId, reason: "synthetic release" }, actor);
  expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(0);
});
test("cleanup before hold refuses without recreating evidence", async () => {
  const caseId = await caseRow(); await expireCase(caseId); await lifecycle.expireEvidence();
  await expect(lifecycle.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 60000).toISOString(), reason: "late" }, actor)).rejects.toThrow();
});
test("settled removal closes with a fixed deadline; appeal reopens and guards audit cleanup", async () => {
  const caseId = await caseRow(), decisionId = await decisionRow(caseId);
  const closed = await lifecycle.closeLifecycle({ decisionId, reason: "settled" }, actor);
  expect(closed.closedAt).toBeString(); expect(closed.auditAvailable).toBe(true);
  const shorter = new Lifecycle(sql, cipher, communities, { auditRetentionSeconds: 1, holdMaxSeconds: 3600 });
  expect((await shorter.closeLifecycle({ decisionId, reason: "repeat" }, actor)).auditDeleteAfter).toBe(closed.auditDeleteAfter);
  const reopened = await lifecycle.setAppeal({ decisionId, state: "open", reason: "appeal" }, actor);
  expect(reopened).toMatchObject({ appealState: "open", closedAt: null, auditDeleteAfter: null });
  await expect(lifecycle.closeLifecycle({ decisionId, reason: "blocked" }, actor)).rejects.toThrow();
  await lifecycle.expireAudit(); expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0].audit).not.toBeNull();
});
test("expired unknown, pending and active membership actions still cannot close", async () => {
  const caseId = await caseRow(), ban = await decisionRow(caseId, "ban_member");
  const unknown = await decisionRow(caseId); await sql`UPDATE moderation.deliveries SET state = 'failed', publication_attempted = true WHERE decision_id = ${unknown} AND target = 'concord'`;
  const pending = await decisionRow(caseId); await sql`UPDATE moderation.deliveries SET state = 'pending' WHERE decision_id = ${pending} AND target = 'discord'`;
  await expireCase(caseId);
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE case_id = ${caseId}`; });
  for (const decisionId of [ban, unknown, pending]) await expect(lifecycle.closeLifecycle({ decisionId, reason: "expired but unresolved" }, actor)).rejects.toThrow();
  await lifecycle.expireEvidence();
  for (const decisionId of [ban, unknown, pending]) await expect(lifecycle.closeLifecycle({ decisionId, reason: "deleted evidence but unresolved" }, actor)).rejects.toThrow();
});

for (const evidenceState of ["expired", "deleted"] as const) test(`explicit closure of settled removal after evidence is ${evidenceState} starts independent audit retention`, async () => {
  const caseId = await caseRow(), decisionId = await decisionRow(caseId);
  const [before] = await sql`SELECT audit, execution_id, fingerprint FROM moderation.decisions WHERE decision_id = ${decisionId}`;
  await expireCase(caseId);
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${decisionId}`; });
  if (evidenceState === "deleted") await lifecycle.expireEvidence();
  const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice: () => {} });
  const operatorSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice: () => {} });
  try {
    const operator = new Lifecycle(operatorSql, undefined, communities, {});
    await operator.expireAudit();
    expect((await sql`SELECT lifecycle_closed_at, audit FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0]).toEqual({ lifecycle_closed_at: null, audit: before.audit });
    const staff = new Lifecycle(apiSql, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
    const closed = await staff.closeLifecycle({ decisionId, reason: "settled action after evidence expiry" }, actor);
    expect(closed.closedAt).toBeString(); expect(closed.auditAvailable).toBe(true);
    expect(new Date(closed.auditDeleteAfter!).getTime() - new Date(closed.closedAt!).getTime()).toBeGreaterThanOrEqual(60000);
    await operator.expireAudit();
    expect((await sql`SELECT audit, execution_id, fingerprint FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0]).toEqual(before);
    await expect(reports.getCase(caseId, actor)).rejects.toThrow();
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(evidenceState === "deleted" ? 0 : 1);
    await sql.begin(async tx => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 minutes', audit_delete_after = clock_timestamp() - interval '1 minute' WHERE decision_id = ${decisionId}`;
      await tx`UPDATE moderation.lifecycle_events SET recorded_at = clock_timestamp() - interval '2 minutes' WHERE decision_id = ${decisionId}`;
    });
    await operator.expireAudit();
    expect((await sql`SELECT audit, execution_id, fingerprint FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0]).toEqual({ ...before, audit: null });
    expect((await staff.closeLifecycle({ decisionId, reason: "idempotent after audit erasure" }, actor)).auditAvailable).toBe(false);
    expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0].audit).toBeNull();
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(evidenceState === "deleted" ? 0 : 1);
  } finally { await apiSql.end(); await operatorSql.end(); }
});

function paused(client: postgres.Sql, match: (text: string, rows: any[], values: unknown[]) => boolean) {
  let reached!: () => void, resume!: () => void;
  const ready = new Promise<void>(done => { reached = done; }), proceed = new Promise<void>(done => { resume = done; });
  const db = new Proxy(client, { get(target, key) { if (key !== "begin") return Reflect.get(target, key); return (callback: (tx: postgres.TransactionSql) => Promise<unknown>) => client.begin(tx => callback(new Proxy(tx, { apply(target, receiver, args) { const query = Reflect.apply(target, receiver, args); return (async () => { const result = await query; if (match(String(args[0][0]), result, args.slice(1))) { reached(); await proceed; } return result; })(); } }))); } });
  return { db, ready, resume };
}
async function waiting(name: string) {
  for (let i = 0; i < 200; i++) { const [row] = await sql`SELECT wait_event_type FROM pg_stat_activity WHERE application_name = ${name}`; if (row?.wait_event_type === "Lock") return; await Bun.sleep(5); } throw new Error("Expected PostgreSQL lock wait");
}
test("hold transaction winning the case boundary preserves bytes against concurrent cleanup", async () => {
  const caseId = await caseRow();
  await sql`UPDATE moderation.cases SET expires_at = clock_timestamp() + interval '1 second' WHERE case_id = ${caseId}`;
  const gate = paused(sql, text => text.startsWith("INSERT INTO moderation.lifecycle_events"));
  const holding = new Lifecycle(gate.db, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 }).placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 60000).toISOString(), reason: "race hold" }, actor);
  const name = `synthetic-cleanup-${crypto.randomUUID()}`, client = postgres(process.env.DATABASE_URL!, { connection: { application_name: name }, max: 1, onnotice: () => {} });
  let cleanup: Promise<void> | undefined;
  try {
    await gate.ready;
    for (let i = 0; i < 300; i++) { const [row] = await sql`SELECT expires_at <= clock_timestamp() AS expired FROM moderation.cases WHERE case_id = ${caseId}`; if (row.expired) break; await Bun.sleep(5); }
    cleanup = new Lifecycle(client, cipher, communities, {}).expireEvidence();
    await waiting(name); gate.resume(); await holding; await cleanup;
    expect((await sql`SELECT evidence FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(1);
  } finally { gate.resume(); await Promise.allSettled([holding, ...(cleanup ? [cleanup] : [])]); await client.end(); }
});
test("cleanup transaction winning the case boundary makes concurrent hold refuse", async () => {
  const caseId = await caseRow(); await expireCase(caseId);
  const gate = paused(sql, (text, _rows, values) => text.startsWith("DELETE FROM moderation.cases") && values.includes(caseId));
  const cleanup = new Lifecycle(gate.db, cipher, communities, {}).expireEvidence();
  const name = `synthetic-hold-${crypto.randomUUID()}`, client = postgres(process.env.DATABASE_URL!, { connection: { application_name: name }, max: 1, onnotice: () => {} });
  let holding: Promise<unknown> | undefined;
  try {
    await gate.ready;
    holding = new Lifecycle(client, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 }).placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 60000).toISOString(), reason: "late race hold" }, actor);
    const outcome = holding.then(() => "accepted", () => "refused");
    await waiting(name); gate.resume(); await cleanup; expect(await outcome).toBe("refused");
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(0);
  } finally { gate.resume(); await Promise.allSettled([cleanup, ...(holding ? [holding] : [])]); await client.end(); }
});
test("held access commits before decryption and audit insert failure returns no plaintext", async () => {
  const caseId = await caseRow(); await lifecycle.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 60000).toISOString(), reason: "audit" }, actor);
  let committed = false, opened = 0;
  const trackedCipher = new Proxy(cipher, { get(target, key) { if (key === "open") return (...args: [string, Uint8Array]) => { expect(committed).toBe(true); opened++; return target.open(...args); }; return Reflect.get(target, key); } });
  const committedSql = new Proxy(sql, { get(target, key) { if (key !== "begin") return Reflect.get(target, key); return async (callback: any) => { const value = await sql.begin(callback); committed = true; return value; }; } });
  await new Lifecycle(committedSql, trackedCipher, communities, {}).readHeldEvidence({ caseId, reason: "existing policy read" }, actor);
  expect(opened).toBe(1);
  const failingSql = new Proxy(sql, { get(target, key) { if (key !== "begin") return Reflect.get(target, key); return (callback: any) => sql.begin(tx => callback(new Proxy(tx, { apply(target, receiver, args) { if (String(args[0][0]).startsWith("INSERT INTO moderation.lifecycle_events")) return tx`SELECT 1/0`; return Reflect.apply(target, receiver, args); } }))); } });
  await expect(new Lifecycle(failingSql, trackedCipher, communities, {}).readHeldEvidence({ caseId, reason: "failed audit" }, actor)).rejects.toThrow();
  expect(opened).toBe(1);
});
test("restricted API can create/read/release holds without expiry mutation privilege", async () => {
  const caseId = await caseRow(), client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice: () => {} });
  try {
    const api = new Lifecycle(client, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
    const hold = await api.placeEvidenceHold({ caseId, reason: "restricted create", holdUntil: new Date(Date.now() + 60000).toISOString() }, actor);
    expect((await api.readHeldEvidence({ caseId, reason: "restricted read" }, actor)).content).toBe("selected synthetic edit");
    await expect(Promise.resolve(client`UPDATE moderation.cases SET expires_at = clock_timestamp() WHERE case_id = ${caseId}`)).rejects.toThrow(/permission denied/);
    await expireCase(caseId); await api.releaseEvidenceHold({ holdId: hold.holdId, reason: "restricted release" }, actor);
  } finally { await client.end(); }
});
test("reclose after reopening preserves the recorded retention interval", async () => {
  const caseId = await caseRow(), decisionId = await decisionRow(caseId);
  const closed = await lifecycle.closeLifecycle({ decisionId, reason: "first" }, actor);
  await lifecycle.setAppeal({ decisionId, state: "open", reason: "reopen" }, actor);
  await lifecycle.setAppeal({ decisionId, state: "closed", reason: "settled appeal" }, actor);
  const shorter = new Lifecycle(sql, cipher, communities, { auditRetentionSeconds: 1, holdMaxSeconds: 3600 });
  const next = await shorter.closeLifecycle({ decisionId, reason: "reclose" }, actor);
  expect(new Date(next.auditDeleteAfter!).getTime()).toBeGreaterThanOrEqual(new Date(closed.auditDeleteAfter!).getTime());
  expect(Number((await sql`SELECT audit_retention_seconds FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0].audit_retention_seconds)).toBe(60);
});

test("operator erases elapsed action audit and journals while preserving heads, tombstones and execution identity", async () => {
  const caseId = await caseRow(), decisionId = await decisionRow(caseId);
  await lifecycle.closeLifecycle({ decisionId, reason: "settled audit" }, actor);
  await sql`INSERT INTO moderation.member_order_heads (org_id, community_id, author, latest_revision, latest_execution_id) VALUES (${org}, ${community}, ${"e".repeat(64)}, 1, ${crypto.randomUUID()})`;
  await sql`INSERT INTO moderation.tombstones (community_id, channel_id, rumor_id) VALUES (${community}, ${"b".repeat(64)}, ${"c".repeat(64)})`;
  const [before] = await sql`SELECT execution_id, fingerprint FROM moderation.decisions WHERE decision_id = ${decisionId}`;
  await sql.begin(async tx => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 minutes', audit_delete_after = clock_timestamp() - interval '1 minute' WHERE decision_id = ${decisionId}`;
    await tx`UPDATE moderation.lifecycle_events SET recorded_at = clock_timestamp() - interval '2 minutes' WHERE decision_id = ${decisionId}`;
  });
  await expireCase(caseId);
  const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice: () => {} });
  try {
    const operator = new Lifecycle(client, undefined, communities, {});
    await expireModerationRecords(new Decisions(client, undefined, communities), operator);
    expect((await sql`SELECT audit, execution_id, fingerprint FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0]).toEqual({ audit: null, ...before });
    expect((await sql`SELECT event_id FROM moderation.lifecycle_events WHERE decision_id = ${decisionId}`).length).toBe(0);
    expect((await sql`SELECT latest_revision::text AS revision FROM moderation.member_order_heads WHERE org_id = ${org} AND author = ${"e".repeat(64)}`)[0].revision).toBe("1");
    expect((await sql`SELECT rumor_id FROM moderation.tombstones WHERE community_id = ${community} AND channel_id = ${"b".repeat(64)} AND rumor_id = ${"c".repeat(64)}`).length).toBe(1);
  } finally { await client.end(); }
});
test("operator purges inactive hold/access records using stored policy, without current config", async () => {
  const caseId = await caseRow(); const held = await lifecycle.placeEvidenceHold({ caseId, reason: "retained journal", holdUntil: new Date(Date.now() + 60000).toISOString() }, actor);
  await lifecycle.readHeldEvidence({ caseId, reason: "audited access" }, actor);
  await sql.begin(async tx => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE moderation.evidence_holds SET created_at = clock_timestamp() - interval '4 minutes', hold_until = clock_timestamp() - interval '2 minutes', case_expires_at = clock_timestamp() - interval '2 minutes' WHERE hold_id = ${held.holdId}`;
    await tx`UPDATE moderation.lifecycle_events SET recorded_at = clock_timestamp() - interval '3 minutes' WHERE case_id = ${caseId}`;
  });
  await expireCase(caseId);
  const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice: () => {} });
  try {
    const operator = new Lifecycle(client, undefined, communities, {}); await expireModerationRecords(new Decisions(client, undefined, communities), operator);
    expect((await sql`SELECT event_id FROM moderation.lifecycle_events WHERE case_id = ${caseId}`).length).toBe(0);
    expect((await sql`SELECT hold_id FROM moderation.evidence_holds WHERE case_id = ${caseId}`).length).toBe(0);
  } finally { await client.end(); }
});
test("appeal reopening wins the case boundary and prevents a stale audit cleanup candidate", async () => {
  const caseId = await caseRow(), decisionId = await decisionRow(caseId);
  await lifecycle.closeLifecycle({ decisionId, reason: "settled" }, actor);
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 minutes', audit_delete_after = clock_timestamp() - interval '1 minute' WHERE decision_id = ${decisionId}`; });
  const gate = paused(sql, text => text.startsWith("INSERT INTO moderation.lifecycle_events"));
  const opening = new Lifecycle(gate.db, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 }).setAppeal({ decisionId, state: "open", reason: "appeal wins" }, actor);
  const name = `synthetic-audit-cleanup-${crypto.randomUUID()}`, client = postgres(process.env.DATABASE_URL!, { max: 1, connection: { application_name: name, options: "-c role=moderation_operator" }, onnotice: () => {} });
  let cleanup: Promise<void> | undefined;
  try {
    await gate.ready;
    cleanup = new Lifecycle(client, undefined, communities, {}).expireAudit();
    await waiting(name); gate.resume(); await opening; await cleanup;
    expect((await sql`SELECT appeal_state, audit_delete_after, audit FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0]).toMatchObject({ appeal_state: "open", audit_delete_after: null });
    expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${decisionId}`)[0].audit).not.toBeNull();
  } finally { gate.resume(); await Promise.allSettled([opening, ...(cleanup ? [cleanup] : [])]); await client.end(); }
});

test("missing policy blocks new holds before allocation, but legacy holds cannot invent access policy", async () => {
  const caseId = await caseRow(), missing = new Lifecycle(sql, cipher, communities, {});
  await expect(missing.placeEvidenceHold({ caseId, reason: "missing policy", holdUntil: new Date(Date.now() + 60000).toISOString() }, actor)).rejects.toThrow(/configuration required/);
  expect((await sql`SELECT hold_id FROM moderation.evidence_holds WHERE case_id = ${caseId}`).length).toBe(0);
  await sql`INSERT INTO moderation.evidence_holds (hold_id, org_id, case_id, hold_until, encrypted_audit) VALUES (${crypto.randomUUID()}, ${org}, ${caseId}, clock_timestamp() + interval '1 hour', ${Buffer.from("synthetic legacy audit")})`;
  await expect(missing.readHeldEvidence({ caseId, reason: "no approved snapshot" }, actor)).rejects.toThrow(/unavailable/);
});

import { createModerationApi, signCoopRequest } from "./api";
import { Decisions } from "./decisions";
test("signed lifecycle routes enforce separate capabilities, ordinary expiry and no-store", async () => {
  const caseId = await caseRow(), secret = randomBytes(32);
  const decisions = new Decisions(sql, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
  const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([org]), reports, decisions, lifecycle });
  const post = (path: string, input: unknown, staff = actor) => { const body = JSON.stringify(input); return api(new Request("https://rooms.example" + path, { method: "POST", body, headers: signCoopRequest(secret, staff, "POST", path, body) })); };
  const holdPath = `/v1/cases/${caseId}/holds`, request = { reason: "route hold", holdUntil: new Date(Date.now() + 60000).toISOString() };
  expect((await post(holdPath, request, { ...actor, permissions: ["view"] })).status).toBe(400);
  expect((await sql`SELECT hold_id FROM moderation.evidence_holds WHERE case_id = ${caseId}`).length).toBe(0);
  expect((await post(holdPath, request, { ...actor, orgId: "other" })).status).toBe(403);
  const heldResponse = await post(holdPath, request); expect(heldResponse.status).toBe(201);
  expect(heldResponse.headers.get("cache-control")).toBe("no-store"); const held = await heldResponse.json() as { holdId: string };
  await expireCase(caseId); await reports.expire();
  const getPath = `/v1/cases/${caseId}`;
  const ordinary = await api(new Request("https://rooms.example" + getPath, { headers: signCoopRequest(secret, actor, "GET", getPath, "") }));
  expect(JSON.stringify(await ordinary.json())).not.toContain("selected synthetic edit");
  expect((await post(`${getPath}/held-evidence`, { reason: "denied access" }, { ...actor, permissions: ["view", "manage_moderation_records"] })).status).toBe(400);
  const access = await post(`${getPath}/held-evidence`, { reason: "route access" });
  expect(access.status).toBe(200); expect(access.headers.get("cache-control")).toBe("no-store"); expect(await access.json()).toMatchObject({ content: "selected synthetic edit", editedAt: 2 });
  expect((await post(`/v1/holds/${held.holdId}/release`, { reason: "route release" })).status).toBe(200);
});

test("report-only identity expires unheld bytes and skips held bytes without private decision reads", async () => {
  const caseId = await caseRow(), unheld = await caseRow();
  await lifecycle.placeEvidenceHold({ caseId, reason: "report role preservation", holdUntil: new Date(Date.now() + 60000).toISOString() }, actor);
  await expireCase(caseId); await expireCase(unheld);
  const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_reports" }, onnotice: () => {} });
  try {
    await new Lifecycle(client, undefined, communities, {}).expireEvidence();
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(1);
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${unheld}`).length).toBe(0);
    await expect(Promise.resolve(client`SELECT decision_id FROM moderation.decisions LIMIT 0`)).rejects.toThrow(/permission denied/);
  } finally { await client.end(); }
});
test("noncanonical uppercase UUID cannot acquire a different lifecycle boundary", async () => {
  const caseId = await caseRow();
  await expect(lifecycle.placeEvidenceHold({ caseId: caseId.toUpperCase(), reason: "case variant", holdUntil: new Date(Date.now() + 60000).toISOString() }, actor)).rejects.toThrow();
  expect((await sql`SELECT hold_id FROM moderation.evidence_holds WHERE case_id = ${caseId}`).length).toBe(0);
});
