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
    has_column_privilege('moderation_api', 'moderation.member_order_heads', 'latest_guild_revision', 'UPDATE') AS guild_fence`;
  expect(privileges).toEqual({ api_wide_update: false, operator_delete: false, api_appeal: true, api_fingerprint: false, validator_holds: false, operator_head_delete: false, guild_fence: true });
  for (const role of ["moderation_api", "moderation_operator"]) {
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET fingerprint = 'changed' WHERE decision_id = ${openId}`; })).rejects.toThrow(/permission denied/);
    await expect(sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${openId}`; })).rejects.toThrow(/audit/i);
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
  await sql`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 hours', audit_retention_seconds = 3600, audit_delete_after = clock_timestamp() - interval '1 hour' WHERE decision_id = ${id}`;
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
