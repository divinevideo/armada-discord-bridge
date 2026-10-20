import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { migrateModeration } from "./policyStore";
// A fresh database makes every run exercise an actual populated 016 -> 017
// upgrade, even when another suite has already bootstrapped the supplied DB.
const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const databaseName = `synthetic_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(process.env.DATABASE_URL!); databaseUrl.pathname = `/${databaseName}`;
const sql = postgres(databaseUrl.toString(), { max: 1, onnotice: () => {} });
const org = `synthetic-lifecycle-${crypto.randomUUID()}`, community = "a".repeat(64);
const openId = crypto.randomUUID(), erasedId = crypto.randomUUID(), caseId = crypto.randomUUID();
async function baseline() {
  const dir = new URL("../db/migrations/", import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => /^0(0[1-9]|1[0-6])_/.test(n)).sort()) await sql.unsafe(await readFile(new URL(name, dir), "utf8"));
}
async function insertDecision(id: string, audit: Buffer | null) {
  await sql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, audit, expires_at)
    VALUES (${id}, ${org}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${caseId}, ${community}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, 'remove_message', false, ${audit}, clock_timestamp() - interval '1 hour')`;
}
// The API never erases audit, so it no longer holds the privilege; the
// operator still reaches the trigger and is refused there.
const auditRefusal = (role: string) => role === "moderation_api" ? /permission denied/ : /audit/i;
// Elapsed time is simulated below the triggers, which pin a real closure to now.
async function backdate(write: (tx: postgres.TransactionSql) => Promise<unknown>) {
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await write(tx); });
}
beforeAll(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  await baseline();
  await insertDecision(openId, Buffer.from("synthetic-existing-ciphertext")); await insertDecision(erasedId, null);
  await migrateModeration(sql);
});
afterAll(async () => {
  await sql.end();
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)}`;
  await admin.end();
});
test("upgrade_keeps_existing_audit_open", async () => {
  const [row] = await sql`SELECT audit, lifecycle_closed_at, audit_delete_after, audit_retention_seconds, appeal_state FROM moderation.decisions WHERE decision_id = ${openId}`;
  expect(Buffer.from(row.audit).toString()).toBe("synthetic-existing-ciphertext");
  expect(row).toMatchObject({ lifecycle_closed_at: null, audit_delete_after: null, audit_retention_seconds: null, appeal_state: "none" });
  await expect(Promise.resolve(sql`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${openId}`)).rejects.toThrow(/audit/i);
  await expect(Promise.resolve(sql`UPDATE moderation.decisions SET audit = ${Buffer.from("replacement")} WHERE decision_id = ${openId}`)).rejects.toThrow(/immutable/i);
});
test("erased_legacy_audit_stays_unavailable", async () => {
  const [row] = await sql`SELECT audit, lifecycle_closed_at, audit_delete_after FROM moderation.decisions WHERE decision_id = ${erasedId}`;
  expect(row).toMatchObject({ audit: null, lifecycle_closed_at: null, audit_delete_after: null });
  await expect(Promise.resolve(sql`UPDATE moderation.decisions SET audit = ${Buffer.from("invented")} WHERE decision_id = ${erasedId}`)).rejects.toThrow(/immutable/i);
});
test("repeat_bootstrap_preserves_narrow_grants", async () => {
  await migrateModeration(sql); await migrateModeration(sql);
  const [privileges] = await sql`SELECT
    has_table_privilege('moderation_api', 'moderation.decisions', 'UPDATE') AS api_wide_update,
    has_table_privilege('moderation_operator', 'moderation.decisions', 'DELETE') AS operator_delete,
    has_column_privilege('moderation_api', 'moderation.decisions', 'appeal_state', 'UPDATE') AS api_appeal,
    has_column_privilege('moderation_api', 'moderation.decisions', 'fingerprint', 'UPDATE') AS api_fingerprint,
    has_table_privilege('moderation_validator', 'moderation.evidence_holds', 'SELECT') AS validator_holds,
    has_table_privilege('moderation_operator', 'moderation.member_order_heads', 'DELETE') AS operator_head_delete,
    has_column_privilege('moderation_api', 'moderation.member_order_heads', 'latest_guild_revision', 'UPDATE') AS guild_fence,
    has_column_privilege('moderation_api', 'moderation.decisions', 'audit', 'UPDATE') AS api_audit,
    has_column_privilege('moderation_operator', 'moderation.decisions', 'audit', 'UPDATE') AS operator_audit`;
  expect(privileges).toEqual({ api_wide_update: false, operator_delete: false, api_appeal: true, api_fingerprint: false, validator_holds: false, operator_head_delete: false, guild_fence: true, api_audit: false, operator_audit: true });
  for (const role of ["moderation_api", "moderation_operator"]) {
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET fingerprint = 'changed' WHERE decision_id = ${openId}`; })).rejects.toThrow(/permission denied/);
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${openId}`; })).rejects.toThrow(auditRefusal(role));
  }
});
test("active_hold_blocks_raw_case_delete", async () => {
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${caseId}, ${org}, ${community}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, ${crypto.randomUUID()}, ${Buffer.from("synthetic-held-evidence")}, clock_timestamp() - interval '1 hour')`;
  const holdId = crypto.randomUUID();
  await sql`INSERT INTO moderation.evidence_holds (hold_id, org_id, case_id, hold_until, encrypted_audit) VALUES (${holdId}, ${org}, ${caseId}, clock_timestamp() + interval '1 hour', ${Buffer.from("synthetic-hold-audit")})`;
  await expect(Promise.resolve(sql`DELETE FROM moderation.cases WHERE case_id = ${caseId}`)).rejects.toThrow(/hold/i);
  await sql`UPDATE moderation.evidence_holds SET released_at = clock_timestamp() WHERE hold_id = ${holdId}`;
  await sql`DELETE FROM moderation.cases WHERE case_id = ${caseId}`;
  expect((await sql`SELECT hold_id FROM moderation.evidence_holds WHERE hold_id = ${holdId}`).length).toBe(1);
});

test("audit cleanup requires an elapsed independent lifecycle and preserves execution identity", async () => {
  const id = crypto.randomUUID(); await insertDecision(id, Buffer.from("synthetic-eligible-audit"));
  await backdate(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 hours', audit_retention_seconds = 3600, audit_delete_after = clock_timestamp() - interval '1 hour' WHERE decision_id = ${id}`);
  await sql.begin(async tx => { await tx`SET LOCAL ROLE moderation_operator`; await tx`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${id}`; });
  const [row] = await sql`SELECT audit, fingerprint, execution_id FROM moderation.decisions WHERE decision_id = ${id}`;
  expect(row.audit).toBeNull(); expect(row.execution_id).toBeString(); expect(row.fingerprint).toBeString();
});
test("event retention scheduling preserves immutable audit and never shortens a stored deadline", async () => {
  const eventId = crypto.randomUUID();
  await sql`INSERT INTO moderation.lifecycle_events (event_id, org_id, decision_id, kind, encrypted_audit) VALUES (${eventId}, ${org}, ${openId}, 'appeal_opened', ${Buffer.from("synthetic-event-audit")})`;
  await sql.begin(async tx => { await tx`SET LOCAL ROLE moderation_operator`; await tx`UPDATE moderation.lifecycle_events SET audit_delete_after = clock_timestamp() + interval '1 day' WHERE event_id = ${eventId}`; });
  await expect(Promise.resolve(sql`UPDATE moderation.lifecycle_events SET audit_delete_after = clock_timestamp() WHERE event_id = ${eventId}`)).rejects.toThrow(/shorten/i);
  await expect(Promise.resolve(sql`UPDATE moderation.lifecycle_events SET encrypted_audit = ${Buffer.from("replacement")} WHERE event_id = ${eventId}`)).rejects.toThrow(/immutable/i);
  await expect(sql.begin(async tx => { await tx`SET LOCAL ROLE moderation_api`; await tx`UPDATE moderation.lifecycle_events SET audit_delete_after = clock_timestamp() + interval '2 days' WHERE event_id = ${eventId}`; })).rejects.toThrow(/permission denied/i);
});
test("cross-organization lifecycle references and unfenced generation3 are refused", async () => {
  await expect(Promise.resolve(sql`INSERT INTO moderation.lifecycle_events (event_id, org_id, decision_id, kind, encrypted_audit) VALUES (${crypto.randomUUID()}, 'different-synthetic-org', ${openId}, 'appeal_opened', ${Buffer.from("synthetic")})`)).rejects.toThrow(/foreign key/i);
  await expect(Promise.resolve(sql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at, fingerprint_version, reverses_decision_id)
    VALUES (${crypto.randomUUID()}, ${org}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${caseId}, ${community}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, 'unban_member', false, clock_timestamp() + interval '1 hour', 3, ${openId})`)).rejects.toThrow(/check constraint/i);
});

for (const role of ["moderation_api", "moderation_operator"]) {
  test(`${role} cannot shorten a closed decision deadline or replace its policy snapshot before cleanup`, async () => {
    const id = crypto.randomUUID(); await insertDecision(id, Buffer.from("synthetic-future-deadline-audit"));
    await backdate(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 hours', audit_retention_seconds = 86400, audit_delete_after = clock_timestamp() + interval '22 hours' WHERE decision_id = ${id}`);
    await expect(sql.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`UPDATE moderation.decisions SET audit_delete_after = clock_timestamp() - interval '1 hour' WHERE decision_id = ${id}`;
    })).rejects.toThrow(/deadline|retention|snapshot/i);
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${id}`; })).rejects.toThrow(auditRefusal(role));
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET audit_retention_seconds = 1 WHERE decision_id = ${id}`; })).rejects.toThrow(/snapshot|retention/i);
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '3 hours' WHERE decision_id = ${id}`; })).rejects.toThrow(/closure|immutable/i);
    const [row] = await sql`SELECT audit, audit_retention_seconds::text AS retention FROM moderation.decisions WHERE decision_id = ${id}`;
    expect(Buffer.from(row.audit).toString()).toBe("synthetic-future-deadline-audit"); expect(row.retention).toBe("86400");
    await sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET lifecycle_closed_at = NULL, audit_delete_after = NULL, appeal_state = 'open' WHERE decision_id = ${id}`; });
    expect((await sql`SELECT lifecycle_closed_at, audit_delete_after, appeal_state FROM moderation.decisions WHERE decision_id = ${id}`)[0]).toMatchObject({ lifecycle_closed_at: null, audit_delete_after: null, appeal_state: "open" });
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${id}`; })).rejects.toThrow(auditRefusal(role));
  });
}
for (const role of ["moderation_api", "moderation_operator"]) {
  test(`${role} cannot backdate a lifecycle closure or close with a deadline shorter than its retention`, async () => {
    const id = crypto.randomUUID(); await insertDecision(id, Buffer.from("synthetic-closure-audit"));
    const as = (write: (tx: postgres.TransactionSql) => Promise<unknown>) => sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await write(tx); });
    // A new closure records this transaction, even if a past deadline is internally consistent.
    await expect(as(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 hours', audit_retention_seconds = 3600, audit_delete_after = clock_timestamp() - interval '1 hour' WHERE decision_id = ${id}`)).rejects.toThrow(/closure/i);
    await expect(as(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() + interval '1 day', audit_retention_seconds = 60, audit_delete_after = clock_timestamp() + interval '2 days' WHERE decision_id = ${id}`)).rejects.toThrow(/closure/i);
    await expect(as(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp(), audit_retention_seconds = 3600, audit_delete_after = clock_timestamp() WHERE decision_id = ${id}`)).rejects.toThrow(/retention/i);
    await expect(as(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() WHERE decision_id = ${id}`)).rejects.toThrow(/retention/i);
    expect((await sql`SELECT lifecycle_closed_at FROM moderation.decisions WHERE decision_id = ${id}`)[0].lifecycle_closed_at).toBeNull();
    // The application's close: both times from clock_timestamp() in one statement.
    await as(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp(), audit_retention_seconds = 60, audit_delete_after = clock_timestamp() + (60 * interval '1 second') WHERE decision_id = ${id}`);
    // Reopen and close again, as an appeal does.
    await as(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = NULL, audit_delete_after = NULL, appeal_state = 'open' WHERE decision_id = ${id}`);
    await as(tx => tx`UPDATE moderation.decisions SET appeal_state = 'closed', lifecycle_closed_at = clock_timestamp(), audit_delete_after = clock_timestamp() + (60 * interval '1 second') WHERE decision_id = ${id}`);
    const [row] = await sql`SELECT lifecycle_closed_at, audit_delete_after, audit FROM moderation.decisions WHERE decision_id = ${id}`;
    expect(row.audit_delete_after.getTime() - row.lifecycle_closed_at.getTime()).toBeGreaterThanOrEqual(60000);
    expect(Buffer.from(row.audit).toString()).toBe("synthetic-closure-audit");
  });
  test(`${role} cannot give a closed decision without a deadline one shorter than its retention`, async () => {
    // Closures recorded before this guard may lack a deadline; the shorten check only covers an existing one.
    const id = crypto.randomUUID(); await insertDecision(id, Buffer.from("synthetic-undated-audit"));
    await backdate(tx => tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 hours', audit_retention_seconds = 86400 WHERE decision_id = ${id}`);
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET audit_delete_after = clock_timestamp() - interval '1 hour' WHERE decision_id = ${id}`; })).rejects.toThrow(/retention/i);
    expect((await sql`SELECT audit_delete_after FROM moderation.decisions WHERE decision_id = ${id}`)[0].audit_delete_after).toBeNull();
  });
}
test("lifecycle events cannot mix explicit, hold and decision case identities", async () => {
  const a = crypto.randomUUID(), b = crypto.randomUUID(), holdId = crypto.randomUUID();
  for (const id of [a, b]) await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${id}, ${org}, ${community}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, ${crypto.randomUUID()}, ${Buffer.from("synthetic-reference-evidence")}, clock_timestamp() - interval '1 hour')`;
  await sql`INSERT INTO moderation.evidence_holds (hold_id, org_id, case_id, hold_until, encrypted_audit) VALUES (${holdId}, ${org}, ${a}, clock_timestamp() + interval '1 hour', ${Buffer.from("synthetic-reference-hold")})`;
  await expect(sql.begin(async tx => {
    await tx`SET LOCAL ROLE moderation_api`;
    await tx`INSERT INTO moderation.lifecycle_events (event_id, org_id, case_id, hold_id, kind, encrypted_audit, recorded_at, audit_delete_after)
      VALUES (${crypto.randomUUID()}, ${org}, ${b}, ${holdId}, 'held_evidence_access', ${Buffer.from("synthetic-mismatched-event")}, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour')`;
  })).rejects.toThrow(/case.*mismatch|inconsistent/i);
  await expect(sql.begin(async tx => {
    await tx`SET LOCAL ROLE moderation_api`;
    await tx`INSERT INTO moderation.lifecycle_events (event_id, org_id, decision_id, hold_id, kind, encrypted_audit)
      VALUES (${crypto.randomUUID()}, ${org}, ${openId}, ${holdId}, 'held_evidence_access', ${Buffer.from("synthetic-mismatched-event")})`;
  })).rejects.toThrow(/case.*mismatch|inconsistent/i);
  await expect(sql.begin(async tx => {
    await tx`SET LOCAL ROLE moderation_api`;
    await tx`INSERT INTO moderation.lifecycle_events (event_id, org_id, case_id, decision_id, kind, encrypted_audit)
      VALUES (${crypto.randomUUID()}, ${org}, ${b}, ${openId}, 'appeal_opened', ${Buffer.from("synthetic-mismatched-decision-event")})`;
  })).rejects.toThrow(/case.*mismatch|inconsistent/i);
  // Model an inconsistent row written before this guard was installed. Only
  // fixture setup bypasses triggers; deletion runs under the real runtime role.
  const legacyEventId = crypto.randomUUID();
  await sql.begin(async tx => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO moderation.lifecycle_events (event_id, org_id, case_id, hold_id, kind, encrypted_audit, recorded_at, audit_delete_after)
      VALUES (${legacyEventId}, ${org}, ${b}, ${holdId}, 'held_evidence_access', ${Buffer.from("synthetic-inconsistent-legacy-event")}, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour')`;
  });
  await expect(sql.begin(async tx => { await tx`SET LOCAL ROLE moderation_operator`; await tx`DELETE FROM moderation.lifecycle_events WHERE event_id = ${legacyEventId}`; })).rejects.toThrow(/case.*mismatch|inconsistent/i);
  const eventId = crypto.randomUUID();
  await sql`INSERT INTO moderation.lifecycle_events (event_id, org_id, hold_id, kind, encrypted_audit, recorded_at, audit_delete_after)
    VALUES (${eventId}, ${org}, ${holdId}, 'held_evidence_access', ${Buffer.from("synthetic-reference-event")}, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour')`;
  await expect(sql.begin(async tx => { await tx`SET LOCAL ROLE moderation_operator`; await tx`DELETE FROM moderation.lifecycle_events WHERE event_id = ${eventId}`; })).rejects.toThrow(/retention|hold/i);
  expect((await sql`SELECT case_id FROM moderation.lifecycle_events WHERE event_id = ${eventId}`)[0].case_id).toBe(a);
  expect((await sql`SELECT event_id FROM moderation.lifecycle_events WHERE event_id = ${legacyEventId}`).length).toBe(1);
});
