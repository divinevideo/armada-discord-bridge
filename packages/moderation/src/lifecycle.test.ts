import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { migrateModeration, PolicyStore } from "./policyStore";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { refreshPolicy } from "../../../scripts/fixtures/relay-events";
import { EvidenceCipher } from "./evidence";
import { Lifecycle } from "./lifecycle";
import { Reports } from "./reports";
import { expireModerationRecords } from "./runtime";
import { Decisions } from "./decisions";
import { DiscordRestrictionObserver } from "./discordRestriction";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const f = await moderationFixture();
const org = `synthetic-b2-${crypto.randomUUID()}`, community = f.community.idHex;
const cipher = new EvidenceCipher(randomBytes(32), 3600, 200000), communities = new Map([[community, org]]);
const actor = { orgId: org, actorId: "synthetic-admin", permissions: ["view", "manage_moderation_records", "view_held_evidence"] };
const lifecycle = new Lifecycle(sql, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
const reports = new Reports(sql, cipher, { resolve: async () => { throw new Error("unused"); } }, communities, 10, lifecycle);
// Membership closure reads every decision for the member in its org, so these
// tests keep their own org rather than share rows with the removal tests above.
const memberOrg = `synthetic-member-${crypto.randomUUID()}`, memberScope = new Map([[community, memberOrg]]);
const memberActor = { orgId: memberOrg, actorId: "synthetic-admin", permissions: ["view", "remove_message", "ban_member", "unban_member", "manage_moderation_records"] };
const memberPolicy = { auditRetentionSeconds: 60, holdMaxSeconds: 3600 };
beforeAll(async () => { await migrateModeration(sql); await new PolicyStore(sql).install(refreshPolicy(f.policy), [f.chatStream, f.controlStream, f.guestbookStream], 0); });
afterAll(async () => {
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; for (const o of [org, memberOrg]) { await tx`DELETE FROM moderation.lifecycle_events WHERE org_id = ${o}`; await tx`DELETE FROM moderation.evidence_holds WHERE org_id = ${o}`; await tx`DELETE FROM moderation.decisions WHERE org_id = ${o}`; await tx`DELETE FROM moderation.cases WHERE org_id = ${o}`; await tx`DELETE FROM moderation.member_order_heads WHERE org_id = ${o}`; } await tx`DELETE FROM moderation.community_policy WHERE community_id = ${community}`; }); await sql.end();
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
  expect(await lifecycle.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 60000).toISOString(), reason: "duplicate" }, actor)).toEqual(held);
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
const holdMs = 3600 * 1000;
const holdsOf = (caseId: string) => sql`SELECT hold_id, hold_until, released_at FROM moderation.evidence_holds WHERE case_id = ${caseId} ORDER BY created_at`;
const eventsOf = (caseId: string, kind: string) => sql`SELECT hold_id FROM moderation.lifecycle_events WHERE case_id = ${caseId} AND kind = ${kind}`;
test("a later hold request extends the active hold, audited, and never shortens it", async () => {
  const caseId = await caseRow(), first = new Date(Date.now() + 120000).toISOString();
  const held = await lifecycle.placeEvidenceHold({ caseId, holdUntil: first, reason: "synthetic hold" }, actor);
  const later = new Date(Date.now() + 600000).toISOString();
  const extended = await lifecycle.placeEvidenceHold({ caseId, holdUntil: later, reason: "longer preservation" }, actor);
  expect(extended).toEqual({ ...held, holdUntil: later });
  expect((await holdsOf(caseId)).map(h => h.hold_until.toISOString())).toEqual([later]);
  expect((await eventsOf(caseId, "hold_extended")).map(e => e.hold_id)).toEqual([held.holdId]);
  expect(await lifecycle.placeEvidenceHold({ caseId, holdUntil: first, reason: "shorter request" }, actor)).toEqual(extended);
  expect((await eventsOf(caseId, "hold_extended")).length).toBe(1);
});
test("extension beyond the configured maximum is refused and leaves the hold unchanged", async () => {
  const caseId = await caseRow(), held = await lifecycle.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 120000).toISOString(), reason: "synthetic hold" }, actor);
  await expect(lifecycle.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + holdMs + 60000).toISOString(), reason: "too long" }, actor)).rejects.toThrow(/deadline/);
  expect((await holdsOf(caseId)).map(h => h.hold_until.toISOString())).toEqual([held.holdUntil]);
  expect((await eventsOf(caseId, "hold_extended")).length).toBe(0);
});
test("an active hold extends after the case's natural expiry, through the restricted API role", async () => {
  const caseId = await caseRow(), client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice: () => {} });
  try {
    const api = new Lifecycle(client, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
    const held = await api.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 120000).toISOString(), reason: "synthetic hold" }, actor);
    await expireCase(caseId); await lifecycle.expireEvidence();
    const later = new Date(Date.now() + 900000).toISOString();
    expect(await api.placeEvidenceHold({ caseId, holdUntil: later, reason: "renewal after expiry" }, actor)).toEqual({ ...held, holdUntil: later });
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(1);
  } finally { await client.end(); }
});
test("hold deadlines move only forward, only while active, and only for the deadline column", async () => {
  const caseId = await caseRow(), held = await lifecycle.placeEvidenceHold({ caseId, holdUntil: new Date(Date.now() + 120000).toISOString(), reason: "synthetic hold" }, actor);
  await expect(Promise.resolve(sql`UPDATE moderation.evidence_holds SET hold_until = hold_until - interval '1 second' WHERE hold_id = ${held.holdId}`)).rejects.toThrow(/hold/i);
  await expect(Promise.resolve(sql`UPDATE moderation.evidence_holds SET hold_until = hold_until + interval '1 minute', encrypted_audit = ${Buffer.from("replacement")} WHERE hold_id = ${held.holdId}`)).rejects.toThrow(/immutable/i);
  await expect(Promise.resolve(sql`UPDATE moderation.evidence_holds SET hold_until = hold_until + interval '1 minute', released_at = clock_timestamp() WHERE hold_id = ${held.holdId}`)).rejects.toThrow(/hold/i);
  await lifecycle.releaseEvidenceHold({ holdId: held.holdId, reason: "synthetic release" }, actor);
  await expect(Promise.resolve(sql`UPDATE moderation.evidence_holds SET hold_until = hold_until + interval '1 minute' WHERE hold_id = ${held.holdId}`)).rejects.toThrow(/hold/i);
});
test("opening an appeal holds the case's evidence to the configured maximum, extending an active hold", async () => {
  const caseId = await caseRow(), decisionId = await decisionRow(caseId), before = Date.now();
  await lifecycle.setAppeal({ decisionId, state: "open", reason: "member appeal" }, actor);
  const [hold] = await holdsOf(caseId);
  expect(hold.released_at).toBeNull();
  expect(hold.hold_until.getTime()).toBeGreaterThanOrEqual(before + holdMs);
  expect(hold.hold_until.getTime()).toBeLessThanOrEqual(Date.now() + holdMs);
  expect((await eventsOf(caseId, "hold_created")).map(e => e.hold_id)).toEqual([hold.hold_id]);
  const other = await caseRow(), otherDecision = await decisionRow(other);
  const short = await lifecycle.placeEvidenceHold({ caseId: other, holdUntil: new Date(Date.now() + 60000).toISOString(), reason: "staff hold" }, actor);
  await expireCase(other); await lifecycle.expireEvidence();
  await lifecycle.setAppeal({ decisionId: otherDecision, state: "open", reason: "appeal after expiry" }, actor);
  const holds = await holdsOf(other);
  expect(holds.map(h => h.hold_id)).toEqual([short.holdId]);
  expect(holds[0].hold_until.getTime()).toBeGreaterThan(Date.now() + holdMs - 60000);
  expect((await eventsOf(other, "hold_extended")).map(e => e.hold_id)).toEqual([short.holdId]);
});
test("an appeal on an expired, unheld case opens without creating a hold", async () => {
  for (const erased of [false, true]) {
    const caseId = await caseRow(), decisionId = await decisionRow(caseId);
    await expireCase(caseId); if (erased) await lifecycle.expireEvidence();
    expect((await lifecycle.setAppeal({ decisionId, state: "open", reason: "late appeal" }, actor)).appealState).toBe("open");
    expect((await holdsOf(caseId)).length).toBe(0);
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(erased ? 0 : 1);
  }
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
  // The appeal's evidence hold outlives the appeal until staff release it.
  await expect(lifecycle.closeLifecycle({ decisionId, reason: "held" }, actor)).rejects.toThrow(/not eligible/);
  for (const hold of await holdsOf(caseId)) await lifecycle.releaseEvidenceHold({ holdId: hold.hold_id, reason: "appeal settled" }, actor);
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

async function memberCase(author: string, id: string = crypto.randomUUID()) {
  const evidence = cipher.seal(`${memberOrg}:${id}`, { evidence: { content: "synthetic member report", createdAt: 1 }, reason: "synthetic report" });
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at) VALUES (${id}, ${memberOrg}, ${community}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${author}, ${crypto.randomUUID()}, ${evidence}, clock_timestamp() + interval '1 hour')`; return id;
}
function memberDecision(caseId: string, action: "ban_member" | "unban_member", revision: string) {
  return new Decisions(sql, cipher, memberScope, memberPolicy).acceptDecision({ caseId, executionId: crypto.randomUUID(), action, reason: "synthetic membership", scope: "community", discordGuildConfirmed: false, sourceOrder: { version: 1, revision } }, memberActor);
}
/** Stands in for the worker having delivered every target (no Guild scope, no Discord member). */
async function settleMember(decisionId: string) {
  await sql`UPDATE moderation.deliveries SET state = CASE WHEN target = 'discord' THEN 'not_applicable' ELSE 'verified' END, token = NULL, lease_until = NULL, available_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${decisionId}`;
}
function observeMember(decisionId: string) {
  return new DiscordRestrictionObserver(sql, { async messages() { return []; }, async member() { return undefined; } }, { async assertPublicChannel() {} }, async () => { throw new Error("unused"); }, memberScope).refresh(decisionId);
}
test("a ban superseded before any send does not keep the member's settled unban open", async () => {
  const author = randomBytes(32).toString("hex"), caseId = await memberCase(author);
  const ban = await memberDecision(caseId, "ban_member", "1"), unban = await memberDecision(caseId, "unban_member", "2");
  // The claim sweep supersedes the unsent ban. Another suite's leftover row may
  // be the one claimed; put it back untouched.
  const decisions = new Decisions(sql, cipher, memberScope, memberPolicy), claimed = await decisions.claim();
  if (claimed && claimed.decision.orgId !== memberOrg) await decisions.defer(claimed);
  const superseded = await sql`SELECT target, state, result_code, publication_attempted, publication_event_ids FROM moderation.deliveries WHERE decision_id = ${ban.decisionId} ORDER BY target`;
  // publication_attempted keeps its conservative default: it cannot say "never sent".
  expect(superseded.map(r => ({ ...r }))).toEqual(["concord", "discord", "divine_relay"].map(target => ({ target, state: "failed", result_code: "superseded_by_newer_decision", publication_attempted: true, publication_event_ids: null })));
  await settleMember(unban.decisionId);
  expect(await observeMember(unban.decisionId)).toBe(true);
  const closed = await new Lifecycle(sql, cipher, memberScope, memberPolicy).closeLifecycle({ decisionId: unban.decisionId, reason: "settled unban" }, memberActor);
  expect(closed.closedAt).toBeString();
});
// Closure, and later audit erasure, require the member to be unbanned
// everywhere. Each case leaves a settled ban -> unban pair with fresh Discord
// proof, and keeps the member banned by exactly one source.
async function setRelayBlock(author: string, blocked: boolean) {
  await sql`INSERT INTO moderation.member_bans (community_id, author, blocked) VALUES (${community}, ${author}, ${blocked}) ON CONFLICT (community_id, author) DO UPDATE SET blocked = EXCLUDED.blocked`;
}
const stillBanned = [
  { source: "a newer settled ban is the member's latest decision", author: () => randomBytes(32).toString("hex"),
    async arrange(caseId: string, _author: string, base: number) { await settleMember((await memberDecision(caseId, "ban_member", String(base + 3))).decisionId); } },
  // The relay unblock landed, but the Concord banlist fold still names the member.
  { source: "the Concord banlist still bans the member", author: () => f.bannedMember.pk,
    async arrange(_caseId: string, author: string) { await setRelayBlock(author, false); } },
  // PolicyStore also folds this override into policy.banned, so that check and
  // the direct member_bans read each refuse it on their own.
  { source: "the relay still blocks the member", author: () => randomBytes(32).toString("hex"),
    async arrange(_caseId: string, author: string) { await setRelayBlock(author, true); } },
];
for (const [index, scenario] of stillBanned.entries()) {
  test(`closure is refused while ${scenario.source}`, async () => {
    const author = scenario.author(), caseId = await memberCase(author);
    const ban = await memberDecision(caseId, "ban_member", "1"), unban = await memberDecision(caseId, "unban_member", "2");
    await settleMember(ban.decisionId); await settleMember(unban.decisionId);
    await scenario.arrange(caseId, author, 0);
    expect(await observeMember(ban.decisionId)).toBe(true);
    await expect(new Lifecycle(sql, cipher, memberScope, memberPolicy).closeLifecycle({ decisionId: ban.decisionId, reason: `still banned ${index}` }, memberActor)).rejects.toThrow(/not eligible/);
    expect((await sql`SELECT lifecycle_closed_at FROM moderation.decisions WHERE decision_id = ${ban.decisionId}`)[0].lifecycle_closed_at).toBeNull();
  });
  test(`elapsed audit is kept while ${scenario.source}`, async () => {
    const author = scenario.author(), caseId = await memberCase(author);
    const ban = await memberDecision(caseId, "ban_member", "11"), unban = await memberDecision(caseId, "unban_member", "12");
    await settleMember(ban.decisionId); await settleMember(unban.decisionId);
    // Closed while the member was unbanned, retention since elapsed.
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 minutes', audit_retention_seconds = 60, audit_delete_after = clock_timestamp() - interval '1 minute' WHERE decision_id = ${ban.decisionId}`; });
    await scenario.arrange(caseId, author, 10);
    expect(await observeMember(ban.decisionId)).toBe(true);
    const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice: () => {} });
    try { await new Lifecycle(client, undefined, memberScope, {}).expireAudit(); } finally { await client.end(); }
    expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${ban.decisionId}`)[0].audit).not.toBeNull();
  });
}

// Expiry runs inside the worker loop: a row the database refuses must not end
// the pass, or every row after it stays due and the worker reports unready.
// Case IDs are chosen so the refused row sorts first within this org.
const sortedCase = (first: string) => first + crypto.randomUUID().slice(1);
async function closedElapsed(decisionId: string) {
  await new Lifecycle(sql, cipher, memberScope, memberPolicy).closeLifecycle({ decisionId, reason: "settled" }, memberActor);
  await sql.begin(async tx => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '3 minutes', audit_delete_after = clock_timestamp() - interval '2 minutes' WHERE decision_id = ${decisionId}`;
    await tx`UPDATE moderation.lifecycle_events SET recorded_at = clock_timestamp() - interval '3 minutes' WHERE decision_id = ${decisionId}`;
  });
}
/** A removal whose audit and journal are due, in an expired case. */
async function dueRemoval(caseId: string) {
  await memberCase(randomBytes(32).toString("hex"), caseId);
  const removal = await new Decisions(sql, cipher, memberScope, memberPolicy).acceptDecision({ caseId, executionId: crypto.randomUUID(), action: "remove_message", reason: "synthetic removal", scope: "message", discordGuildConfirmed: false }, memberActor);
  await settleMember(removal.decisionId); await closedElapsed(removal.decisionId);
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.cases SET expires_at = clock_timestamp() - interval '1 second' WHERE case_id = ${caseId}`; });
  return removal.decisionId;
}
async function cleared(decisionId: string) {
  const [row] = await sql`SELECT audit IS NULL AS erased, (SELECT count(*)::int FROM moderation.lifecycle_events e WHERE e.decision_id = ${decisionId}) AS events FROM moderation.decisions WHERE decision_id = ${decisionId}`;
  return row;
}
async function forget(decisionIds: string[]) {
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`DELETE FROM moderation.lifecycle_events WHERE decision_id IN ${tx(decisionIds)}`; await tx`DELETE FROM moderation.decisions WHERE decision_id IN ${tx(decisionIds)}`; });
}
test("a per-decision database failure does not stop later due audit cleanup in the same pass", async () => {
  const first = await dueRemoval(sortedCase("0")), later = await dueRemoval(sortedCase("f"));
  const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice: () => {} });
  // Produce an actual SQL failure for one audit write, independently of the
  // eligibility rules: changing those rules must not remove isolation coverage.
  const faulty = new Proxy(client, { get(target, key) { if (key !== "begin") return Reflect.get(target, key); return (callback: any) => client.begin(tx => callback(new Proxy(tx, { apply(target, receiver, args) { if (String(args[0]?.[0]).startsWith("UPDATE moderation.decisions SET audit = NULL") && args.includes(first)) return tx`SELECT 1/0`; return Reflect.apply(target, receiver, args); } }))); } });
  try {
    await expireModerationRecords(new Decisions(client, undefined, memberScope), new Lifecycle(faulty, undefined, memberScope, {}));
    expect(await cleared(later)).toEqual({ erased: true, events: 0 });
    expect(await cleared(first)).toEqual({ erased: false, events: 1 });
  } finally { await client.end(); }
});
test("a case whose hold and journal cleanup fails does not stop later cases in the same pass", async () => {
  const failing = sortedCase("0"), later = sortedCase("f");
  const first = await dueRemoval(failing), second = await dueRemoval(later);
  const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice: () => {} });
  // Fail only the per-case journal pass for the first case.
  const faulty = new Proxy(client, { get(target, key) { if (key !== "begin") return Reflect.get(target, key); return (callback: any) => client.begin(tx => callback(new Proxy(tx, { apply(target, receiver, args) { if (String(args[0]?.[0]).startsWith("SELECT DISTINCT community_id, author FROM moderation.decisions") && args.includes(failing)) return tx`SELECT 1/0`; return Reflect.apply(target, receiver, args); } }))); } });
  try {
    await new Lifecycle(faulty, undefined, memberScope, {}).expireAudit();
    expect(await cleared(first)).toEqual({ erased: true, events: 1 });
    expect(await cleared(second)).toEqual({ erased: true, events: 0 });
  } finally { await client.end(); }
});

for (const code of ["concord_publication_settled", "concord_superseded_publication_settled"]) test(`operator audit cleanup honors settled canonical receipt ${code} after independent retention and repeated boot`, async () => {
  const author = randomBytes(32).toString("hex"), caseId = await memberCase(author);
  const ban = await memberDecision(caseId, "ban_member", "1"), unban = await memberDecision(caseId, "unban_member", "2");
  await settleMember(ban.decisionId); await settleMember(unban.decisionId);
  await sql`UPDATE moderation.deliveries SET state = 'not_applicable', result_code = ${code}, publication_event_ids = ARRAY[${randomBytes(32).toString("hex")}] WHERE decision_id = ${ban.decisionId} AND target = 'concord'`;
  expect(await observeMember(ban.decisionId)).toBe(true);
  const api = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
  const operator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
  try {
    const before = (await sql`SELECT audit, execution_id, fingerprint FROM moderation.decisions WHERE decision_id = ${ban.decisionId}`)[0];
    const receipt = (await sql`SELECT publication_event_ids, publication_attempted, attempts, state, result_code FROM moderation.deliveries WHERE decision_id = ${ban.decisionId} AND target = 'concord'`)[0];
    const staff = new Lifecycle(api, cipher, memberScope, memberPolicy), cleanup = new Lifecycle(operator, undefined, memberScope, {});
    expect((await staff.closeLifecycle({ decisionId: ban.decisionId, reason: "settled membership" }, memberActor)).closedAt).toBeString();
    await cleanup.expireAudit();
    expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${ban.decisionId}`)[0].audit).toEqual(before.audit);
    await closedElapsed(ban.decisionId);
    const snapshot = await sql`SELECT to_jsonb(c) AS row FROM moderation.decisions c WHERE decision_id = ${ban.decisionId}`;
    await migrateModeration(sql); await migrateModeration(sql);
    expect((await sql`SELECT to_jsonb(c) AS row FROM moderation.decisions c WHERE decision_id = ${ban.decisionId}`)[0].row).toEqual(snapshot[0].row);
    if (code === "concord_publication_settled") await cleanup.expireAudit();
    else await operator`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${ban.decisionId}`;
    expect((await sql`SELECT audit, execution_id, fingerprint FROM moderation.decisions WHERE decision_id = ${ban.decisionId}`)[0]).toEqual({ ...before, audit: null });
    expect((await sql`SELECT publication_event_ids, publication_attempted, attempts, state, result_code FROM moderation.deliveries WHERE decision_id = ${ban.decisionId} AND target = 'concord'`)[0]).toEqual(receipt);
  } finally { await api.end(); await operator.end(); }
});
for (const [state, code] of [["not_applicable", null], ["not_applicable", "concord_recovery_awaiting_proof"], ["failed", "concord_publication_settled"], ["pending", "concord_publication_settled"]] as const) test(`unknown receipt ${state}/${code} cannot close or erase audit`, async () => {
  const author = randomBytes(32).toString("hex"), caseId = await memberCase(author);
  const ban = await memberDecision(caseId, "ban_member", "1"), unban = await memberDecision(caseId, "unban_member", "2");
  await settleMember(ban.decisionId); await settleMember(unban.decisionId);
  await sql`UPDATE moderation.deliveries SET state = ${state}, result_code = ${code} WHERE decision_id = ${ban.decisionId} AND target = 'concord'`;
  expect(await observeMember(ban.decisionId)).toBe(true);
  await expect(new Lifecycle(sql, cipher, memberScope, memberPolicy).closeLifecycle({ decisionId: ban.decisionId, reason: "unknown publication" }, memberActor)).rejects.toThrow(/not eligible/);
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 minutes', audit_retention_seconds = 60, audit_delete_after = clock_timestamp() - interval '1 minute' WHERE decision_id = ${ban.decisionId}`; });
  const operator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
  try {
    await expect(Promise.resolve(operator`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${ban.decisionId}`)).rejects.toThrow(/not eligible/);
    await new Lifecycle(operator, undefined, memberScope, {}).expireAudit();
    expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${ban.decisionId}`)[0].audit).not.toBeNull();
  } finally { await operator.end(); }
});
