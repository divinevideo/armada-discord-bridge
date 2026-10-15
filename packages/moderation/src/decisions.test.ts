import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { migrateModeration } from "./policyStore";
import { Decisions } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { collectMetrics } from "./metrics";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const org = crypto.randomUUID(), caseId = crypto.randomUUID(), executionId = crypto.randomUUID();
const actor = { orgId: org, actorId: "synthetic-reviewer", permissions: ["remove_message", "ban_member", "unban_member", "retry"] };
const input = { caseId, executionId, action: "remove_message" as const, reason: "Synthetic removal", scope: "message" as const, discordGuildConfirmed: false };
const cipher = new EvidenceCipher(randomBytes(32), 3600, 100_000);
let decisions: Decisions;
beforeAll(async () => {
  await migrateModeration(sql);
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${caseId}, ${org}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
  decisions = new Decisions(sql, cipher, new Map([["a".repeat(64), org]]));
});
afterAll(async () => { await sql`DELETE FROM moderation.decisions WHERE org_id = ${org}`; await sql`DELETE FROM moderation.cases WHERE org_id = ${org}`; await sql.end(); });
test("acceptance atomically queues three independent deliveries and immutable replay", async () => {
  const first = await decisions.acceptDecision(input, actor);
  expect(first.deliveries.map((d) => d.state)).toEqual(["pending", "pending", "pending"]);
  expect((await decisions.acceptDecision(input, actor)).decisionId).toBe(first.decisionId);
  await expect(decisions.acceptDecision({ ...input, reason: "changed" }, actor)).rejects.toThrow(/conflict/i);
  await expect(decisions.acceptDecision(input, { ...actor, actorId: "another-reviewer" })).rejects.toThrow(/conflict/i);
  await expect(decisions.get(first.decisionId, { ...actor, orgId: "different-org" })).rejects.toThrow();
  await expect(decisions.retry(first.decisionId, { ...actor, permissions: [] })).rejects.toThrow();
  const claim = await decisions.claim();
  expect(claim).toBeDefined();
  await decisions.complete(claim!, "verified", "removed");
  const status = await decisions.get(first.decisionId, actor);
  expect(status.deliveries.filter((d) => d.state === "verified")).toHaveLength(1);
  expect(status.deliveries.filter((d) => d.state === "pending")).toHaveLength(2);
});
test("unknown actors, missing scope confirmation and caller targets are rejected", async () => {
  await expect(decisions.acceptDecision(input, { ...actor, actorId: "" })).rejects.toThrow();
  await expect(decisions.acceptDecision({ ...input, action: "ban_member" }, actor)).rejects.toThrow();
  await expect(decisions.acceptDecision({ ...input, target: { author: "e".repeat(64) } } as any, actor)).rejects.toThrow();
  // Community authority must not silently expand to the entire Discord guild.
  await expect(decisions.acceptDecision({ ...input, executionId: crypto.randomUUID(), action: "ban_member", scope: "community", discordGuildConfirmed: true }, actor)).rejects.toThrow(/Staff authorization required/);
});

test("crashed delivery is reclaimed with persisted events and a stale worker cannot finish", async () => {
  const claim = await decisions.claim();
  expect(claim).toBeDefined();
  await decisions.saveEvents(claim!, [{ id: "e".repeat(64) }]);
  await sql`UPDATE moderation.deliveries SET lease_until = clock_timestamp() - interval '1 second' WHERE decision_id = ${claim!.decision.decisionId} AND target = ${claim!.target}`;
  const reclaimed = await decisions.claim();
  expect(reclaimed?.target).toBe(claim?.target);
  expect(reclaimed?.signedEvents).toEqual([{ id: "e".repeat(64) }]);
  await expect(decisions.complete(claim!, "verified", "sent")).rejects.toThrow(/lease lost/);
  await decisions.complete(reclaimed!, "failed", "network_unavailable");
  const status = await decisions.retry(claim!.decision.decisionId, actor);
  expect(status.deliveries.find((d) => d.target === reclaimed!.target)?.state).toBe("pending");
});
test("waiting for community serialization does not exhaust delivery attempts", async () => {
  const status = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  const claim = await decisions.claim();
  expect(claim).toBeDefined();
  await decisions.defer(claim!);
  const [row] = await sql`SELECT attempts, token, state FROM moderation.deliveries WHERE decision_id = ${claim!.decision.decisionId} AND target = ${claim!.target}`;
  expect(row.attempts).toBe(claim!.attempts - 1);
  expect(row.token).toBeNull();
  expect(row.state).toBe("pending");
});
test("an unverified delivery that exhausts its retry budget becomes visibly failed", async () => {
  const claim = await decisions.claim();
  expect(claim).toBeDefined();
  await decisions.complete({ ...claim!, attempts: 8 }, "acknowledged", "concord_awaiting_fold");
  const [row] = await sql`SELECT state, result_code FROM moderation.deliveries WHERE decision_id = ${claim!.decision.decisionId} AND target = ${claim!.target}`;
  expect(row.state).toBe("failed");
  expect(row.result_code).toBe("retry_budget_exhausted");
});
test("delivery results remain visible after evidence expires, but expired actions cannot retry", async () => {
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  await sql`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${accepted.decisionId}`;
  await decisions.expire();
  const status = await decisions.get(accepted.decisionId, actor);
  expect(status.deliveries.every((delivery) => delivery.state === 'failed')).toBe(true);
  expect((await decisions.forCase(caseId, { ...actor, permissions: ['view'] })).some((decision) => decision.decisionId === accepted.decisionId)).toBe(true);
  await expect(decisions.retry(accepted.decisionId, actor)).rejects.toThrow(/retry/i);
});

test("crash at the final attempt becomes terminal instead of pending forever", async () => {
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  await sql`UPDATE moderation.deliveries SET attempts = 8, lease_until = clock_timestamp() - interval '1 second' WHERE decision_id = ${accepted.decisionId}`;
  await decisions.claim();
  const status = await decisions.get(accepted.decisionId, actor);
  expect(status.deliveries.every((d) => d.state === "failed" && d.resultCode === "retry_budget_exhausted")).toBe(true);
});
test("transient failure respects retry delay and can be claimed again", async () => {
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id != ${accepted.decisionId}`;
  const claim = (await decisions.claim())!;
  await decisions.complete(claim, "pending", "discord_rate_limited", 120);
  const [row] = await sql`SELECT extract(epoch FROM available_at - clock_timestamp()) AS delay FROM moderation.deliveries WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target}`;
  expect(Number(row.delay)).toBeGreaterThan(118);
  await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE target != ${claim.target}`;
  expect(await decisions.claim()).toBeUndefined();
  await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${claim.decision.decisionId} AND target = ${claim.target}`;
  expect((await decisions.claim())?.attempts).toBe(claim.attempts + 1);
});
test("retrying a guild-scoped decision needs guild authority for its Discord delivery", async () => {
  const admin = { ...actor, permissions: [...actor.permissions, "discord_guild_ban"] };
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID(), action: "ban_member", scope: "community", discordGuildConfirmed: true }, admin);
  await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 1 WHERE decision_id = ${accepted.decisionId}`;
  const moderator = await decisions.retry(accepted.decisionId, actor);
  expect(Object.fromEntries(moderator.deliveries.map((d) => [d.target, d.state]))).toEqual({ concord: "pending", discord: "failed", divine_relay: "pending" });
  await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id = ${accepted.decisionId} AND target <> 'discord'`;
  await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${accepted.decisionId}`;
  const retried = await decisions.retry(accepted.decisionId, admin);
  expect(retried.deliveries.every((d) => d.state === "pending")).toBe(true);
  await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id = ${accepted.decisionId}`;
});

test("Concord generation replacement and send intent are lease-fenced compare-and-swaps", async () => {
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID(), action: "ban_member", scope: "community" }, actor);
  await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour'`;
  await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${accepted.decisionId} AND target = 'concord'`;
  const old = (await decisions.claim())!;
  // The schema default also covers pre-migration generations: no proof means
  // uncertain, not safe to replace. Only saveEvents on an empty row clears it.
  expect(old.publicationAttempted).toBe(true);
  const first = [{ id: "1".repeat(64) }], second = [{ id: "2".repeat(64) }], third = [{ id: "3".repeat(64) }];
  await decisions.saveEvents(old, first);
  expect(old.publicationAttempted).toBe(false);
  await sql`UPDATE moderation.deliveries SET lease_until = clock_timestamp() - interval '1 second' WHERE decision_id = ${accepted.decisionId} AND target = 'concord'`;
  const current = (await decisions.claim())!;
  expect(current.signedEvents).toEqual(first);
  expect(current.publicationAttempted).toBe(false);
  await expect(decisions.replaceUnattemptedEvents(old, first, second)).rejects.toThrow(/lease/);
  await expect(decisions.markPublicationAttempted(old, first)).rejects.toThrow(/lease/);
  await expect(decisions.replaceUnattemptedEvents(current, third, second)).rejects.toThrow(/generation/);
  expect(await decisions.replaceUnattemptedEvents(current, first, second)).toEqual(second);
  await expect(decisions.markPublicationAttempted(current, first)).rejects.toThrow(/generation/);
  await expect(decisions.replaceUnattemptedEvents(current, first, third)).rejects.toThrow(/generation/);
  await decisions.markPublicationAttempted(current, second);
  await expect(decisions.replaceUnattemptedEvents(current, second, third)).rejects.toThrow(/generation/);
  // A repeated save/retry cannot reset uncertain publication to unattempted.
  expect(await decisions.saveEvents(current, third)).toEqual(second);
  expect(current.publicationAttempted).toBe(true);
  await decisions.complete(current, "failed", "concord_recovery_requires_operator");
  await sql`UPDATE moderation.deliveries SET state = 'verified' WHERE decision_id = ${accepted.decisionId} AND target <> 'concord'`;
  await expect(decisions.retry(accepted.decisionId, actor)).rejects.toThrow(/retryable/);
  const [row] = await sql`SELECT signed_events, publication_attempted FROM moderation.deliveries WHERE decision_id = ${accepted.decisionId} AND target = 'concord'`;
  expect(row.signed_events).toEqual(second);
  expect(row.publication_attempted).toBe(true);
});

test("the actual API role accepts decisions while retaining case locks and column-scoped privileges", async () => {
  // Boot reruns the earlier broad grant before the narrowing migrations.
  await migrateModeration(sql);
  const api = postgres(process.env.DATABASE_URL!, { max: 1, connection: { options: "-c role=moderation_api" }, onnotice: () => {} });
  try {
    const [identity] = await api`SELECT current_user AS role,
      has_column_privilege(current_user, 'moderation.cases', 'case_id', 'UPDATE') AS can_lock,
      has_column_privilege(current_user, 'moderation.cases', 'evidence', 'UPDATE') AS can_edit_evidence,
      has_column_privilege(current_user, 'moderation.cases', 'expires_at', 'UPDATE') AS can_edit_expiry`;
    expect(identity).toEqual({ role: "moderation_api", can_lock: true, can_edit_evidence: false, can_edit_expiry: false });
    const apiDecisions = new Decisions(api, cipher, new Map([["a".repeat(64), org]]));
    const request = { ...input, executionId: crypto.randomUUID() };
    const accepted = await apiDecisions.acceptDecision(request, actor);
    expect(accepted.deliveries.map((delivery) => delivery.state)).toEqual(["pending", "pending", "pending"]);
    expect((await apiDecisions.acceptDecision(request, actor)).decisionId).toBe(accepted.decisionId);
    await api.begin(async (tx) => {
      await tx`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId} FOR SHARE`;
      await expect(sql.begin(async (other) => {
        await other.unsafe("SET LOCAL lock_timeout = '100ms'");
        await other`DELETE FROM moderation.cases WHERE case_id = ${caseId}`;
      })).rejects.toThrow(/lock timeout/);
    });
    await expect(api`UPDATE moderation.cases SET evidence = evidence WHERE case_id = ${caseId}`.execute()).rejects.toThrow(/permission denied/);
    await expect(api`UPDATE moderation.cases SET expires_at = expires_at WHERE case_id = ${caseId}`.execute()).rejects.toThrow(/permission denied/);
    const events = [{ id: "4".repeat(64) }];
    const token = crypto.randomUUID();
    await sql`UPDATE moderation.deliveries SET state = 'failed', token = ${token}, lease_until = clock_timestamp() + interval '1 minute',
      available_at = clock_timestamp() + interval '1 hour', updated_at = clock_timestamp() - interval '1 hour',
      signed_events = ${sql.json(events)}, publication_attempted = true WHERE decision_id = ${accepted.decisionId}`;
    const retried = await apiDecisions.retry(accepted.decisionId, actor);
    expect(retried.deliveries.every((delivery) => delivery.state === "pending")).toBe(true);
    expect((await apiDecisions.forCase(caseId, { ...actor, permissions: ["view"] })).some((decision) => decision.decisionId === accepted.decisionId)).toBe(true);
    const rows = await sql`SELECT token, lease_until, available_at <= clock_timestamp() AS available,
      updated_at > clock_timestamp() - interval '1 minute' AS updated, signed_events, publication_attempted
      FROM moderation.deliveries WHERE decision_id = ${accepted.decisionId}`;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toEqual({ token: null, lease_until: null, available: true, updated: true, signed_events: events, publication_attempted: true });
    const columns = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'moderation' AND table_name = 'decisions'`;
    for (const { column_name } of columns) {
      await expect(api`UPDATE moderation.decisions SET ${api(column_name)} = ${api(column_name)} WHERE decision_id = ${accepted.decisionId}`.execute()).rejects.toThrow(/permission denied/);
    }
    for (const column of ["signed_events", "publication_attempted", "decision_id", "target", "attempts", "result_code"]) {
      await expect(api`UPDATE moderation.deliveries SET ${api(column)} = ${api(column)} WHERE decision_id = ${accepted.decisionId}`.execute()).rejects.toThrow(/permission denied/);
    }
    await expect(api`DELETE FROM moderation.deliveries WHERE decision_id = ${accepted.decisionId}`.execute()).rejects.toThrow(/permission denied/);
    await expect(api`DELETE FROM moderation.decisions WHERE decision_id = ${accepted.decisionId}`.execute()).rejects.toThrow(/permission denied/);
    await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id = ${accepted.decisionId}`;
  } finally { await api.end(); }
});

test("pending age survives delivery renewal, rescheduling and manual retry", async () => {
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  await sql`UPDATE moderation.decisions SET created_at = clock_timestamp() - interval '1 hour' WHERE decision_id = ${accepted.decisionId}`;
  await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 1, updated_at = clock_timestamp() WHERE decision_id = ${accepted.decisionId}`;
  await decisions.retry(accepted.decisionId, actor);
  await sql`UPDATE moderation.deliveries SET lease_until = clock_timestamp() + interval '60 seconds', available_at = clock_timestamp() + interval '5 minutes', updated_at = clock_timestamp() WHERE decision_id = ${accepted.decisionId}`;
  const metrics = await collectMetrics(sql);
  const age = Number(metrics.match(/^concord_oldest_pending_seconds (.+)$/m)?.[1]);
  expect(Number.isFinite(age)).toBe(true);
  expect(age).toBeGreaterThanOrEqual(3600);
  await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id = ${accepted.decisionId}`;
});
