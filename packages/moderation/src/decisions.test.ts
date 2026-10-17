import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { migrateModeration } from "./policyStore";
import { Decisions } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { collectMetrics } from "./metrics";
import type { NostrEvent } from "nostr-tools/pure";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { ConcordActions } from "./concordActions";
import { deliverConcord } from "./concordDelivery";
import { RetryableDeliveryError } from "./discordActions";
import { PolicyStore } from "./policyStore";
import { controlState } from "./relayPolicy";
import { ModerationWorker, type ExecutionContext } from "./worker";
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
  expect(first.discordGuildConfirmed).toBe(false);
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
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID(), action: "ban_member", scope: "community", discordGuildConfirmed: true, sourceOrder: { version: 1, revision: "1" } }, admin);
  await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 1 WHERE decision_id = ${accepted.decisionId}`;
  const moderator = await decisions.retry(accepted.decisionId, actor);
  expect(moderator.discordGuildConfirmed).toBe(true);
  expect(Object.fromEntries(moderator.deliveries.map((d) => [d.target, d.state]))).toEqual({ concord: "pending", discord: "failed", divine_relay: "pending" });
  await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id = ${accepted.decisionId} AND target <> 'discord'`;
  await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${accepted.decisionId}`;
  const retried = await decisions.retry(accepted.decisionId, admin);
  expect(retried.discordGuildConfirmed).toBe(true);
  expect(retried.deliveries.every((d) => d.state === "pending")).toBe(true);
  await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id = ${accepted.decisionId}`;
});

test("Concord generation replacement and send intent are lease-fenced compare-and-swaps", async () => {
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID(), action: "ban_member", scope: "community", sourceOrder: { version: 1, revision: "2" } }, actor);
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
    for (const column of ["signed_events", "publication_attempted", "decision_id", "target", "attempts", "result_code", "superseded_by"]) {
      await expect(api`UPDATE moderation.deliveries SET ${api(column)} = ${api(column)} WHERE decision_id = ${accepted.decisionId}`.execute()).rejects.toThrow(/permission denied/);
    }
    await expect(api`INSERT INTO moderation.deliveries (decision_id, target, superseded_by)
      VALUES (${accepted.decisionId}, 'concord', ${accepted.decisionId}) ON CONFLICT DO NOTHING`.execute()).rejects.toThrow(/permission denied/);
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

async function memberCase(author = crypto.randomUUID().replaceAll("-", "").repeat(2)) {
  const id = crypto.randomUUID();
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${id}, ${org}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, ${author}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
  return { caseId: id, author };
}
const recordedRevisions = new Map<string, string>();
let nextRevision = 100;
function recordedOrder(executionId: string) {
  if (!recordedRevisions.has(executionId)) recordedRevisions.set(executionId, String(++nextRevision));
  return { version: 1 as const, revision: recordedRevisions.get(executionId)! };
}
const member = (subject: { caseId: string }, action: "ban_member" | "unban_member", executionId: string = crypto.randomUUID()) => ({ sourceOrder: recordedOrder(executionId), caseId: subject.caseId, executionId, action, reason: `Synthetic ${action}`, scope: "community" as const, discordGuildConfirmed: false });
const settle = (decisionId: string, state = "verified") => sql`UPDATE moderation.deliveries SET state = ${state}, attempts = 1 WHERE decision_id = ${decisionId}`;
/** Holds a decision's deliveries out of the outbox. */
const hold = (decisionId: string, except?: string) => sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${decisionId} AND target IS DISTINCT FROM ${except ?? null}`;
const concordRow = async (decisionId: string) => (await sql`SELECT state, result_code, superseded_by, signed_events, attempts FROM moderation.deliveries WHERE decision_id = ${decisionId} AND target = 'concord'`)[0];

/** A real outbox, real Concord preparation and readback, and a Concord fold
 * over what the fake local relay has stored. Relay and Discord targets are held. */
async function memberHarness(subject: "member" | "bannedMember") {
  const f = await moderationFixture(), who = f[subject], store = new PolicyStore(sql), orgId = crypto.randomUUID(), subjectCase = crypto.randomUUID();
  const staff = { orgId, actorId: "synthetic-reviewer", permissions: ["ban_member", "unban_member", "view", "retry"] };
  const outbox = new Decisions(sql, cipher, new Map([[f.community.idHex, orgId]]));
  const published: NostrEvent[] = [];
  const refresh = async () => { const p = (await store.getPolicy(f.community.idHex))!; return { ...p, controlEvents: [...p.controlEvents, ...published] }; };
  const actions = new ConcordActions(f.community, f.moderator, refresh);
  const relay = { publish: async (event: NostrEvent) => { if (!published.some((e) => e.id === event.id)) published.push(event); }, queryStrict: async (filters: { ids: string[] }[]) => published.filter((event) => filters[0].ids.includes(event.id)) };
  const request = (action: "ban_member" | "unban_member", executionId: string = crypto.randomUUID()) => ({ sourceOrder: recordedOrder(executionId), caseId: subjectCase, executionId, action, reason: "Synthetic member decision", scope: "community" as const, discordGuildConfirmed: false });
  const accept = async (action: "ban_member" | "unban_member") => { const status = await outbox.acceptDecision(request(action), staff); await hold(status.decisionId, "concord"); return status; };
  const deliver = async (claim: Awaited<ReturnType<Decisions["claim"]>> & object, through: typeof relay = relay) => {
    expect(claim.target).toBe("concord");
    const result = await deliverConcord(claim, actions, outbox, through as never, async () => {}).catch((error) => {
      if (error instanceof RetryableDeliveryError) return { state: "pending" as const, code: error.code };
      throw error;
    });
    await outbox.complete(claim, result.state, result.code);
    return result;
  };
  const drain = async () => { for (let claim; (claim = await outbox.claim());) await deliver(claim); };
  const banned = async () => controlState(await refresh()).folded.banned.has(who.pk);
  await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${subjectCase}, ${orgId}, ${f.community.idHex}, ${f.channelId}, ${f.allowedRumorId}, ${who.pk}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
  const cleanup = async () => {
    await sql`DELETE FROM moderation.decisions WHERE org_id = ${orgId}`;
    await sql`DELETE FROM moderation.cases WHERE org_id = ${orgId}`;
    await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`;
  };
  return { f, who, staff, outbox, relay, published, request, accept, deliver, drain, banned, cleanup };
}

// The outbox claims by available_at and Concord prepares from the fold current
// at delivery. An older decision that was backing off used to deliver after a
// newer opposite one and win, with both rows reading verified.
for (const [older, newer] of [["ban_member", "unban_member"], ["unban_member", "ban_member"]] as const) test(`a ${newer} accepted after a still-delivering ${older} wins`, async () => {
  const h = await memberHarness(older === "ban_member" ? "member" : "bannedMember");
  try {
    const first = await h.accept(older);
    // The older decision's Concord delivery is backing off after a retryable failure.
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '200 milliseconds' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const second = await h.accept(newer);
    await Bun.sleep(300);
    await h.drain();
    expect(await h.banned()).toBe(newer === "ban_member");
    expect((await h.outbox.get(second.decisionId, h.staff)).deliveries.find((d) => d.target === "concord")?.state).toBe("verified");
    const superseded = await h.outbox.get(first.decisionId, h.staff);
    expect(superseded.supersededBy).toBe(second.decisionId);
    // Every target of the older decision, held or not, stands down for the newer one.
    expect(superseded.deliveries.map((d) => [d.state, d.resultCode])).toEqual(Array(3).fill(["failed", "superseded_by_newer_decision"]));
    expect((await h.outbox.get(second.decisionId, h.staff)).supersededBy).toBeNull();
  } finally { await h.cleanup(); }
});

test("superseding keeps the older decision on record and drops its unsent generation", async () => {
  const subject = await memberCase();
  const older = await decisions.acceptDecision(member(subject, "ban_member"), actor);
  await hold(older.decisionId);
  // An unsent prepared generation: signed but never published.
  await sql`UPDATE moderation.deliveries SET signed_events = ${sql.json([{ id: "5".repeat(64) }])}, publication_attempted = false WHERE decision_id = ${older.decisionId} AND target = 'concord'`;
  const failedBefore = Number((await collectMetrics(sql)).match(/^concord_deliveries_failed (\d+)$/m)![1]);
  const newer = await decisions.acceptDecision(member(subject, "unban_member"), actor);
  await hold(newer.decisionId);
  const newest = await decisions.acceptDecision(member(subject, "ban_member"), actor);
  await hold(newest.decisionId);
  expect(await decisions.claim()).toBeUndefined();
  const rows = await sql`SELECT target, state, result_code, superseded_by, signed_events, token, lease_until FROM moderation.deliveries WHERE decision_id = ${older.decisionId} ORDER BY target`;
  for (const row of rows) expect(row).toEqual({ target: row.target, state: "failed", result_code: "superseded_by_newer_decision", superseded_by: newer.decisionId, signed_events: null, token: null, lease_until: null });
  const [record] = await sql`SELECT action, author, audit IS NOT NULL AS audited FROM moderation.decisions WHERE decision_id = ${older.decisionId}`;
  expect(record).toEqual({ action: "ban_member", author: subject.author, audited: true });
  // Each superseded decision names the one accepted next, even when one sweep marks both.
  expect((await decisions.forCase(subject.caseId, { ...actor, permissions: ["view"] })).map((d) => [d.decisionId, d.supersededBy])).toEqual([[newest.decisionId, null], [newer.decisionId, newest.decisionId], [older.decisionId, newer.decisionId]]);
  // Superseded is not a delivery failure to escalate.
  expect(Number((await collectMetrics(sql)).match(/^concord_deliveries_failed (\d+)$/m)![1])).toBe(failedBefore);
  await settle(newest.decisionId, "failed");
});

test("a newer decision waits for an older one mid-send, then applies on top", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    const sending = (await h.outbox.claim())!;
    expect(sending.decision.decisionId).toBe(first.decisionId);
    const second = await h.accept("unban_member");
    // The older attempt holds its lease: it is neither superseded nor overtaken.
    expect(await h.outbox.claim()).toBeUndefined();
    expect((await concordRow(first.decisionId)).result_code).toBeNull();
    expect((await concordRow(second.decisionId)).attempts).toBe(0);
    expect(await h.deliver(sending)).toEqual({ state: "verified", code: "concord_enforcement_verified" });
    expect(await h.banned()).toBe(true);
    await h.drain();
    expect(await h.banned()).toBe(false);
    expect((await concordRow(first.decisionId)).state).toBe("verified");
    expect(await concordRow(second.decisionId)).toMatchObject({ state: "verified", attempts: 1 });
  } finally { await h.cleanup(); }
});

test("an older Concord edition whose publication is uncertain settles before a newer one is prepared", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    const limbo: NostrEvent[] = [];
    // The relay may have stored the edition even though the send reported failure.
    const lossy = { ...h.relay, publish: async (event: NostrEvent) => { limbo.push(event); throw new Error("socket closed"); } };
    expect(await h.deliver((await h.outbox.claim())!, lossy)).toEqual({ state: "pending", code: "concord_transport_unavailable" });
    const second = await h.accept("unban_member");
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    // Superseding it would let a newer edition race one that may already be stored.
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "pending", result_code: "concord_transport_unavailable", superseded_by: null });
    expect((await concordRow(first.decisionId)).signed_events).toHaveLength(1);
    h.published.push(...limbo);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const resumed = (await h.outbox.claim())!;
    expect(resumed.decision.decisionId).toBe(first.decisionId);
    expect(await h.deliver(resumed)).toEqual({ state: "verified", code: "concord_enforcement_verified" });
    await h.drain();
    expect(await h.banned()).toBe(false);
    expect((await concordRow(second.decisionId)).state).toBe("verified");
  } finally { await h.cleanup(); }
});

test("Retry refuses a decision a newer one for that member superseded", async () => {
  const subject = await memberCase();
  const older = await decisions.acceptDecision(member(subject, "ban_member"), actor);
  await settle(older.decisionId, "failed");
  const newer = await decisions.acceptDecision(member(subject, "unban_member"), actor);
  await hold(newer.decisionId);
  const refused = await decisions.retry(older.decisionId, actor).catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: "member_decision_superseded" });
  expect((await decisions.get(older.decisionId, actor)).deliveries.every((d) => d.state === "failed")).toBe(true);
  // A decision the outbox marked superseded is refused the same way.
  const newest = await decisions.acceptDecision(member(subject, "ban_member"), actor);
  await hold(newest.decisionId);
  expect(await decisions.claim()).toBeUndefined();
  expect((await decisions.get(newer.decisionId, actor)).supersededBy).toBe(newest.decisionId);
  await expect(decisions.retry(newer.decisionId, actor)).rejects.toMatchObject({ code: "member_decision_superseded" });
  // The newest decision for the member stays retryable.
  await settle(newest.decisionId, "failed");
  expect((await decisions.retry(newest.decisionId, actor)).deliveries.every((d) => d.state === "pending")).toBe(true);
  await settle(newest.decisionId, "failed");
});

test("acceptance and Retry for one member serialize on that member, not on others", async () => {
  const subject = await memberCase(), bystander = await memberCase();
  const older = await decisions.acceptDecision(member(subject, "ban_member"), actor);
  await settle(older.decisionId, "failed");
  const locked = sql.reserve();
  const conn = await locked;
  try {
    await conn`BEGIN`;
    await conn`SELECT pg_advisory_xact_lock(hashtextextended(${"a".repeat(64) + ":" + subject.author}, 483216))`;
    let accepted = false, retried = false;
    const pendingAccept = decisions.acceptDecision(member(subject, "unban_member"), actor).then((s) => { accepted = true; return s; });
    const pendingRetry = decisions.retry(older.decisionId, actor).then((s) => { retried = true; return s; }, (e) => { retried = true; return e; });
    await decisions.acceptDecision(member(bystander, "ban_member"), actor).then((s) => hold(s.decisionId));
    await Bun.sleep(200);
    expect([accepted, retried]).toEqual([false, false]);
    await conn`COMMIT`;
    const newer = await pendingAccept;
    await pendingRetry;
  } finally {
    await conn`ROLLBACK`.catch(() => {});
    conn.release();
    await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id IN (SELECT decision_id FROM moderation.decisions WHERE case_id IN (${subject.caseId}, ${bystander.caseId}))`;
  }
});

test("racing opposite decisions for one member preserve source order and refuse superseded arrivals", async () => {
  const h = await memberHarness("member");
  try {
    let accepting = true;
    // A relay or Discord row can be claimed before accept() holds it; park it again.
    const step = async (claim: Awaited<ReturnType<Decisions["claim"]>> & object) => claim.target === "concord" ? h.deliver(claim) : h.outbox.complete(claim, "pending", "held_by_test", 3600);
    const delivering = (async () => { while (accepting) { const claim = await h.outbox.claim(); if (claim) await step(claim); else await Bun.sleep(5); } })();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => h.accept(i % 2 ? "ban_member" : "unban_member")));
    accepting = false;
    await delivering;
    expect(results[11].status).toBe("fulfilled");
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "member_intent_superseded" });
    await h.drain();
    const ids = results.filter((result) => result.status === "fulfilled").map((result) => (result as PromiseFulfilledResult<{ decisionId: string }>).value.decisionId);
    const order = await sql`SELECT decision_id, action FROM moderation.decisions WHERE decision_id IN ${sql(ids)} ORDER BY source_revision`;
    const last = order[order.length - 1];
    expect(last.action).toBe("ban_member");
    expect(await h.banned()).toBe(true);
    expect((await concordRow(last.decision_id)).state).toBe("verified");
    // Each earlier decision either landed before the next was accepted or stood down for it.
    for (let i = 0; i + 1 < order.length; i++) {
      const row = await concordRow(order[i].decision_id);
      if (row.state !== "verified") expect(row).toMatchObject({ state: "failed", result_code: "superseded_by_newer_decision", superseded_by: order[i + 1].decision_id });
    }
  } finally { await h.cleanup(); }
});

test("only a newer membership decision for the same member supersedes", async () => {
  const subject = await memberCase(), bystander = await memberCase();
  // Removing a message does not change membership, before or after a ban, and another member is a different subject.
  const remove = () => decisions.acceptDecision({ caseId: subject.caseId, executionId: crypto.randomUUID(), action: "remove_message", reason: "Synthetic removal", scope: "message", discordGuildConfirmed: false }, actor);
  const earlier = await remove();
  await hold(earlier.decisionId);
  const outstanding = await decisions.acceptDecision(member(subject, "ban_member"), actor);
  await hold(outstanding.decisionId);
  const removal = await remove();
  const other = await decisions.acceptDecision(member(bystander, "unban_member"), actor);
  for (const id of [removal.decisionId, other.decisionId]) await hold(id);
  expect(await decisions.claim()).toBeUndefined();
  for (const id of [earlier.decisionId, outstanding.decisionId, removal.decisionId, other.decisionId]) {
    const status = await decisions.get(id, actor);
    expect(status.supersededBy).toBeNull();
    expect(status.deliveries.every((d) => d.state === "pending")).toBe(true);
  }
  // A replayed execution is the same decision, not a newer one.
  const [{ execution_id }] = await sql`SELECT execution_id FROM moderation.decisions WHERE decision_id = ${outstanding.decisionId}`;
  expect((await decisions.acceptDecision(member(subject, "ban_member", execution_id), actor)).decisionId).toBe(outstanding.decisionId);
  expect(await decisions.claim()).toBeUndefined();
  expect((await decisions.get(outstanding.decisionId, actor)).supersededBy).toBeNull();
  for (const id of [earlier.decisionId, outstanding.decisionId, removal.decisionId, other.decisionId]) await settle(id, "failed");
});

for (const terminal of ["retry_budget_exhausted", "concord_recovery_requires_operator"] as const) test(`an uncertain older Concord publication still blocks its successor after ${terminal}`, async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    const lossy = { ...h.relay, publish: async (_event: NostrEvent) => { throw new Error("socket closed"); } };
    await h.deliver((await h.outbox.claim())!, lossy);
    if (terminal === "retry_budget_exhausted") {
      await sql`UPDATE moderation.deliveries SET attempts = 8 WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    } else {
      await sql`UPDATE moderation.deliveries SET state = 'failed', result_code = ${terminal} WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    }
    const second = await h.accept("unban_member");
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", result_code: terminal, superseded_by: null });
    expect(await concordRow(second.decisionId)).toMatchObject({ state: "pending", attempts: 0 });
  } finally { await h.cleanup(); }
});

test("expiry clears uncertain signed bytes but leaves the successor waiting for operator recovery", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    const lossy = { ...h.relay, publish: async (_event: NostrEvent) => { throw new Error("socket closed"); } };
    await h.deliver((await h.outbox.claim())!, lossy);
    const second = await h.accept("unban_member");
    await sql`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`;
    await h.outbox.expire();
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator", signed_events: null });
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(second.decisionId)).toMatchObject({ state: "pending", attempts: 0 });
  } finally { await h.cleanup(); }
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Pause only at completed database operations, keeping the real SQL, row locks,
// leases and worker code in the test. No production scheduling hook is needed.
function claimBarrier(client: postgres.Sql, beforeBegin?: () => Promise<void>, afterSelection?: () => Promise<void>): postgres.Sql {
  return new Proxy(client, {
    get(target, key) {
      if (key !== "begin") return Reflect.get(target, key);
      return async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) => {
        await beforeBegin?.();
        return client.begin(async (tx) => callback(new Proxy(tx, {
          apply(target, receiver, args) {
            const query = Reflect.apply(target, receiver, args);
            if (String(args[0][0]).startsWith("SELECT d.*")) return (async () => {
              const rows = await query;
              await afterSelection?.();
              return rows;
            })();
            return query;
          },
        })));
      };
    },
  });
}

for (const [olderAction, newerAction] of [["ban_member", "unban_member"], ["unban_member", "ban_member"]] as const) test(`two concurrent claimers cannot apply an older ${olderAction} after the newer ${newerAction}`, async () => {
  const subject = await memberCase();
  const first = await decisions.acceptDecision(member(subject, olderAction), actor);
  await hold(first.decisionId, "divine_relay");
  const selected = latch(), finishSelection = latch(), secondReady = latch(), startSecond = latch();
  const applicationName = `member-claim-race-${crypto.randomUUID()}`;
  const secondSql = postgres(process.env.DATABASE_URL!, { max: 1, connection: { application_name: applicationName }, onnotice: () => {} });
  const firstOutbox = new Decisions(claimBarrier(sql, undefined, async () => { selected.resolve(); await finishSelection.promise; }), cipher, new Map([["a".repeat(64), org]]));
  const secondOutbox = new Decisions(claimBarrier(secondSql, async () => { secondReady.resolve(); await startSecond.promise; }), cipher, new Map([["a".repeat(64), org]]));
  const firstClaim = firstOutbox.claim();
  let secondClaim: ReturnType<Decisions["claim"]> | undefined;
  try {
    await selected.promise; // A has locked the old row but has not written its lease.
    expect((await sql`SELECT lease_until FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'divine_relay'`)[0].lease_until).toBeNull();
    secondClaim = secondOutbox.claim();
    await secondReady.promise;
    // On the broken implementation both supersession sweeps are now complete.
    // A new decision arrives before B's SKIP LOCKED selection skips the old row.
    const second = await decisions.acceptDecision(member(subject, newerAction), actor);
    await hold(second.decisionId, "divine_relay");
    let secondFinished = false;
    void secondClaim.then(() => { secondFinished = true; });
    startSecond.resolve();
    // Wait for a real scheduling boundary: either B claimed the successor or
    // Postgres reports B waiting for claim serialization. Elapsed time itself
    // is never evidence that B waited.
    let reachedBoundary = false;
    for (let attempts = 0; attempts < 200; attempts++) {
      const [backend] = await sql`SELECT wait_event_type FROM pg_stat_activity WHERE application_name = ${applicationName}`;
      if (secondFinished || backend?.wait_event_type === "Lock") { reachedBoundary = true; break; }
      await Bun.sleep(5);
    }
    expect(reachedBoundary).toBe(true);
    finishSelection.resolve();
    const [a, b] = await Promise.all([firstClaim, secondClaim]);
    expect(a?.decision.decisionId).toBe(first.decisionId);
    // Exercise the dangerous worker order: B executes before A. The community
    // lock serializes them, but without claim fencing the old action wins last.
    const queued = [b, a].filter((claim): claim is NonNullable<typeof claim> => Boolean(claim));
    const queuedOutbox = new Proxy(decisions, { get(target, key) { return key === "claim" ? async () => queued.shift() : Reflect.get(target, key); } });
    let banned = olderAction === "unban_member";
    const context = async (_claim: unknown, assertCurrent: () => Promise<void>): Promise<ExecutionContext> => ({
      authorize: async () => {}, assertCurrent,
      setRelayBan: async (decision) => { banned = decision.action === "ban_member"; return true; },
      removeFromRelay: async () => ({ state: "verified" }),
      executeConcord: async () => ({ state: "verified", code: "unused" }),
      discord: { execute: async () => ({ state: "verified", code: "unused" }) },
    });
    const reordered = new ModerationWorker(sql, queuedOutbox, context);
    while (queued.length) await reordered.tick();
    // A legitimately held older lease may finish first, then ordinary claims
    // deliver the successor. Already-verified decisions cannot be replayed.
    const ordinary = new ModerationWorker(sql, decisions, context);
    while (await ordinary.tick()) {}
    expect(banned).toBe(newerAction === "ban_member");
    expect((await decisions.get(second.decisionId, actor)).deliveries.find((delivery) => delivery.target === "divine_relay")?.state).toBe("verified");
  } finally {
    startSecond.resolve(); finishSelection.resolve();
    await Promise.allSettled([firstClaim, ...(secondClaim ? [secondClaim] : [])]);
    await sql`DELETE FROM moderation.decisions WHERE case_id = ${subject.caseId}`;
    await secondSql.end();
  }
});
