import { createPublicationRecoveryActions } from "./publicationOperator";
import { buildBanlistEdition, buildGrantEdition, buildChannelEdition, banlistLocator, currentControlWriteGroup, sealEdition, parseEdition, openWrap, bytesToHex, foldControlState, streamPubkeysForRelay, signStreamAuths } from "@armada-bridge/concord-core";
import { generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { localIdentity } from "../../bridge/src/concord/signer";
import { recoverPublication, assertPilotPublicationProvenance, publicationBlockers } from "./publicationRecovery";
import { runModerationWorker } from "./runtime";
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { migrateModeration } from "./policyStore";
import { Decisions } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { collectMetrics } from "./metrics";
import type { NostrEvent } from "nostr-tools/pure";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { refreshPolicy } from "../../../scripts/fixtures/relay-events";
import { ConcordActions } from "./concordActions";
import { deliverConcord } from "./concordDelivery";
import { RetryableDeliveryError } from "./discordActions";
import { PolicyStore } from "./policyStore";
import { controlState } from "./relayPolicy";
import { ModerationWorker, executeDelivery, type ExecutionContext } from "./worker";
import { createExecutionContext } from "./executionContext";
import { PublicCapacityStore } from "./publicCapacity";
import type { PublicCapacityContract } from "./capacityContract";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const org = crypto.randomUUID(), caseId = crypto.randomUUID(), executionId = crypto.randomUUID();
const actor = { orgId: org, actorId: "synthetic-reviewer", permissions: ["remove_message", "ban_member", "unban_member", "retry"] };
const input = { caseId, executionId, action: "remove_message" as const, reason: "Synthetic removal", scope: "message" as const, discordGuildConfirmed: false };
const cipher = new EvidenceCipher(randomBytes(32), 3600, 100_000);
// Synthetic calibration for recovery/admission wiring, not a launch envelope.
const recoveryContract = { sourceSha: "1".repeat(40), platform: "linux/amd64", maxima: { historyCount: 128, historyBytes: 1000000, rekeyCount: 16, streamCount: 64, inFlight: 4, innerAdmissionMs: 1000 }, thresholds: { warningHistoryCount: 32, pauseHistoryCount: 64, urgentReserve: 16 }, maxSampleAgeMs: 30000 } as PublicCapacityContract;
let decisions: Decisions;
beforeAll(async () => {
  await migrateModeration(sql);
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${caseId}, ${org}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
  decisions = new Decisions(sql, cipher, new Map([["a".repeat(64), org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
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
  // Time-travel synthetic fixtures only; runtime roles retain immutable timestamps.
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${accepted.decisionId}`; });
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
    const apiDecisions = new Decisions(api, cipher, new Map([["a".repeat(64), org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
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
      // Audit erasure belongs to the worker's operator role, not the API.
      const permitted = ["lifecycle_closed_at", "audit_delete_after", "audit_retention_seconds", "appeal_state"].includes(column_name);
      const update = api`UPDATE moderation.decisions SET ${api(column_name)} = ${api(column_name)} WHERE decision_id = ${accepted.decisionId}`.execute();
      if (permitted) await update;
      else await expect(update).rejects.toThrow(/permission denied/);
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
  // Time-travel synthetic fixtures only; runtime roles retain immutable timestamps.
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET created_at = clock_timestamp() - interval '1 hour' WHERE decision_id = ${accepted.decisionId}`; });
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

/** Stop real startup at its controller lock, against an owned local endpoint.
 * Passing preflight must not require opening any relay or Discord session. */
async function workerAtOwnedController(h: Awaited<ReturnType<typeof memberHarness>>) {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return new Response("unexpected test request", { status: 503 }); } });
  const communities = new Map([[h.f.community.idHex, h.staff.orgId]]);
  try {
    await sql.begin(async held => {
      await held`SELECT pg_advisory_xact_lock(hashtextextended(${h.f.community.idHex}, 483218))`;
      await runModerationWorker({ sql, decisions: h.outbox, lifecycle: { expireEvidence: async () => {}, expireAudit: async () => {} }, capacity: { communities, contract: undefined }, community: h.f.community, identity: h.f.moderator, communities,
        relayUrl: `ws://127.0.0.1:${server.port}`, bridgeTenantId: "synthetic-tenant", puppetMaster: "synthetic", discordToken: "", publicChannels: { guildId: "1".repeat(18), channelIds: ["2".repeat(18)], excludedCategoryIds: ["3".repeat(18)] }, publicAuthors: [],
        signal: new AbortController().signal, health: { ready: false, code: "starting", checkedAt: 0 } });
    });
  } finally { server.stop(true); expect(requests).toBe(0); }
}

/** A real outbox, real Concord preparation and readback, and a Concord fold
 * over what the fake local relay has stored. Relay and Discord targets are held. */
async function memberHarness(subject: "member" | "bannedMember") {
  const f = await moderationFixture(), who = f[subject], store = new PolicyStore(sql), orgId = crypto.randomUUID(), subjectCase = crypto.randomUUID();
  const staff = { orgId, actorId: "synthetic-reviewer", permissions: ["ban_member", "unban_member", "view", "retry"] };
  const outbox = new Decisions(sql, cipher, new Map([[f.community.idHex, orgId]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
  const published: NostrEvent[] = [];
  const refresh = async () => { const p = (await store.getPolicy(f.community.idHex))!; return refreshPolicy({ ...p, controlEvents: [...p.controlEvents, ...published] }); };
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
  await store.install(refreshPolicy(f.policy), [f.chatStream, f.controlStream, f.guestbookStream], 0);
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${subjectCase}, ${orgId}, ${f.community.idHex}, ${f.channelId}, ${f.allowedRumorId}, ${who.pk}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
  const cleanup = async () => {
    // Synthetic test teardown only; runtime lifecycle retention stays enforced.
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`DELETE FROM moderation.lifecycle_events WHERE org_id = ${orgId}`; });
    await sql`DELETE FROM moderation.decisions WHERE org_id = ${orgId}`;
    await sql`DELETE FROM moderation.cases WHERE org_id = ${orgId}`;
    await sql`DELETE FROM moderation.public_capacity_state WHERE community_id = ${f.community.idHex}`;
    await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`;
  };
  return { f, who, staff, outbox, relay, actions, published, request, accept, deliver, drain, banned, cleanup };
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

for (const [older, newer] of [["ban_member", "unban_member"], ["unban_member", "ban_member"]] as const) test(`expiry erases ${older} payloads without erasing the receipt needed by ${newer}`, async () => {
  const h = await memberHarness(older === "ban_member" ? "member" : "bannedMember");
  try {
    const first = await h.accept(older), limbo: NostrEvent[] = [];
    const lossy = { ...h.relay, publish: async (event: NostrEvent) => { limbo.push(event); throw new Error("socket closed"); } };
    await h.deliver((await h.outbox.claim())!, lossy);
    const next = h.request(newer), oldCase = next.caseId;
    next.caseId = crypto.randomUUID();
    await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
      VALUES (${next.caseId}, ${h.staff.orgId}, ${h.f.community.idHex}, ${h.f.channelId}, ${h.f.allowedRumorId}, ${h.who.pk}, ${crypto.randomUUID()}, ${Buffer.from("synthetic newer report")}, clock_timestamp() + interval '1 hour')`;
    const second = await h.outbox.acceptDecision(next, h.staff);
    await hold(second.decisionId, "concord");
    // Time-travel synthetic fixtures only; runtime roles retain immutable timestamps.
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`; });
    await h.outbox.expire();
    await sql`DELETE FROM moderation.cases WHERE case_id = ${oldCase}`;
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator", signed_events: null });
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const receipt = (await h.outbox.claim())!;
    expect(receipt).toMatchObject({ reconcileOnly: true, signedEvents: null });
    expect(receipt.publicationEventIds).toHaveLength(1);
    // Absence does not settle it, even after payload erasure.
    expect(await h.deliver(receipt)).toMatchObject({ state: "failed", code: "concord_recovery_awaiting_proof" });
    expect(await concordRow(second.decisionId)).toMatchObject({ state: "pending", attempts: 0 });
    // Delayed publication becomes readable after both the case and saved
    // payload have gone. The opaque ID still binds the fetched signed bytes.
    h.published.push(...limbo);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    expect(await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async () => { throw new Error("No expired-intent replay"); } })).toMatchObject({ state: "not_applicable", code: "concord_superseded_publication_settled" });
    await h.drain();
    expect(await h.banned()).toBe(newer === "ban_member");
    expect((await concordRow(second.decisionId)).state).toBe("verified");
    const [expired] = await sql`SELECT c.audit, d.signed_events, d.publication_event_ids FROM moderation.decisions c JOIN moderation.deliveries d USING (decision_id) WHERE c.decision_id = ${first.decisionId} AND d.target = 'concord'`;
    expect(expired.audit).not.toBeNull(); expect(expired.signed_events).toBeNull(); expect(expired.publication_event_ids).toEqual([limbo[0].id]);
  } finally { await h.cleanup(); }
});

test("publication ID migration copies only readable outer IDs and keeps receipts worker-owned", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async () => { throw new Error("uncertain send"); } });
    const [saved] = await sql`SELECT signed_events FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await sql`UPDATE moderation.deliveries SET publication_event_ids = NULL WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await migrateModeration(sql);
    expect((await sql`SELECT publication_event_ids FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`)[0].publication_event_ids).toEqual([saved.signed_events[0].id]);
    await expect(sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE moderation_api");
      await tx`UPDATE moderation.deliveries SET publication_event_ids = ARRAY[${"f".repeat(64)}] WHERE decision_id = ${first.decisionId}`;
    })).rejects.toThrow(/permission denied/);
    await sql`UPDATE moderation.deliveries SET publication_event_ids = NULL, signed_events = '{"not":"an event array"}'::jsonb WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await migrateModeration(sql);
    expect((await sql`SELECT publication_event_ids FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`)[0].publication_event_ids).toBeNull();
  } finally { await h.cleanup(); }
});

for (const [attempted, attempts] of [[false, 0], [false, 1], [true, 0], [true, 1]] as const) test(`legacy erased expiry with marker ${attempted} and ${attempts} attempts preserves known send history`, async () => {
  const h = await memberHarness("member");
  try {
    const request = h.request("ban_member"), legacy = crypto.randomUUID();
    await sql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, fingerprint_version, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at)
      VALUES (${legacy}, ${h.staff.orgId}, ${request.executionId}, ${crypto.randomUUID()}, 1, ${request.caseId}, ${h.f.community.idHex}, ${h.f.channelId}, ${h.f.allowedRumorId}, ${h.who.pk}, 'ban_member', false, clock_timestamp() - interval '1 second')`;
    await sql`INSERT INTO moderation.deliveries (decision_id, target, state, result_code, publication_attempted, attempts)
      VALUES (${legacy}, 'concord', 'failed', 'decision_expired', ${attempted}, ${attempts})`;
    await migrateModeration(sql);
    const second = await h.accept("unban_member");
    await migrateModeration(sql); // Restart must not invent a send for an unclaimed row.
    if (attempted && attempts > 0) {
      expect(await concordRow(legacy)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator", signed_events: null });
      expect(await h.outbox.claim()).toBeUndefined();
      expect(await concordRow(second.decisionId)).toMatchObject({ state: "pending", attempts: 0, result_code: "concord_waiting_on_prior_publication" });
    } else {
      expect((await concordRow(legacy)).result_code).toBe("decision_expired");
      const claim = (await h.outbox.claim())!;
      expect(claim.decision.decisionId).toBe(second.decisionId);
      await h.deliver(claim);
    }
  } finally { await h.cleanup(); }
});

for (const [older, newer] of [["ban_member", "unban_member"], ["unban_member", "ban_member"]] as const) test(`a retained ${older} publication receipt releases ${newer} without replaying expired intent`, async () => {
  const h = await memberHarness(older === "ban_member" ? "member" : "bannedMember");
  try {
    const first = await h.accept(older);
    const lossy = { ...h.relay, publish: async (event: NostrEvent) => { h.published.push(event); throw new Error("lost acknowledgement"); } };
    await h.deliver((await h.outbox.claim())!, lossy);
    const second = await h.accept(newer);
    await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 8, available_at = clock_timestamp(), result_code = 'retry_budget_exhausted' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    // Time-travel synthetic fixtures only; runtime roles retain immutable timestamps.
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`; });
    let publishes = 0, authorizations = 0, otherEffects = 0;
    const forbidden = async (): Promise<never> => { otherEffects++; throw new Error("Read-only recovery must not execute an old action"); };
    const worker = new ModerationWorker(sql, h.outbox, async (claim, assertCurrent) => ({
      reconcileOnly: claim.reconcileOnly,
      authorize: async () => { authorizations++; throw new Error("Expired action must not be reauthorized"); }, assertCurrent,
      executeConcord: () => deliverConcord(claim, h.actions, h.outbox, { ...h.relay, publish: async () => { publishes++; throw new Error("No recovery publish"); } }, assertCurrent),
      setRelayBan: forbidden, removeFromRelay: forbidden, discord: { execute: forbidden },
    }));
    expect(await worker.tick()).toBe(true);
    expect([publishes, authorizations, otherEffects]).toEqual([0, 0, 0]);
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "not_applicable", result_code: "concord_superseded_publication_settled", attempts: 8 });
    await h.drain();
    expect(await h.banned()).toBe(newer === "ban_member");
    expect((await concordRow(second.decisionId)).state).toBe("verified");
  } finally { await h.cleanup(); }
});

test("missing publication proof keeps the successor visibly blocked without spending send attempts", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member"), limbo: NostrEvent[] = [];
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async (event) => { limbo.push(event); throw new Error("uncertain transport"); } });
    const second = await h.accept("unban_member");
    await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 8, available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const recovery = (await h.outbox.claim())!;
    expect(recovery).toMatchObject({ reconcileOnly: true, attempts: 8 });
    expect(await h.deliver(recovery, { ...h.relay, publish: async () => { throw new Error("Read-only recovery cannot publish"); } })).toMatchObject({ state: "failed", code: "concord_recovery_awaiting_proof" });
    expect(await concordRow(first.decisionId)).toMatchObject({ attempts: 8, signed_events: limbo });
    expect(await concordRow(second.decisionId)).toMatchObject({ attempts: 0, state: "pending", result_code: "concord_waiting_on_prior_publication" });
    h.published.push(...limbo);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await h.deliver((await h.outbox.claim())!);
    await h.drain();
    expect(await h.banned()).toBe(false);
  } finally { await h.cleanup(); }
});

test("Retry of superseded live uncertainty resumes only its exact attempted Concord generation", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async () => { throw new Error("uncertain transport"); } });
    const before = (await concordRow(first.decisionId)).signed_events;
    await sql`UPDATE moderation.deliveries SET state = 'failed', result_code = 'current_authority_or_delivery_unavailable' WHERE decision_id = ${first.decisionId}`;
    await h.accept("unban_member");
    const resumed = await h.outbox.retry(first.decisionId, h.staff);
    expect(resumed.deliveries.filter((row) => row.target !== "concord").every((row) => row.state === "failed")).toBe(true);
    const claim = (await h.outbox.claim())!;
    expect(claim).toMatchObject({ reconcileOnly: false, publicationAttempted: true, signedEvents: before });
    await h.deliver(claim);
    expect(h.published[0].id).toBe(before[0].id);
    await h.drain();
    expect(await h.banned()).toBe(false);
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
  // The race concerns relay ordering, after each unban's Concord prerequisite.
  const proveConcord = (id: string) => sql`UPDATE moderation.deliveries SET state = 'verified' WHERE decision_id = ${id} AND target = 'concord'`;
  await proveConcord(first.decisionId);
  const selected = latch(), finishSelection = latch(), secondReady = latch(), startSecond = latch();
  const applicationName = `member-claim-race-${crypto.randomUUID()}`;
  const secondSql = postgres(process.env.DATABASE_URL!, { max: 1, connection: { application_name: applicationName }, onnotice: () => {} });
  const firstOutbox = new Decisions(claimBarrier(sql, undefined, async () => { selected.resolve(); await finishSelection.promise; }), cipher, new Map([["a".repeat(64), org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
  const secondOutbox = new Decisions(claimBarrier(secondSql, async () => { secondReady.resolve(); await startSecond.promise; }), cipher, new Map([["a".repeat(64), org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
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
    await proveConcord(second.decisionId);
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

test("publication refresh schedules a lone expired receipt under the restricted API without replay", async () => {
  const h = await memberHarness("member");
  const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice: () => {} });
  try {
    const first = await h.accept("ban_member");
    const lost: NostrEvent[] = [];
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { lost.push(event); throw new Error("synthetic lost ack"); } });
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`; });
    await h.outbox.expire();
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const api = new Decisions(apiSql, cipher, new Map([[h.f.community.idHex, h.staff.orgId]]));
    const lease = crypto.randomUUID();
    await sql`UPDATE moderation.deliveries SET token = ${lease}, lease_until = clock_timestamp() + interval '1 minute' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const [leased] = await sql`SELECT * FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await api.refreshPublicationProof(first.decisionId, h.staff);
    expect((await sql`SELECT * FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`)[0]).toEqual(leased);
    await expect(Promise.resolve(apiSql`UPDATE moderation.deliveries SET result_code = 'concord_publication_settled' WHERE FALSE`)).rejects.toThrow(/permission denied/);
    await sql`UPDATE moderation.deliveries SET token = NULL, lease_until = NULL WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const before = await concordRow(first.decisionId);
    const refreshed = await api.refreshPublicationProof(first.decisionId, h.staff);
    expect(refreshed.deliveries.find(d => d.target === "concord")?.state).toBe("failed");
    expect(await concordRow(first.decisionId)).toEqual(before);
    const missing = await h.outbox.claim(); expect(missing).toBeDefined();
    expect(missing).toMatchObject({ reconcileOnly: true, signedEvents: null, publicationAttempted: true });
    expect(await h.deliver(missing!, { ...h.relay, queryStrict: async () => lost, publish: async () => { throw new Error("No proof-refresh resend"); } })).toMatchObject({ state: "failed", code: "concord_recovery_awaiting_proof" });
    h.published.push(...lost);
    await api.refreshPublicationProof(first.decisionId, h.staff);
    const operatorSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice: () => {} });
    let effects = 0;
    const forbidden = async (): Promise<never> => { effects++; throw new Error("No expired action execution"); };
    try {
      const operator = new Decisions(operatorSql, undefined, new Map([[h.f.community.idHex, h.staff.orgId]]));
      const worker = new ModerationWorker(operatorSql, operator, async (claim, assertCurrent) => {
        expect(claim).toMatchObject({ reconcileOnly: true, publicationProofOnly: true, signedEvents: null });
        return { reconcileOnly: claim.reconcileOnly, authorize: forbidden, assertCurrent,
          executeConcord: () => deliverConcord(claim, h.actions, operator, { ...h.relay, publish: forbidden }, assertCurrent),
          setRelayBan: forbidden, removeFromRelay: forbidden, discord: { execute: forbidden } };
      });
      expect(await worker.tick()).toBe(true);
      expect(await concordRow(first.decisionId)).toMatchObject({ state: "not_applicable", result_code: "concord_publication_settled" });
      expect(effects).toBe(0);
    } finally { await operatorSql.end(); }
    expect((await sql`SELECT decision_id FROM moderation.decisions WHERE org_id = ${h.staff.orgId}`).length).toBe(1);
    expect((await concordRow(first.decisionId)).attempts).toBe(before.attempts);
    await expect(api.retry(first.decisionId, h.staff)).rejects.toThrow();
  } finally { await apiSql.end(); await h.cleanup(); }
});

test("missing lifecycle policy refuses new allocation but preserves exact accepted replay", async () => {
  const subject = await memberCase(), request = { ...input, caseId: subject.caseId, executionId: crypto.randomUUID() };
  const missing = new Decisions(sql, cipher, new Map([["a".repeat(64), org]]));
  await expect(missing.acceptDecision(request, actor)).rejects.toThrow(/configuration required/);
  expect((await sql`SELECT decision_id FROM moderation.decisions WHERE execution_id = ${request.executionId}`).length).toBe(0);
  const accepted = await decisions.acceptDecision(request, actor);
  expect((await missing.acceptDecision(request, actor)).decisionId).toBe(accepted.decisionId);
  await settle(accepted.decisionId);
});

test("signed bytes expire in terminal states while independent actor/reason and receipt facts survive", async () => {
  const subject = await memberCase(), request = { ...input, caseId: subject.caseId, executionId: crypto.randomUUID() };
  const accepted = await decisions.acceptDecision(request, actor), eventId = "f".repeat(64), token = crypto.randomUUID();
  await sql`UPDATE moderation.deliveries SET state = 'verified', signed_events = ${sql.json([{ id: eventId }])}, publication_attempted = true, publication_event_ids = ARRAY[${eventId}] WHERE decision_id = ${accepted.decisionId}`;
  await sql`UPDATE moderation.deliveries SET state = 'failed', result_code = 'synthetic_failure', token = ${token}, lease_until = clock_timestamp() + interval '1 minute' WHERE decision_id = ${accepted.decisionId} AND target = 'concord'`;
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${accepted.decisionId}`; });
  await decisions.expire();
  const rows = await sql`SELECT target, state, signed_events, publication_event_ids, publication_attempted, result_code, token FROM moderation.deliveries WHERE decision_id = ${accepted.decisionId}`;
  expect(rows.every(row => row.signed_events === null)).toBe(true);
  expect(rows.every(row => row.publication_attempted && row.publication_event_ids[0] === eventId)).toBe(true);
  expect(rows.find(row => row.target === 'concord')).toMatchObject({ state: 'failed', result_code: 'synthetic_failure', token });
  const [row] = await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${accepted.decisionId}`;
  expect(cipher.open(`${org}:${accepted.decisionId}`, row.audit)).toEqual({ actorId: actor.actorId, reason: request.reason });
});

test("erasing a legacy failed publication without receipt IDs keeps its successor fenced", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async () => { throw new Error("synthetic uncertain legacy send"); } });
    await sql`UPDATE moderation.deliveries SET state = 'failed', publication_event_ids = NULL WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`; });
    await h.outbox.expire();
    expect(await concordRow(first.decisionId)).toMatchObject({ state: 'failed', signed_events: null, result_code: 'concord_recovery_requires_operator' });
    const successor = await h.accept("unban_member");
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(successor.decisionId)).toMatchObject({ state: 'pending', attempts: 0, result_code: 'concord_waiting_on_prior_publication' });
  } finally { await h.cleanup(); }
});

test("expiry does not revisit an expired decision that has nothing left to expire", async () => {
  const expireNow = (id: string) => sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${id}`; });
  const settled = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  await expireNow(settled.decisionId);
  await decisions.expire();
  expect((await decisions.get(settled.decisionId, actor)).deliveries.every(d => d.state === "failed" && d.resultCode === "decision_expired")).toBe(true);
  const pending = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  await expireNow(pending.decisionId);
  // Hold the settled decision's row as a long staff transaction would. Expiry
  // that still selects it would wait here instead of reaching the pending one.
  let release!: () => void, locked!: () => void;
  const held = new Promise<void>(r => { release = r; }), isLocked = new Promise<void>(r => { locked = r; });
  const holder = sql.begin(async tx => { await tx`SELECT 1 FROM moderation.decisions WHERE decision_id = ${settled.decisionId} FOR UPDATE`; locked(); await held; });
  await isLocked;
  const run = decisions.expire();
  let outcome: string;
  try { outcome = await Promise.race([run.then(() => "finished"), Bun.sleep(1500).then(() => "blocked on a settled decision")]); }
  finally { release(); await holder; await run; }
  expect(outcome).toBe("finished");
  expect((await decisions.get(pending.decisionId, actor)).deliveries.every(d => d.state === "failed" && d.resultCode === "decision_expired")).toBe(true);
});

test("restriction refresh schedules observation of a settled delivery without rescheduling a pending send", async () => {
  const accepted = await decisions.acceptDecision({ ...input, executionId: crypto.randomUUID() }, actor);
  const discordAt = async () => (await sql`SELECT available_at FROM moderation.deliveries WHERE decision_id = ${accepted.decisionId} AND target = 'discord'`)[0].available_at.getTime();
  for (const state of ["pending", "acknowledged"]) {
    // A send honoring Retry-After or backoff keeps its schedule and its attempts.
    await sql`UPDATE moderation.deliveries SET state = ${state}, available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${accepted.decisionId} AND target = 'discord'`;
    const before = await discordAt();
    await decisions.refreshDiscordRestriction(accepted.decisionId, actor);
    expect(await discordAt()).toBe(before);
  }
  await sql`UPDATE moderation.deliveries SET state = 'verified', available_at = clock_timestamp() - interval '1 hour' WHERE decision_id = ${accepted.decisionId} AND target = 'discord'`;
  const before = await discordAt();
  await decisions.refreshDiscordRestriction(accepted.decisionId, actor);
  expect(await discordAt()).toBeGreaterThan(before);
});

test("a canonical ban settled after expiry supplies a fresh reversal that unbans without report evidence", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id <> ${first.decisionId}`;
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { h.published.push(event); throw new Error("lost acknowledgement"); } });
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`; });
    await h.outbox.expire();
    await sql`DELETE FROM moderation.cases WHERE case_id = ${h.request("unban_member").caseId}`;
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    expect(await h.deliver((await h.outbox.claim())!)).toMatchObject({ state: "not_applicable", code: "concord_publication_settled" });
    expect(await h.banned()).toBe(true);
    const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
    try {
      const api = new Decisions(client, cipher, new Map([[h.f.community.idHex, h.staff.orgId]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
      expect((await api.getReversalContext(first.decisionId, h.staff)).author).toBe(h.who.pk);
      const { executionId, reason, sourceOrder } = h.request("unban_member");
      const next = await api.acceptReversal(first.decisionId, { executionId, reason, sourceOrder, action: "unban_member", scope: "community", discordGuildConfirmed: false }, h.staff);
      await hold(next.decisionId, "concord");
      expect(await h.deliver((await h.outbox.claim())!)).toMatchObject({ state: "verified" });
      expect(await h.banned()).toBe(false);
      expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${h.request("unban_member").caseId}`).length).toBe(0);
    } finally { await client.end(); }
  } finally { await h.cleanup(); }
});

async function otherCommunityMember(h: Awaited<ReturnType<typeof memberHarness>>, action: "ban_member" | "unban_member" = "unban_member") {
  const caseId = crypto.randomUUID();
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${caseId}, ${h.staff.orgId}, ${h.f.community.idHex}, ${h.f.channelId}, ${h.f.allowedRumorId}, ${h.f.bannedMember.pk}, ${crypto.randomUUID()}, ${Buffer.from("synthetic other member")}, clock_timestamp() + interval '1 hour')`;
  const status = await h.outbox.acceptDecision({ ...h.request(action), caseId }, h.staff);
  await hold(status.decisionId, "concord");
  return status;
}
test("an uncertain community generation fences another member until canonical proof settles it", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member"), limbo: NostrEvent[] = [];
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id <> ${first.decisionId}`;
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { limbo.push(event); throw new Error("uncertain transport"); } });
    const second = await otherCommunityMember(h);
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(second.decisionId)).toMatchObject({ attempts: 0, state: "pending", result_code: "concord_waiting_on_prior_publication" });
    await sql`UPDATE moderation.deliveries SET state = 'failed', result_code = 'retry_budget_exhausted', attempts = 8, available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const recovery = (await h.outbox.claim())!;
    expect(recovery).toMatchObject({ reconcileOnly: true, publicationProofOnly: true });
    expect(await h.deliver(recovery)).toMatchObject({ state: "failed", code: "concord_recovery_awaiting_proof" });
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(second.decisionId)).toMatchObject({ attempts: 0, signed_events: null });
    h.published.push(...limbo);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    expect(await h.deliver((await h.outbox.claim())!)).toMatchObject({ state: "not_applicable", code: "concord_publication_settled" });
    expect(await h.deliver((await h.outbox.claim())!)).toMatchObject({ state: "verified" });
    expect(await h.banned()).toBe(true);
    const final = await h.actions.authorize({ decisionId: second.decisionId, orgId: h.staff.orgId, caseId: h.request("ban_member").caseId, target: second.target, author: h.f.bannedMember.pk, action: "unban_member", discordGuildConfirmed: false, expiresAt: new Date(Date.now() + 60000) });
    expect(final.folded.banned.has(h.f.bannedMember.pk)).toBe(false);
    expect(await concordRow(first.decisionId)).toMatchObject({ signed_events: limbo, attempts: 8 });
  } finally { await h.cleanup(); }
});
test("simultaneous claimers serialize different members of one community before either generation is prepared", async () => {
  const h = await memberHarness("member"), selected = latch(), finish = latch();
  const applicationName = `community-claim-${crypto.randomUUID()}`;
  const secondSql = postgres(process.env.DATABASE_URL!, { max: 1, connection: { application_name: applicationName }, onnotice() {} });
  let firstClaim: ReturnType<Decisions["claim"]> | undefined, secondClaim: ReturnType<Decisions["claim"]> | undefined;
  try {
    const first = await h.accept("ban_member");
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id <> ${first.decisionId}`;
    const second = await otherCommunityMember(h);
    const a = new Decisions(claimBarrier(sql, undefined, async () => { selected.resolve(); await finish.promise; }), undefined, new Map());
    const b = new Decisions(secondSql, undefined, new Map());
    firstClaim = a.claim(); await selected.promise;
    expect((await sql`SELECT lease_until FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`)[0].lease_until).toBeNull();
    secondClaim = b.claim();
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const [backend] = await sql`SELECT wait_event_type FROM pg_stat_activity WHERE application_name = ${applicationName}`;
      if (backend?.wait_event_type === "Lock") { blocked = true; break; }
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true); finish.resolve();
    const [one, two] = await Promise.all([firstClaim, secondClaim]);
    expect(one?.decision.decisionId).toBe(first.decisionId); expect(two).toBeUndefined();
    expect(await concordRow(second.decisionId)).toMatchObject({ attempts: 0, signed_events: null });
    await h.deliver(one!);
    expect(await h.deliver((await h.outbox.claim())!)).toMatchObject({ state: "verified" });
    expect(await h.banned()).toBe(true);
  } finally { finish.resolve(); await Promise.allSettled([...(firstClaim ? [firstClaim] : []), ...(secondClaim ? [secondClaim] : [])]); await secondSql.end(); await h.cleanup(); }
});
test("a community publication fence leaves other communities and non-Concord destinations claimable", async () => {
  const h = await memberHarness("member"), independent = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id <> ${first.decisionId}`;
    const sending = (await h.outbox.claim())!;
    const second = await otherCommunityMember(h, "ban_member");
    const other = await independent.accept("ban_member");
    expect((await independent.outbox.claim())?.decision.decisionId).toBe(other.decisionId);
    for (const target of ["divine_relay", "discord"] as const) {
      await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${second.decisionId} AND target = ${target}`;
      const claim = (await h.outbox.claim())!; expect(claim.target).toBe(target); expect(claim.decision.decisionId).toBe(second.decisionId);
      await h.outbox.complete(claim, "verified", "synthetic_destination_verified");
    }
    expect(await concordRow(second.decisionId)).toMatchObject({ attempts: 0, state: "pending", result_code: "concord_waiting_on_prior_publication" });
    await h.deliver(sending);
  } finally { await independent.cleanup(); await h.cleanup(); }
});

test("operator recovery stays failed across missing proof, worker failure, restart and API Retry until canonical settlement", async () => {
  const h = await memberHarness("member");
  const operatorSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
  const operator = new Decisions(operatorSql, undefined, new Map([[h.f.community.idHex, h.staff.orgId]]));
  const proof = async () => {
    const claim = (await operator.claim())!;
    const result = await deliverConcord(claim, h.actions, operator, h.relay as never, async () => {});
    await operator.complete(claim, result.state, result.code, result.retryAfterSeconds);
    return result;
  };
  const client = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
  try {
    const first = await h.accept("ban_member"), limbo: NostrEvent[] = [];
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id <> ${first.decisionId}`;
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { limbo.push(event); throw new Error("uncertain transport"); } });
    await sql`UPDATE moderation.deliveries SET state = 'failed', result_code = 'concord_recovery_requires_operator', available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const second = await h.accept("unban_member");
    const before = await concordRow(first.decisionId);
    expect(await proof()).toMatchObject({ state: "failed", code: "concord_recovery_awaiting_proof" });
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator", attempts: before.attempts, signed_events: before.signed_events });
    const api = new Decisions(client, cipher, new Map([[h.f.community.idHex, h.staff.orgId]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
    await expect(api.retry(first.decisionId, h.staff)).rejects.toMatchObject({ code: "member_decision_superseded" });
    await migrateModeration(sql);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await operator.complete((await operator.claim())!, "failed", "worker_ownership_or_delivery_failed");
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator", attempts: before.attempts });
    await expect(api.retry(first.decisionId, h.staff)).rejects.toMatchObject({ code: "member_decision_superseded" });
    expect(await concordRow(second.decisionId)).toMatchObject({ state: "pending", attempts: 0 });
    h.published.push(...limbo);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    expect(await proof()).toMatchObject({ state: "not_applicable", code: "concord_superseded_publication_settled" });
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "not_applicable", result_code: "concord_superseded_publication_settled", attempts: before.attempts });
    await h.deliver((await h.outbox.claim())!);
    expect(await h.banned()).toBe(false);
  } finally { await client.end(); await operatorSql.end(); await h.cleanup(); }
});

for (const state of ["pending", "acknowledged"] as const) test(`pre-upgrade ${state} community publications can reconcile without republishing or spending attempts`, async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member"), second = await otherCommunityMember(h, "ban_member");
    // Model two attempted generations left by the old per-member fence. Each
    // would block the other's normal send under the new community-wide fence.
    for (const [index, id] of [first.decisionId, second.decisionId].entries()) {
      await sql`UPDATE moderation.deliveries SET state = ${state}, attempts = 2, publication_attempted = true,
        publication_event_ids = ARRAY[${String(index + 1).repeat(64)}], result_code = 'concord_transport_unavailable', available_at = clock_timestamp()
        WHERE decision_id = ${id} AND target = 'concord'`;
    }
    let sends = 0;
    const ids = new Set<string>();
    for (let pass = 0; pass < 2; pass++) {
      const claim = (await h.outbox.claim())!;
      expect(claim.reconcileOnly).toBe(true);
      expect(claim.attempts).toBe(2);
      ids.add(claim.decision.decisionId);
      const result = await deliverConcord(claim, h.actions, h.outbox, {
        queryStrict: async () => [], publish: async () => { sends++; throw new Error("Readback must not publish"); },
      } as never, async () => {});
      expect(result).toMatchObject({ state: "failed", code: "concord_recovery_awaiting_proof" });
      await h.outbox.complete(claim, result.state, result.code, result.retryAfterSeconds);
    }
    expect([...ids].sort()).toEqual([first.decisionId, second.decisionId].sort());
    expect(sends).toBe(0);
    expect(await concordRow(first.decisionId)).toMatchObject({ state, attempts: 2 });
    expect(await concordRow(second.decisionId)).toMatchObject({ state, attempts: 2 });
    const [schedule] = await sql`SELECT available_at FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await h.outbox.refreshPublicationProof(first.decisionId, h.staff);
    expect((await sql`SELECT available_at FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'concord'`)[0].available_at).toEqual(schedule.available_at);
    // A later pass still observes both, rather than leaving two new failures
    // ineligible until expiry or a third member happens to enqueue work.
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id IN ${sql([first.decisionId, second.decisionId])} AND target = 'concord'`;
    const repeated = [await h.outbox.claim(), await h.outbox.claim()];
    expect(repeated.map(claim => claim?.reconcileOnly)).toEqual([true, true]);
    expect(repeated.map(claim => claim?.decision.decisionId).sort()).toEqual([first.decisionId, second.decisionId].sort());
    for (const claim of repeated) await h.outbox.defer(claim!);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id IN ${sql([first.decisionId, second.decisionId])} AND target = 'concord'`;
    // Absence has not become a settled receipt or released new community work.
    const next = await h.accept("unban_member");
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(next.decisionId)).toMatchObject({ state: "pending", attempts: 0, result_code: "concord_waiting_on_prior_publication" });
  } finally { await h.cleanup(); }
});

for (const state of ["pending", "acknowledged"] as const) test(`deferring pre-upgrade ${state} readback preserves its state and eligibility`, async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member"), second = await otherCommunityMember(h, "ban_member");
    for (const [index, id] of [first.decisionId, second.decisionId].entries()) await sql`UPDATE moderation.deliveries SET state = ${state}, attempts = 2, publication_attempted = true,
      publication_event_ids = ARRAY[${String(index + 1).repeat(64)}], result_code = 'concord_transport_unavailable', available_at = clock_timestamp()
      WHERE decision_id = ${id} AND target = 'concord'`;
    const claim = (await h.outbox.claim())!;
    expect(claim).toMatchObject({ reconcileOnly: true, claimedState: state, attempts: 2 });
    await h.outbox.defer(claim);
    expect(await concordRow(claim.decision.decisionId)).toMatchObject({ state, attempts: 2, result_code: "concord_transport_unavailable" });
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id <> ${claim.decision.decisionId}`;
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${claim.decision.decisionId} AND target = 'concord'`;
    expect(await h.outbox.claim()).toMatchObject({ reconcileOnly: true, claimedState: state, attempts: 2, decision: { decisionId: claim.decision.decisionId } });
  } finally { await h.cleanup(); }
});

for (const uncertain of [false, true]) test(`expired relay-only reversal ${uncertain ? "retains publication uncertainty" : "verifies Concord and lifts the relay ban"}`, async () => {
  const h = await memberHarness("member");
  const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
  const operatorSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
  const scope = new Map([[h.f.community.idHex, h.staff.orgId]]), store = new PolicyStore(operatorSql), operator = new Decisions(operatorSql, undefined, scope);
  try {
    const first = await h.accept("ban_member");
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id <> ${first.decisionId}`;
    await store.setBan(h.f.community.idHex, h.who.pk, true);
    await sql`UPDATE moderation.deliveries SET state = 'verified' WHERE decision_id = ${first.decisionId} AND target = 'divine_relay'`;
    if (uncertain) await h.deliver((await operator.claim())!, { ...h.relay, publish: async () => { throw new Error("uncertain transport"); } });
    else await sql`UPDATE moderation.deliveries SET state = 'failed', publication_attempted = false, result_code = 'current_authority_or_delivery_unavailable' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`; });
    await operator.expire();
    const caseId = h.request("unban_member").caseId;
    await sql`DELETE FROM moderation.cases WHERE case_id = ${caseId}`;
    const api = new Decisions(apiSql, cipher, scope, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
    expect((await api.getReversalContext(first.decisionId, h.staff)).author).toBe(h.who.pk);
    const { executionId, reason, sourceOrder } = h.request("unban_member");
    const next = await api.acceptReversal(first.decisionId, { executionId, reason, sourceOrder, action: "unban_member", scope: "community", discordGuildConfirmed: false }, h.staff);
    await hold(next.decisionId, "concord");
    if (uncertain) await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const concord = (await operator.claim())!;
    const result = await deliverConcord(concord, h.actions, operator, h.relay as never, async () => {});
    await operator.complete(concord, result.state, result.code, result.retryAfterSeconds);
    expect(result.state).toBe(uncertain ? "failed" : "verified");
    expect(concord.decision.decisionId).toBe(uncertain ? first.decisionId : next.decisionId);
    if (uncertain) {
      expect(concord.reconcileOnly).toBe(true);
      expect(h.published).toHaveLength(0);
      expect(await concordRow(next.decisionId)).toMatchObject({ state: "pending", attempts: 0, signed_events: null });
      expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator" });
    }
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${next.decisionId} AND target = 'divine_relay'`;
    if (uncertain) {
      expect(await operator.claim()).toBeUndefined();
      expect((await sql`SELECT state, result_code, attempts FROM moderation.deliveries WHERE decision_id = ${next.decisionId} AND target = 'divine_relay'`)[0])
        .toEqual({ state: "pending", result_code: "relay_awaiting_concord_state", attempts: 0 });
      expect((await store.getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(true);
      expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(0);
      return;
    }
    const relay = (await operator.claim())!;
    expect(relay.target).toBe("divine_relay"); expect(relay.decision.decisionId).toBe(next.decisionId);
    const context = createExecutionContext({ sql: operatorSql, store, actions: h.actions, claim: relay, assertCurrent: () => operator.renew(relay), decisions: operator,
      relay: h.relay as never, discord: {} as never, purger: {} as never, driver: { barrier: work => work() } });
    const applied = await executeDelivery(relay.decision, relay.target, context);
    await operator.complete(relay, applied.state, applied.code, applied.retryAfterSeconds);
    expect(applied).toEqual({ state: "verified", code: "relay_member_policy_verified" });
    expect((await store.getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(uncertain);
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${caseId}`).length).toBe(0);
  } finally { await apiSql.end(); await operatorSql.end(); await h.cleanup(); }
});

test("relay unban waits through repeated Concord failures without consuming its own budget", async () => {
  const h = await memberHarness("bannedMember"), store = new PolicyStore(sql);
  try {
    await store.setBan(h.f.community.idHex, h.who.pk, true);
    const unban = await h.accept("unban_member"), concord = (await h.outbox.claim())!;
    expect(concord.target).toBe("concord");
    await h.outbox.complete(concord, "failed", "current_authority_or_delivery_unavailable");
    for (let poll = 0; poll < 10; poll++) {
      await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${unban.decisionId} AND target = 'divine_relay'`;
      expect(await h.outbox.claim()).toBeUndefined();
    }
    expect((await sql`SELECT state, result_code, attempts FROM moderation.deliveries WHERE decision_id = ${unban.decisionId} AND target = 'divine_relay'`)[0])
      .toEqual({ state: "pending", result_code: "relay_awaiting_concord_state", attempts: 0 });
    await h.outbox.retry(unban.decisionId, h.staff);
    expect(await h.deliver((await h.outbox.claim())!)).toMatchObject({ state: "verified" });
    const relay = (await h.outbox.claim())!;
    expect(relay).toMatchObject({ target: "divine_relay", attempts: 1, decision: { decisionId: unban.decisionId } });
    const context = createExecutionContext({ sql, store, actions: h.actions, claim: relay, assertCurrent: () => h.outbox.renew(relay), decisions: h.outbox,
      relay: h.relay as never, discord: {} as never, purger: {} as never, driver: { barrier: work => work() } });
    const applied = await executeDelivery(relay.decision, relay.target, context);
    await h.outbox.complete(relay, applied.state, applied.code);
    expect(applied).toEqual({ state: "verified", code: "relay_member_policy_verified" });
    expect((await store.getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(false);
  } finally { await h.cleanup(); }
});

for (const superseded of [false, true]) test(`readback-settled unban ${superseded ? "cannot undo a newer ban" : "lifts its relay ban"}`, async () => {
  const h = await memberHarness("bannedMember"), store = new PolicyStore(sql), limbo: NostrEvent[] = [];
  try {
    await store.setBan(h.f.community.idHex, h.who.pk, true);
    const unban = await h.accept("unban_member");
    for (let i = 0; i < 8; i++) {
      const claim = (await h.outbox.claim())!;
      expect(claim).toMatchObject({ target: "concord", decision: { decisionId: unban.decisionId } });
      await h.deliver(claim, { ...h.relay, publish: async event => { limbo.push(event); throw new Error("lost acknowledgement"); } });
      await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${unban.decisionId} AND target = 'concord'`;
    }
    // Its own waiting relay unban requires readback; no unrelated community
    // decision may be needed to discover that the publication already landed.
    const newer = superseded ? await h.accept("ban_member") : undefined;
    await h.outbox.refreshPublicationProof(unban.decisionId, h.staff);
    h.published.push(...limbo);
    const recovery = (await h.outbox.claim())!;
    expect(recovery).toMatchObject({ reconcileOnly: true, decision: { decisionId: unban.decisionId } });
    expect(await h.deliver(recovery)).toMatchObject({ state: "not_applicable", code: superseded ? "concord_superseded_publication_settled" : "concord_publication_settled" });
    if (newer) await hold(newer.decisionId);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${unban.decisionId} AND target = 'divine_relay'`;
    if (superseded) {
      expect(await h.outbox.claim()).toBeUndefined();
      expect((await sql`SELECT state, result_code FROM moderation.deliveries WHERE decision_id = ${unban.decisionId} AND target = 'divine_relay'`)[0])
        .toEqual({ state: "failed", result_code: "superseded_by_newer_decision" });
      expect((await store.getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(true);
      return;
    }
    const relay = (await h.outbox.claim())!;
    expect(relay).toMatchObject({ target: "divine_relay", decision: { decisionId: unban.decisionId } });
    const context = createExecutionContext({ sql, store, actions: h.actions, claim: relay, assertCurrent: () => h.outbox.renew(relay), decisions: h.outbox,
      relay: h.relay as never, discord: {} as never, purger: {} as never, driver: { barrier: work => work() } });
    expect(await executeDelivery(relay.decision, relay.target, context)).toEqual({ state: "verified", code: "relay_member_policy_verified" });
    expect((await store.getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(false);
  } finally { await h.cleanup(); }
});

for (const changed of ["deleted_channel", "promoted_target"] as const) test(`proved relay unban releases the member after ${changed}`, async () => {
  const h = await memberHarness("bannedMember"), store = new PolicyStore(sql);
  try {
    await store.setBan(h.f.community.idHex, h.who.pk, true);
    const unban = await h.accept("unban_member"), claim = (await h.outbox.claim())!;
    const events = await h.actions.prepare(claim.decision);
    await h.outbox.saveEvents(claim, events);
    await h.deliver(claim, { ...h.relay, publish: async event => { h.published.push(event); throw new Error("lost acknowledgement"); } });
    if (changed === "deleted_channel") {
      const head = controlState(await recoveryPolicy(h)).folded.heads.get(h.f.channelId)!;
      h.published.push(await sealEdition(buildChannelEdition(Buffer.from(h.f.channelId, "hex"), { name: "general", private: false, deleted: true }, { actorPubkey: h.f.owner.pk, version: head.version + 1n, prevHash: head.hash }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
    } else {
      h.published.push(await sealEdition(buildGrantEdition(h.f.community.id, { member: h.who.pk, roleIds: [h.f.roleId] }, { actorPubkey: h.f.owner.pk, version: 1n }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
      // Promotion can make the moderator's historical removal inadmissible
      // in the current fold. The relay must still see a current unban, here
      // independently established by the owner after the promotion.
      const state = controlState(await recoveryPolicy(h)), head = state.folded.heads.get(bytesToHex(banlistLocator(h.f.community.id)))!;
      h.published.push(await sealEdition(buildBanlistEdition(h.f.community.id, [...state.folded.banned].filter(pk => pk !== h.who.pk), { actorPubkey: h.f.owner.pk, version: head.version + 1n, prevHash: head.hash }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
    }
    await expect(h.actions.authorize(claim.decision)).rejects.toThrow();
    expect(await proveGeneration(h, unban.decisionId, events[0].id)).toMatchObject({ code: "concord_publication_settled" });
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${unban.decisionId} AND target = 'divine_relay'`;
    const relay = (await h.outbox.claim())!;
    expect(relay.target).toBe("divine_relay");
    const context = createExecutionContext({ sql, store, actions: h.actions, claim: relay, assertCurrent: () => h.outbox.renew(relay), decisions: h.outbox,
      relay: h.relay as never, discord: {} as never, purger: {} as never, driver: { barrier: work => work() } });
    // The target-specific relaxation must not become an expired-intent bypass.
    expect(await executeDelivery({ ...relay.decision, expiresAt: new Date(0) }, relay.target, context)).toMatchObject({ state: "failed" });
    expect((await store.getPolicy(h.f.community.idHex))!.banned).toContain(h.who.pk);
    expect(await executeDelivery(relay.decision, relay.target, context)).toEqual({ state: "verified", code: "relay_member_policy_verified" });
    expect((await store.getPolicy(h.f.community.idHex))!.banned).not.toContain(h.who.pk);
  } finally { await h.cleanup(); }
});

for (const code of ["concord_publication_settled", "unrelated_not_applicable"]) test(`relay unban retains current ban despite receipt ${code}`, async () => {
  const h = await memberHarness("bannedMember"), store = new PolicyStore(sql);
  try {
    await store.setBan(h.f.community.idHex, h.who.pk, true);
    const unban = await h.accept("unban_member");
    await hold(unban.decisionId);
    await sql`UPDATE moderation.deliveries SET state = 'not_applicable', result_code = ${code} WHERE decision_id = ${unban.decisionId} AND target = 'concord'`;
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${unban.decisionId} AND target = 'divine_relay'`;
    const relay = await h.outbox.claim();
    if (code === "unrelated_not_applicable") { expect(relay).toBeUndefined(); return; }
    expect(relay?.target).toBe("divine_relay");
    const context = createExecutionContext({ sql, store, actions: h.actions, claim: relay!, assertCurrent: () => h.outbox.renew(relay!), decisions: h.outbox,
      relay: h.relay as never, discord: {} as never, purger: {} as never, driver: { barrier: work => work() } });
    expect(await executeDelivery(relay!.decision, relay!.target, context)).toEqual({ state: "acknowledged", code: "relay_awaiting_concord_state" });
    expect((await store.getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(true);
  } finally { await h.cleanup(); }
});

test("operator exact replay recovers an exhausted outage then another member's unban; stale requests cannot repeat", async () => {
  const h = await memberHarness("member");
  const operator = { ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] };
  try {
    const first = await h.accept("ban_member");
    let original: NostrEvent | undefined;
    for (let i = 0; i < 8; i++) {
      const claim = (await h.outbox.claim())!;
      await h.deliver(claim, { ...h.relay, publish: async event => { original ??= event; expect(event.id).toBe(original.id); throw Error("outage"); } });
      await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    }
    expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", attempts: 8, result_code: "retry_budget_exhausted" });
    const next = await otherCommunityMember(h);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${first.decisionId}`;
    expect(await h.outbox.claim()).toBeUndefined();
    const status = await h.outbox.get(next.decisionId, h.staff);
    expect(status.publicationBlockers).toContainEqual(expect.objectContaining({ decisionId: first.decisionId, eventId: original!.id, recoveryVersion: 0 }));
    const request = { decisionId: first.decisionId, expectedVersion: 0, eventId: original!.id, operation: "replay" as const, reason: "Synthetic restored relay" };
    const recover = (actor = operator) => recoverPublication({ sql, decisions: h.outbox, cipher, actions: h.actions, relay: h.relay as never, actor, request });
    await expect(recover(h.staff)).rejects.toThrow(/authorization/);
    await expect(recover({ ...operator, orgId: crypto.randomUUID() })).rejects.toThrow();
    const result = await recover();
    expect(result).toMatchObject({ state: "verified", code: "concord_enforcement_verified" });
    expect((await concordRow(first.decisionId)).attempts).toBe(8);
    expect(h.published.map(event => event.id)).toEqual([original!.id]);
    await expect(recover()).rejects.toThrow(/Stale/);
    const [audit] = await sql`SELECT * FROM moderation.lifecycle_events WHERE event_id = ${result.recoveryId}`;
    expect(cipher.open(`${h.staff.orgId}:${result.recoveryId}`, audit.encrypted_audit)).toEqual({ actorId: operator.actorId, reason: request.reason });
    await expect((async () => { await sql`UPDATE moderation.publication_recoveries SET operation = 'prove' WHERE recovery_id = ${result.recoveryId}`; })()).rejects.toThrow(/immutable/);
    await h.drain();
    expect((await concordRow(next.decisionId)).state).toBe("verified");
    h.published.push(original!);
    const current = controlState(refreshPolicy({ ...h.f.policy, controlEvents: [...h.f.policy.controlEvents, ...h.published] })).folded;
    expect(current.banned.has(h.f.bannedMember.pk)).toBe(false);
  } finally { await h.cleanup(); }
});

test("legacy identity-less uncertainty rejects pilot preflight and reports the holding decision", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async () => { throw Error("legacy outage"); } });
    await sql`UPDATE moderation.deliveries SET publication_metadata = NULL WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    expect((await h.outbox.get(first.decisionId, h.staff)).publicationBlockers).toContainEqual(expect.objectContaining({ decisionId: first.decisionId, recovery: "replay_before_expiry_or_recover_original_event" }));
    await assertPilotPublicationProvenance(sql, h.f.community.idHex);
    await sql`UPDATE moderation.deliveries SET signed_events = NULL, publication_metadata = NULL, state = 'failed', result_code = 'concord_recovery_requires_operator' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await expect(assertPilotPublicationProvenance(sql, h.f.community.idHex)).rejects.toThrow(/pilot_publication_provenance_required/);
    await sql`UPDATE moderation.deliveries SET publication_event_ids = NULL WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const next = await otherCommunityMember(h);
    await expect(assertPilotPublicationProvenance(sql, h.f.community.idHex)).rejects.toThrow(/pilot_publication_provenance_required/);
    expect((await h.outbox.get(next.decisionId, h.staff)).publicationBlockers).toContainEqual(expect.objectContaining({ decisionId: first.decisionId, recovery: "authentic_provenance_or_separate_community" }));
    expect(await h.outbox.claim()).toBeUndefined();
  } finally { await h.cleanup(); }
});

test("an unsaved first-send lease is a wait, but a leased unknown publication still excludes startup", async () => {
  const h = await memberHarness("member"), store = new PolicyStore(sql);
  try {
    const first = await h.accept("ban_member"), claim = (await h.outbox.claim())!;
    const waiting = await otherCommunityMember(h);
    expect(await publicationBlockers(sql, h.f.community.idHex)).toEqual([expect.objectContaining({ decisionId: first.decisionId, publicationAttempted: true, recovery: "wait_for_current_lease", leased: true })]);
    expect((await h.outbox.get(waiting.decisionId, h.staff)).publicationBlockers).toEqual([expect.objectContaining({ decisionId: first.decisionId, recovery: "wait_for_current_lease" })]);
    await assertPilotPublicationProvenance(sql, h.f.community.idHex);
    await expect(workerAtOwnedController(h)).rejects.toThrow(/Community controller already owned/);
    // Refused controller startup invalidates its old policy at shutdown.
    const revision = (await store.getPolicy(h.f.community.idHex))!.revision;
    await store.install(refreshPolicy({ ...h.f.policy, revision: revision + 1 }), [h.f.chatStream, h.f.controlStream, h.f.guestbookStream], revision);
    await h.deliver(claim);
    await sql`UPDATE moderation.deliveries SET state = 'failed', signed_events = NULL, publication_metadata = NULL, publication_event_ids = NULL,
      result_code = 'concord_recovery_requires_operator', lease_until = clock_timestamp() + interval '1 minute' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    expect(await publicationBlockers(sql, h.f.community.idHex)).toEqual([expect.objectContaining({ decisionId: first.decisionId, recovery: "authentic_provenance_or_separate_community", leased: true })]);
    await expect(workerAtOwnedController(h)).rejects.toThrow(/pilot_publication_provenance_required/);
    expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
  } finally { await h.cleanup(); }
});

for (const scenario of ["different_content", "owner_rumor_first", "old_rumor_first"]) test(`owner supersession preserves the original tracking floor: ${scenario}`, async () => {
  const h = await memberHarness("member");
  try {
    const supersededUnban = scenario === "old_rumor_first";
    const first = await h.accept(supersededUnban ? "unban_member" : "ban_member");
    if (supersededUnban) await new PolicyStore(sql).setBan(h.f.community.idHex, h.who.pk, true);
    let old!: NostrEvent;
    const claim = (await h.outbox.claim())!;
    const prepared = parseEdition(openWrap((await h.actions.prepare(claim.decision))[0], h.f.controlStream.key));
    // Keep the original ID away from either extreme so both sibling orders
    // are exercised without a rare-hash fixture or an unbounded owner search.
    let timestamp = Math.floor(Date.now() / 1000), rumor;
    do { rumor = buildBanlistEdition(h.f.community.id, JSON.parse(prepared.content), { actorPubkey: h.f.moderator.pk, version: prepared.version, prevHash: prepared.prevHash, authority: prepared.authority, createdAtSecs: timestamp-- }); } while (!rumor.id.startsWith("7"));
    await h.outbox.saveEvents(claim, [await sealEdition(rumor, currentControlWriteGroup(h.f.community), h.f.moderator.signer)]);
    await h.deliver(claim, { ...h.relay, publish: async event => { old = event; throw Error("outage"); } });
    const candidate = parseEdition(openWrap(old, h.f.controlStream.key));
    const ownerEvent = async (version: bigint, prevHash: Uint8Array | undefined, createdAtSecs = Math.floor(Date.now() / 1000)) => sealEdition(buildBanlistEdition(h.f.community.id,
      version === candidate.version && scenario !== "different_content" ? JSON.parse(candidate.content) : [h.f.bannedMember.pk],
      { actorPubkey: h.f.owner.pk, version, prevHash, createdAtSecs }), currentControlWriteGroup(h.f.community), h.f.owner.signer);
    let sibling!: NostrEvent;
    for (let i = 0; i < 1000; i++) {
      sibling = await ownerEvent(candidate.version, candidate.prevHash, Math.floor(Date.now() / 1000) - i);
      if ((bytesToHex(parseEdition(openWrap(sibling, h.f.controlStream.key)).rumorId) < bytesToHex(candidate.rumorId)) === (scenario !== "old_rumor_first")) break;
    }
    const siblingEdition = parseEdition(openWrap(sibling, h.f.controlStream.key));
    expect(bytesToHex(siblingEdition.rumorId) < bytesToHex(candidate.rumorId)).toBe(scenario !== "old_rumor_first");
    h.published.push(sibling);
    const request = { decisionId: first.decisionId, expectedVersion: 0, eventId: old.id, operation: "prove" as const, reason: "Synthetic owner supersession" };
    const recover = () => recoverPublication({ sql, decisions: h.outbox, cipher, actions: h.actions, relay: h.relay as never, actor: { ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] }, request });
    await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${first.decisionId}`; });
    await h.outbox.expire();
    expect((await concordRow(first.decisionId)).signed_events).toBeNull();
    // Equal-version dominance alone does not release the fence.
    await expect(recover()).rejects.toThrow(/supersession/);
    const advancing = await ownerEvent(candidate.version + 1n, siblingEdition.selfHash);
    h.published.push(advancing);
    if (scenario === "different_content") {
      const withOld = controlState(refreshPolicy({ ...h.f.policy, controlEvents: [...h.f.policy.controlEvents, ...h.published, old] }));
      const floor = new Map(withOld.folded.heads);
      floor.set(bytesToHex(candidate.entityId), { version: candidate.version, hash: candidate.selfHash });
      expect(foldControlState(withOld.editions, h.f.community.id, h.f.community.owner, floor).incomplete.length).toBeGreaterThan(0);
      await expect(recover()).rejects.toThrow(/supersession/);
      expect((await sql`SELECT recovery_id FROM moderation.publication_recoveries WHERE decision_id = ${first.decisionId}`).length).toBe(0);
      return;
    }
    expect(bytesToHex(siblingEdition.selfHash)).toBe(bytesToHex(candidate.selfHash));
    if (supersededUnban) {
      // The controller is stopped, but a crashed relay claim can still carry
      // a lease. Neither half of completion may retire that active claim.
      await sql`UPDATE moderation.deliveries SET lease_until = clock_timestamp() + interval '1 minute' WHERE decision_id = ${first.decisionId} AND target = 'divine_relay'`;
      await expect(recover()).rejects.toThrow(/relay delivery lease/);
      expect(await concordRow(first.decisionId)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator" });
      expect((await sql`SELECT state FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'divine_relay'`)[0].state).toBe("failed");
      // Synthetic lease passage. A real operator waits for the owned lease.
      await sql`UPDATE moderation.deliveries SET lease_until = NULL, token = NULL WHERE decision_id = ${first.decisionId}`;
      request.expectedVersion++;
    }
    const result = await recover();
    expect(result).toMatchObject({ state: "not_applicable", code: "concord_operator_superseded" });
    if (supersededUnban) {
      expect((await sql`SELECT state, result_code, attempts FROM moderation.deliveries WHERE decision_id = ${first.decisionId} AND target = 'divine_relay'`)[0])
        .toEqual({ state: "not_applicable", result_code: "concord_operator_superseded", attempts: 0 });
      expect((await new PolicyStore(sql).getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(true);
      const api = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        await api`SET ROLE moderation_api`;
        const reader = new Decisions(api, cipher, new Map([[h.f.community.idHex, h.staff.orgId]]));
        expect((await reader.get(first.decisionId, h.staff)).relayRestriction).toEqual({ state: "present", code: "fresh_ordered_unban_required" });
        await expect(reader.get(first.decisionId, { ...h.staff, orgId: crypto.randomUUID() })).rejects.toThrow();
        await expect(api`UPDATE moderation.member_bans SET blocked = false WHERE community_id = ${h.f.community.idHex}`.execute()).rejects.toThrow(/permission denied/);
      } finally { await api.end(); }
    }
    const next = await otherCommunityMember(h);
    await h.drain();
    expect((await concordRow(next.decisionId)).state).toBe("verified");
    h.published.push(old);
    const state = controlState(refreshPolicy({ ...h.f.policy, controlEvents: [...h.f.policy.controlEvents, ...h.published] }));
    expect(state.folded.incomplete).toEqual([]);
    expect(state.folded.banned.has(h.f.bannedMember.pk)).toBe(false);
    const latest = state.folded.heads.get(bytesToHex(candidate.entityId))!;
    expect(latest.version).toBe(candidate.version + 2n);
    const floor = new Map(state.folded.heads);
    floor.set(bytesToHex(candidate.entityId), { version: candidate.version, hash: candidate.selfHash });
    const tracked = foldControlState(state.editions, h.f.community.id, h.f.community.owner, floor);
    expect(tracked.incomplete).toEqual([]);
    if (supersededUnban) {
      const fresh = await h.accept("unban_member");
      expect((await h.outbox.get(first.decisionId, h.staff)).relayRestriction).toEqual({ state: "present", code: "relay_override_present" });
      await h.drain();
      await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${fresh.decisionId} AND target = 'divine_relay'`;
      const relay = (await h.outbox.claim())!, store = new PolicyStore(sql);
      const context = createExecutionContext({ sql, store, actions: h.actions, claim: relay, assertCurrent: () => h.outbox.renew(relay), decisions: h.outbox,
        relay: h.relay as never, discord: {} as never, purger: {} as never, driver: { barrier: work => work() } });
      expect(await executeDelivery(relay.decision, relay.target, context)).toMatchObject({ state: "verified" });
      expect((await h.outbox.get(first.decisionId, h.staff)).relayRestriction).toEqual({ state: "absent", code: "relay_override_absent" });
    }
    expect(tracked.banned.has(h.f.bannedMember.pk)).toBe(false);
  } finally { await h.cleanup(); }
});

test("recovery refuses missing IDs, losing same-version editions, and concurrent controllers", async () => {
  const h = await memberHarness("member");
  try {
    const first = await h.accept("ban_member");
    let old!: NostrEvent;
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { old = event; throw Error("outage"); } });
    const candidate = parseEdition(openWrap(old, h.f.controlStream.key));
    const actor = { ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] };
    const request = { decisionId: first.decisionId, expectedVersion: 0, eventId: old.id, operation: "replay" as const, reason: "Synthetic repair" };
    const run = (relay = h.relay) => recoverPublication({ sql, decisions: h.outbox, cipher, actions: h.actions, relay: relay as never, actor, request });
    await sql`UPDATE moderation.deliveries SET publication_event_ids = NULL WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await expect(run()).rejects.toThrow(/identity/);
    await sql`UPDATE moderation.deliveries SET publication_event_ids = ARRAY[${old.id}] WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    const sibling = await sealEdition(buildBanlistEdition(h.f.community.id, [h.f.bannedMember.pk], { actorPubkey: h.f.owner.pk, version: candidate.version, prevHash: candidate.prevHash }), currentControlWriteGroup(h.f.community), h.f.owner.signer);
    h.published.push(sibling);
    await expect(run()).rejects.toThrow();
    h.published.length = 0;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const recovery = run({ ...h.relay, publish: async event => { entered(); await wait; await h.relay.publish(event); } });
    await started;
    try { await expect(run()).rejects.toThrow(/Stop community worker/); }
    finally { release(); }
    expect(await recovery).toMatchObject({ state: "verified" });
    expect((await sql`SELECT recovery_id FROM moderation.publication_recoveries WHERE decision_id = ${first.decisionId}`).length).toBe(1);
  } finally { await h.cleanup(); }
});

test("operator exact replay refreshes expired persisted admission and the next member unban crosses real relay admission", async () => {
  const h = await memberHarness("member"), store = new PolicyStore(sql);
  const capacity = { communities: new Map([[h.f.community.idHex, h.staff.orgId]]), contract: recoveryContract };
  const observer = new PublicCapacityStore(sql, recoveryContract);
  const validator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_validator" }, onnotice() {} });
  const operatorSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
  const operatorStore = new PolicyStore(operatorSql), operatorDecisions = new Decisions(operatorSql, cipher, capacity.communities);
  const guarded = new PolicyStore(validator, { capacity });
  try {
    const first = await h.accept("ban_member");
    let original!: NostrEvent;
    for (let i = 0; i < 8; i++) {
      await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { original = event; throw Error("outage"); } });
      await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    }
    const next = await otherCommunityMember(h);
    await observer.observeCurrent(h.staff.orgId, h.f.community.idHex);
    await sql`UPDATE moderation.public_capacity_state SET state = 'unknown' WHERE community_id = ${h.f.community.idHex}`;
    expect((await guarded.admit(original)).action).toBe("reject");
    await observer.pause({ orgId: h.staff.orgId, communityId: h.f.community.idHex, reasonCode: "synthetic_pause" });
    await sql`UPDATE moderation.public_capacity_state SET observed_at = clock_timestamp() - interval '1 day' WHERE community_id = ${h.f.community.idHex}`;
    expect((await guarded.admit(original)).action).toBe("reject");
    await store.invalidate(h.f.community.idHex);
    expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
    const admissions: string[] = [];
    const relay = {
      queryStrict: async (filters: { ids?: string[] }[]) => filters[0].ids ? h.published.filter(event => filters[0].ids!.includes(event.id)) : [...h.f.policy.controlEvents, ...h.published],
      publish: async (event: NostrEvent) => {
        const result = await guarded.admit(event);
        admissions.push(result.action);
        if (result.action !== "accept") throw Error("Local relay admission rejected");
        await h.relay.publish(event);
      },
    };
    const actions = createPublicationRecoveryActions({ sql: operatorSql, community: h.f.community, identity: h.f.moderator, store: operatorStore, relay: relay as never, operation: "replay", capacity });
    const result = await recoverPublication({ sql: operatorSql, decisions: operatorDecisions, cipher, actions, relay: relay as never,
      actor: { ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] },
      request: { decisionId: first.decisionId, expectedVersion: 0, eventId: original.id, operation: "replay", reason: "Synthetic relay restored after policy expiry" } });
    expect(result).toMatchObject({ state: "verified", code: "concord_enforcement_verified" });
    expect((await concordRow(first.decisionId)).attempts).toBe(8);
    expect(h.published[0].id).toBe(original.id);
    for (let claim; (claim = await h.outbox.claim());) await h.deliver(claim, relay as never);
    expect((await concordRow(next.decisionId)).state).toBe("verified");
    expect(admissions).toEqual(["accept", "accept"]);
    expect(controlState((await store.getPolicy(h.f.community.idHex))!).folded.banned.has(h.f.bannedMember.pk)).toBe(false);
    expect((await sql`SELECT state, contract_hash FROM moderation.public_capacity_state WHERE community_id = ${h.f.community.idHex}`)[0]).toMatchObject({ state: "paused", contract_hash: observer.contractHash });
    // Proof-only maintenance must not perform that admission/capacity refresh.
    const later = await h.accept("ban_member"); let lost!: NostrEvent;
    await h.deliver((await h.outbox.claim())!, { ...relay, publish: async event => { lost = event; await relay.publish(event); throw Error("lost acknowledgment"); } });
    await store.invalidate(h.f.community.idHex);
    await sql`UPDATE moderation.public_capacity_state SET observed_at = clock_timestamp() - interval '1 day' WHERE community_id = ${h.f.community.idHex}`;
    const [beforeProof] = await sql`SELECT * FROM moderation.public_capacity_state WHERE community_id = ${h.f.community.idHex}`;
    expect(await recoverPublication({ sql: operatorSql, decisions: operatorDecisions, cipher, relay: relay as never,
      actions: createPublicationRecoveryActions({ sql: operatorSql, community: h.f.community, identity: h.f.moderator, store: operatorStore, relay: relay as never, operation: "prove", capacity }), actor: recoveryStaff(h),
      request: { decisionId: later.decisionId, expectedVersion: 0, eventId: lost.id, operation: "prove", reason: "Synthetic read-only proof" } })).toMatchObject({ state: "not_applicable", code: "concord_publication_settled" });
    expect((await sql`SELECT * FROM moderation.public_capacity_state WHERE community_id = ${h.f.community.idHex}`)[0]).toEqual(beforeProof);
    expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
  } finally { await validator.end(); await operatorSql.end(); await h.cleanup(); }
});

test("replay without a reviewed capacity contract cannot refresh admission", async () => {
  const h = await memberHarness("member"), store = new PolicyStore(sql); let reads = 0;
  try {
    const { decision } = await lostGeneration(h); await store.invalidate(h.f.community.idHex);
    const actions = createPublicationRecoveryActions({ sql, community: h.f.community, identity: h.f.moderator, store,
      relay: { queryStrict: async () => { reads++; return h.f.policy.controlEvents; } }, operation: "replay",
      capacity: { communities: new Map([[h.f.community.idHex, h.staff.orgId]]), contract: undefined } });
    await expect(actions.authorize(decision)).rejects.toThrow(/Reviewed capacity contract required/);
    expect(reads).toBe(0); expect(h.published).toHaveLength(0);
    expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
  } finally { await h.cleanup(); }
});

for (const missingId of [false, true]) test(`excluded ${missingId ? "missing-ID" : "ID-only"} history prevents another member's replay from installing admission`, async () => {
  const h = await memberHarness("member"), store = new PolicyStore(sql);
  try {
    const first = await h.accept("ban_member");
    let original!: NostrEvent;
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { original = event; throw Error("outage"); } });
    const excluded = await otherCommunityMember(h);
    await sql`UPDATE moderation.deliveries SET state = 'failed', publication_attempted = true, signed_events = NULL, publication_metadata = NULL,
      publication_event_ids = ${missingId ? null : ["b".repeat(64)]}, result_code = 'concord_recovery_requires_operator' WHERE decision_id = ${excluded.decisionId} AND target = 'concord'`;
    await store.invalidate(h.f.community.idHex);
    let reads = 0;
    const relay = { ...h.relay, queryStrict: async () => { reads++; return h.f.policy.controlEvents; } };
    const actions = createPublicationRecoveryActions({ sql, community: h.f.community, identity: h.f.moderator, store, relay: relay as never, operation: "replay", capacity: { communities: new Map([[h.f.community.idHex, h.staff.orgId]]), contract: recoveryContract } });
    await expect(recoverPublication({ sql, decisions: h.outbox, cipher, actions, relay: relay as never,
      actor: { ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] },
      request: { decisionId: first.decisionId, expectedVersion: 0, eventId: original.id, operation: "replay", reason: "Synthetic excluded community" } })).rejects.toThrow(/pilot_publication_provenance_required/);
    expect(reads).toBe(0);
    expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
    expect((await sql`SELECT recovery_id FROM moderation.publication_recoveries WHERE decision_id = ${first.decisionId}`).length).toBe(0);
  } finally { await h.cleanup(); }
});

test("read-only proof can settle authentic original legacy provenance without enabling admission", async () => {
  const h = await memberHarness("member"), store = new PolicyStore(sql);
  try {
    const first = await h.accept("ban_member");
    let original!: NostrEvent;
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { original = event; await h.relay.publish(event); throw Error("acknowledgment lost"); } });
    await sql`UPDATE moderation.deliveries SET state = 'failed', signed_events = NULL, publication_metadata = NULL, result_code = 'concord_recovery_requires_operator' WHERE decision_id = ${first.decisionId} AND target = 'concord'`;
    await store.invalidate(h.f.community.idHex);
    await expect(assertPilotPublicationProvenance(sql, h.f.community.idHex)).rejects.toThrow(/pilot_publication_provenance_required/);
    const relay = { ...h.relay, queryStrict: async (filters: { ids?: string[] }[]) => {
      expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
      return filters[0].ids ? [] : [...h.f.policy.controlEvents, ...h.published];
    } };
    const actions = createPublicationRecoveryActions({ sql, community: h.f.community, identity: h.f.moderator, store, relay: relay as never, operation: "prove" });
    const result = await recoverPublication({ sql, decisions: h.outbox, cipher, actions, relay: relay as never,
      actor: { ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] },
      request: { decisionId: first.decisionId, expectedVersion: 0, eventId: original.id, originalEvent: original, operation: "prove", reason: "Synthetic original provenance recovered" } });
    expect(result).toMatchObject({ state: "not_applicable", code: "concord_publication_settled" });
    expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
    await assertPilotPublicationProvenance(sql, h.f.community.idHex);
  } finally { await h.cleanup(); }
});

test("read-only recovery authority includes durable pending rekeys and moderator relay bans", async () => {
  const h = await memberHarness("member"), store = new PolicyStore(sql);
  try {
    const first = await h.accept("ban_member");
    let original!: NostrEvent;
    await h.deliver((await h.outbox.claim())!, { ...h.relay, publish: async event => { original = event; await h.relay.publish(event); throw Error("lost acknowledgment"); } });
    const relay = { ...h.relay, queryStrict: async (filters: { ids?: string[] }[]) => filters[0].ids ? h.published.filter(event => filters[0].ids!.includes(event.id)) : [...h.f.policy.controlEvents, ...h.published] };
    const prove = () => recoverPublication({ sql, decisions: h.outbox, cipher, relay: relay as never,
      actions: createPublicationRecoveryActions({ sql, community: h.f.community, identity: h.f.moderator, store, relay: relay as never, operation: "prove" }),
      actor: { ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] },
      request: { decisionId: first.decisionId, expectedVersion: 0, eventId: original.id, operation: "prove", reason: "Synthetic receipt" } });
    await store.invalidate(h.f.community.idHex);
    await sql`INSERT INTO moderation.rekey_events (event_id, community_id, epoch, event) VALUES (${"e".repeat(64)}, ${h.f.community.idHex}, ${(h.f.community.rootEpoch + 1n).toString()}, ${sql.json({})})`;
    expect((await store.getPolicy(h.f.community.idHex))!.rekeyPending).toBe(true);
    await expect(prove()).rejects.toThrow(/Current room authority unavailable/);
    await sql`DELETE FROM moderation.rekey_events WHERE community_id = ${h.f.community.idHex}`;
    await store.setBan(h.f.community.idHex, h.f.moderator.pk, true);
    await expect(prove()).rejects.toThrow(/Current room authority unavailable/);
    await store.setBan(h.f.community.idHex, h.f.moderator.pk, false);
    expect((await sql`SELECT recovery_id FROM moderation.publication_recoveries WHERE decision_id = ${first.decisionId}`).length).toBe(0);
    expect(await prove()).toMatchObject({ state: "not_applicable", code: "concord_publication_settled" });
    expect(await store.getPolicy(h.f.community.idHex)).toMatchObject({ complete: false, validUntil: 0 });
  } finally {
    await sql`DELETE FROM moderation.rekey_events WHERE community_id = ${h.f.community.idHex}`;
    await sql`DELETE FROM moderation.member_bans WHERE community_id = ${h.f.community.idHex} AND author = ${h.f.moderator.pk}`;
    await h.cleanup();
  }
});

type RecoveryHarness = Awaited<ReturnType<typeof memberHarness>>;
const recoveryStaff = (h: RecoveryHarness) => ({ ...h.staff, permissions: [...h.staff.permissions, "recover_publication"] });
const recoveryPolicy = async (h: RecoveryHarness) => {
  const policy = (await new PolicyStore(sql).getPolicy(h.f.community.idHex))!;
  return refreshPolicy({ ...policy, controlEvents: [...policy.controlEvents, ...h.published] });
};
async function lostGeneration(h: RecoveryHarness, prefix?: string) {
  await h.accept("ban_member");
  const claim = (await h.outbox.claim())!;
  if (prefix) {
    const prepared = parseEdition(openWrap((await h.actions.prepare(claim.decision))[0], h.f.controlStream.key));
    let timestamp = Math.floor(Date.now() / 1000), rumor;
    do { rumor = buildBanlistEdition(h.f.community.id, JSON.parse(prepared.content), { actorPubkey: h.f.moderator.pk, version: prepared.version, prevHash: prepared.prevHash, authority: prepared.authority, createdAtSecs: timestamp-- }); } while (!rumor.id.startsWith(prefix));
    await h.outbox.saveEvents(claim, [await sealEdition(rumor, currentControlWriteGroup(h.f.community), h.f.moderator.signer)]);
  }
  let old!: NostrEvent;
  await h.deliver(claim, { ...h.relay, publish: async event => { old = event; throw Error("synthetic outage"); } });
  return { decision: claim.decision, old, edition: parseEdition(openWrap(old, h.f.controlStream.key)) };
}
async function expireGeneration(h: RecoveryHarness, id: string) {
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${id}`; });
  await h.outbox.expire(); expect((await concordRow(id)).signed_events).toBeNull();
}
async function endorseGeneration(h: RecoveryHarness, edition: ReturnType<typeof parseEdition>, by: { pk: string; signer: Parameters<typeof sealEdition>[2] } = h.f.owner, authority?: Parameters<typeof buildBanlistEdition>[2]["authority"]) {
  return sealEdition(buildBanlistEdition(h.f.community.id, JSON.parse(edition.content), { actorPubkey: by.pk, version: edition.version, prevHash: edition.prevHash, authority }), currentControlWriteGroup(h.f.community), by.signer);
}
async function advanceOwner(h: RecoveryHarness) {
  const { folded } = controlState(await recoveryPolicy(h)), head = folded.heads.get(bytesToHex(banlistLocator(h.f.community.id)))!;
  return sealEdition(buildBanlistEdition(h.f.community.id, [...folded.banned].sort(), { actorPubkey: h.f.owner.pk, version: head.version + 1n, prevHash: head.hash }), currentControlWriteGroup(h.f.community), h.f.owner.signer);
}
const proveGeneration = (h: RecoveryHarness, decisionId: string, eventId: string) => recoverPublication({ sql, decisions: h.outbox, cipher, actions: h.actions, relay: h.relay as never, actor: recoveryStaff(h),
  request: { decisionId, expectedVersion: 0, eventId, operation: "prove", reason: "Synthetic owner proof" } });

for (const missingOwner of ["sibling", "head"] as const) test(`owner proof refuses a non-owner ${missingOwner} despite exact content identity`, async () => {
  const h = await memberHarness("member");
  try {
    const { decision, old, edition } = await lostGeneration(h); await expireGeneration(h, decision.decisionId);
    if (missingOwner === "sibling") {
      const other = localIdentity(generateSecretKey());
      h.published.push(await sealEdition(buildGrantEdition(h.f.community.id, { member: other.pk, roleIds: [h.f.roleId] }, { actorPubkey: h.f.owner.pk, version: 1n }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
      const { authority } = await new ConcordActions(h.f.community, other, () => recoveryPolicy(h)).authorize(decision);
      h.published.push(await endorseGeneration(h, edition, other, authority));
      h.published.push(await advanceOwner(h));
    } else {
      h.published.push(await endorseGeneration(h, edition));
      h.published.push(...await h.actions.prepare({ ...decision, decisionId: crypto.randomUUID(), author: "ab".repeat(32) }));
    }
    await expect(proveGeneration(h, decision.decisionId, old.id)).rejects.toThrow(/supersession proof required/);
    expect((await sql`SELECT recovery_id FROM moderation.publication_recoveries WHERE decision_id = ${decision.decisionId}`).length).toBe(0);
  } finally { await h.cleanup(); }
});
test("owner proof is rechecked if a later moderator edition arrives during recovery", async () => {
  const h = await memberHarness("member");
  try {
    const { decision, old, edition } = await lostGeneration(h); await expireGeneration(h, decision.decisionId);
    h.published.push(await endorseGeneration(h, edition)); h.published.push(await advanceOwner(h));
    const later = await h.actions.prepare({ ...decision, decisionId: crypto.randomUUID(), author: "ab".repeat(32) });
    const proof = h.actions.ownerSupersession.bind(h.actions);
    h.actions.ownerSupersession = async (...args) => { const valid = await proof(...args); if (!h.published.includes(later[0])) h.published.push(...later); return valid; };
    await expect(proveGeneration(h, decision.decisionId, old.id)).rejects.toThrow(/Supersession proof changed/);
    expect((await concordRow(decision.decisionId)).state).not.toBe("not_applicable");
  } finally { await h.cleanup(); }
});

async function replayGeneration(h: RecoveryHarness, onRefresh: () => Promise<void> = async () => {}) {
  const { decision, old } = await lostGeneration(h);
  const actions = new ConcordActions(h.f.community, h.f.moderator, async () => { await onRefresh(); return recoveryPolicy(h); });
  const replay = (expectedVersion: number, relay = h.relay, actor = recoveryStaff(h)) => recoverPublication({ sql, decisions: h.outbox, cipher, actions, relay: relay as never, actor,
    request: { decisionId: decision.decisionId, expectedVersion, eventId: old.id, operation: "replay", reason: "Synthetic restored relay" } });
  const recoveries = () => sql`SELECT recovery_id FROM moderation.publication_recoveries WHERE decision_id = ${decision.decisionId}`;
  return { decision, replay, recoveries };
}
test("each controller and execution lock independently refuses recovery", async () => {
  const h = await memberHarness("member");
  try {
    const { replay, recoveries } = await replayGeneration(h);
    for (const ns of [483218, 483215]) await sql.begin(async held => {
      await held`SELECT pg_advisory_xact_lock(hashtextextended(${h.f.community.idHex}, ${ns}))`;
      await expect(replay(0)).rejects.toThrow(/Stop community worker/);
    });
    expect(await recoveries()).toHaveLength(0); expect(h.published).toHaveLength(0);
    expect(await replay(0)).toMatchObject({ state: "verified" });
  } finally { await h.cleanup(); }
});
test("stale recovery versions fail before authority refresh even after a failed replay", async () => {
  const h = await memberHarness("member"); let refreshes = 0;
  try {
    const { replay } = await replayGeneration(h, async () => { refreshes++; });
    expect(await replay(0, { ...h.relay, publish: async () => { throw Error("still unavailable"); } })).toMatchObject({ state: "failed" });
    refreshes = 0; await expect(replay(0)).rejects.toThrow(/^Stale recovery or original publication identity unavailable$/);
    expect(refreshes).toBe(0); expect(h.published).toHaveLength(0);
    expect(await replay(1)).toMatchObject({ state: "verified" });
  } finally { await h.cleanup(); }
});
test("recovery CAS refuses a version changed after the initial check", async () => {
  const h = await memberHarness("member"); let id = "", moved = false;
  try {
    const { decision, replay, recoveries } = await replayGeneration(h, async () => {
      if (moved || !id) return; moved = true;
      await sql`UPDATE moderation.deliveries SET recovery_version = recovery_version + 1 WHERE decision_id = ${id} AND target = 'concord'`;
    });
    id = decision.decisionId; await expect(replay(0)).rejects.toThrow(/^Stale recovery$/);
    expect(moved).toBe(true); expect(await recoveries()).toHaveLength(0); expect(h.published).toHaveLength(0);
  } finally { await h.cleanup(); }
});
test("recovery requires the decision's action in addition to operator capability", async () => {
  const h = await memberHarness("member");
  try {
    const { replay, recoveries } = await replayGeneration(h);
    await expect(replay(0, h.relay, { ...h.staff, permissions: ["view", "recover_publication", "unban_member"] })).rejects.toThrow(/Recovery scope unavailable/);
    expect(await recoveries()).toHaveLength(0); expect(h.published).toHaveLength(0);
  } finally { await h.cleanup(); }
});

test("blocker status exposes the replay deadline and expiry without reviving intent", async () => {
  const h = await memberHarness("member");
  try {
    const { decision } = await lostGeneration(h);
    const [row] = await sql`SELECT expires_at FROM moderation.decisions WHERE decision_id = ${decision.decisionId}`;
    expect(await publicationBlockers(sql, h.f.community.idHex)).toContainEqual(expect.objectContaining({ decisionId: decision.decisionId, executionExpiresAt: row.expires_at.toISOString(), executionWindowExpired: false }));
    await expireGeneration(h, decision.decisionId);
    expect(await publicationBlockers(sql, h.f.community.idHex)).toContainEqual(expect.objectContaining({ decisionId: decision.decisionId, executionWindowExpired: true }));
    expect((await concordRow(decision.decisionId)).signed_events).toBeNull();
  } finally { await h.cleanup(); }
});

test("a recovery interrupted after its audit never reopens an operator-gated send", async () => {
  const h = await memberHarness("member");
  const renew = h.outbox.renew.bind(h.outbox);
  try {
    const { decision, old } = await lostGeneration(h);
    await sql`UPDATE moderation.deliveries SET state = 'failed', result_code = 'concord_recovery_requires_operator' WHERE decision_id = ${decision.decisionId} AND target = 'concord'`;
    h.outbox.renew = async () => { throw Error("synthetic post-audit ownership loss"); };
    await expect(recoverPublication({ sql, decisions: h.outbox, cipher, actions: h.actions, relay: h.relay as never, actor: recoveryStaff(h),
      request: { decisionId: decision.decisionId, expectedVersion: 0, eventId: old.id, operation: "replay", reason: "Synthetic interrupted recovery" } })).rejects.toThrow(/ownership loss/);
    expect(await concordRow(decision.decisionId)).toMatchObject({ state: "failed", attempts: 1, result_code: "concord_recovery_requires_operator" });
    expect((await sql`SELECT recovery_version FROM moderation.deliveries WHERE decision_id = ${decision.decisionId} AND target = 'concord'`)[0].recovery_version).toBe(1);
    expect(h.published).toHaveLength(0);
    // Model passage of this test's own lease, not a production reset.
    await sql`UPDATE moderation.deliveries SET token = NULL, lease_until = NULL WHERE decision_id = ${decision.decisionId} AND target = 'concord'`;
    expect(await h.outbox.claim()).toBeUndefined();
    await expect(h.outbox.retry(decision.decisionId, h.staff)).rejects.toThrow();
  } finally { h.outbox.renew = renew; await h.cleanup(); }
});

test("an abandoned pre-fix pending operator marker is quarantined before claim selection", async () => {
  const h = await memberHarness("member");
  try {
    const { decision } = await lostGeneration(h);
    await sql`UPDATE moderation.deliveries SET state = 'pending', result_code = 'concord_recovery_requires_operator', available_at = clock_timestamp(), token = NULL, lease_until = NULL WHERE decision_id = ${decision.decisionId} AND target = 'concord'`;
    const before = (await sql`SELECT publication_event_ids, publication_metadata FROM moderation.deliveries WHERE decision_id = ${decision.decisionId} AND target = 'concord'`)[0];
    expect(await h.outbox.claim()).toBeUndefined();
    expect(await concordRow(decision.decisionId)).toMatchObject({ state: "failed", attempts: 1, result_code: "concord_recovery_requires_operator" });
    expect((await sql`SELECT publication_event_ids, publication_metadata FROM moderation.deliveries WHERE decision_id = ${decision.decisionId} AND target = 'concord'`)[0]).toEqual(before);
  } finally { await h.cleanup(); }
});

for (const provenance of ["retained", "supplied", "relay"] as const) test(`owner endorsement is supersession, not applied receipt, with ${provenance} original bytes`, async () => {
  const h = await memberHarness("member");
  try {
    const { decision, old, edition } = await lostGeneration(h);
    h.published.push(await endorseGeneration(h, edition)); h.published.push(await advanceOwner(h));
    if (provenance !== "retained") await expireGeneration(h, decision.decisionId);
    if (provenance === "relay") h.published.push(old);
    expect(await h.actions.publicationInCurrentHistory(decision, [old])).toBe(false);
    const result = await recoverPublication({ sql, decisions: h.outbox, cipher, actions: h.actions, relay: h.relay as never, actor: recoveryStaff(h),
      request: { decisionId: decision.decisionId, expectedVersion: 0, eventId: old.id, operation: "prove", reason: "Synthetic publisher distinction", ...(provenance === "supplied" ? { originalEvent: old } : {}) } });
    expect(result).toMatchObject({ state: "not_applicable", code: "concord_operator_superseded" });
    await expect(h.outbox.getReversalContext(decision.decisionId, h.staff)).rejects.toThrow(/unavailable/);
  } finally { await h.cleanup(); }
});
test("background receipt readback cannot count an owner's same-hash endorsement as the original publication", async () => {
  const h = await memberHarness("member");
  try {
    const { decision, old, edition } = await lostGeneration(h);
    h.published.push(await endorseGeneration(h, edition)); h.published.push(await advanceOwner(h)); h.published.push(old);
    await expireGeneration(h, decision.decisionId);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${decision.decisionId} AND target = 'concord'`;
    const claim = (await h.outbox.claim())!;
    expect(claim.reconcileOnly).toBe(true);
    expect(await h.deliver(claim)).toMatchObject({ state: "failed", code: "concord_recovery_awaiting_proof" });
    expect(await concordRow(decision.decisionId)).toMatchObject({ state: "failed", result_code: "concord_recovery_requires_operator" });
  } finally { await h.cleanup(); }
});

test("normal delivery cannot verify the old publisher after an owner endorses its content", async () => {
  const h = await memberHarness("member");
  try {
    const { decision, edition } = await lostGeneration(h);
    h.published.push(await endorseGeneration(h, edition)); h.published.push(await advanceOwner(h));
    const before = h.published.map(event => event.id);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${decision.decisionId} AND target = 'concord'`;
    const claim = (await h.outbox.claim())!;
    expect(claim.reconcileOnly).toBe(false);
    expect(await h.deliver(claim)).toEqual({ state: "failed", code: "concord_recovery_requires_operator" });
    expect(h.published.map(event => event.id)).toEqual(before);
  } finally { await h.cleanup(); }
});

for (const action of ["ban_member", "unban_member"] as const) test(`a convergent non-owner duplicate settles ${action} without an owner endorsement`, async () => {
  const h = await memberHarness(action === "ban_member" ? "member" : "bannedMember"), store = new PolicyStore(sql);
  try {
    if (action === "unban_member") await store.setBan(h.f.community.idHex, h.who.pk, true);
    const first = await h.accept(action), claim = (await h.outbox.claim())!; let old!: NostrEvent;
    await h.deliver(claim, { ...h.relay, publish: async event => { old = event; throw Error("lost acknowledgment"); } });
    const edition = parseEdition(openWrap(old, h.f.controlStream.key)), other = localIdentity(generateSecretKey());
    h.published.push(await sealEdition(buildGrantEdition(h.f.community.id, { member: other.pk, roleIds: [h.f.roleId] }, { actorPubkey: h.f.owner.pk, version: 1n }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
    const peer = new ConcordActions(h.f.community, other, () => recoveryPolicy(h));
    const { authority } = await peer.authorize(claim.decision);
    h.published.push(await endorseGeneration(h, edition, other, authority), old);
    // A later non-owner head makes the old publisher identity ambiguous while
    // the logical hash and every semantic projection still converge.
    h.published.push(...await peer.prepare({ ...claim.decision, decisionId: crypto.randomUUID(), action: "ban_member", author: "ac".repeat(32) }));
    expect(await h.actions.publicationInCurrentHistory(claim.decision, [old])).toBe(true);
    expect(await proveGeneration(h, first.decisionId, old.id)).toMatchObject({ state: "not_applicable", code: "concord_publication_settled" });
    if (action === "unban_member") {
      await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${first.decisionId} AND target = 'divine_relay'`;
      const relay = (await h.outbox.claim())!; expect(relay.target).toBe("divine_relay");
      const context = createExecutionContext({ sql, store, actions: h.actions, claim: relay, assertCurrent: () => h.outbox.renew(relay), decisions: h.outbox,
        relay: h.relay as never, discord: {} as never, purger: {} as never, driver: { barrier: work => work() } });
      expect(await executeDelivery(relay.decision, relay.target, context)).toEqual({ state: "verified", code: "relay_member_policy_verified" });
      expect((await store.getPolicy(h.f.community.idHex))!.banned.includes(h.who.pk)).toBe(false);
    }
  } finally { await h.cleanup(); }
});

test("non-owner hash equivalence refuses a delayed edition that changes ban-time semantics", async () => {
  const h = await memberHarness("member");
  try {
    const { decision, old, edition } = await lostGeneration(h, "7"), other = localIdentity(generateSecretKey());
    h.published.push(await sealEdition(buildGrantEdition(h.f.community.id, { member: other.pk, roleIds: [h.f.roleId] }, { actorPubkey: h.f.owner.pk, version: 1n }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
    const peer = new ConcordActions(h.f.community, other, () => recoveryPolicy(h));
    const { authority } = await peer.authorize(decision); let sibling!: NostrEvent;
    for (let i = 1; i <= 2000; i++) {
      sibling = await sealEdition(buildBanlistEdition(h.f.community.id, JSON.parse(edition.content), { actorPubkey: other.pk, version: edition.version, prevHash: edition.prevHash, authority, createdAtSecs: edition.createdAt + i }), currentControlWriteGroup(h.f.community), other.signer);
      if (bytesToHex(parseEdition(openWrap(sibling, h.f.controlStream.key)).rumorId) > bytesToHex(edition.rumorId)) break;
    }
    const alternate = parseEdition(openWrap(sibling, h.f.controlStream.key));
    expect(bytesToHex(alternate.rumorId) > bytesToHex(edition.rumorId)).toBe(true);
    h.published.push(sibling);
    const before = controlState(await recoveryPolicy(h)), after = foldControlState([...before.editions, edition], h.f.community.id, h.f.owner.pk);
    expect([...after.banned].sort()).toEqual([...before.folded.banned].sort());
    expect(after.bannedAt.get(decision.author)).not.toBe(before.folded.bannedAt.get(decision.author));
    expect(await h.actions.publicationInCurrentHistory(decision, [old])).toBe(false);
  } finally { await h.cleanup(); }
});

test("recovery registers scoped signable control keys before fetching and channel keys after replay refresh", async () => {
  const h = await memberHarness("member"); let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return new Response("unused test endpoint", { status: 503 }); } });
  const url = `ws://127.0.0.1:${server.port}`, unrelated = "wss://unrelated.example/";
  try {
    const { decision, old } = await lostGeneration(h);
    expect(streamPubkeysForRelay(url)).not.toContain(h.f.controlStream.key.pk);
    expect(streamPubkeysForRelay(url)).not.toContain(h.f.chatStream.key.pk);
    const relay = { ...h.relay, urls: [url], queryStrict: async (filters: { ids?: string[] }[]) => {
      expect(streamPubkeysForRelay(url)).toContain(h.f.controlStream.key.pk);
      const auth = signStreamAuths("synthetic-challenge", url, [h.f.controlStream.key.pk]);
      expect(auth).toHaveLength(1); expect(verifyEvent(auth[0])).toBe(true);
      return filters[0].ids ? h.published.filter(event => filters[0].ids!.includes(event.id)) : [...h.f.policy.controlEvents, ...h.published];
    } };
    const actions = createPublicationRecoveryActions({ sql, community: h.f.community, identity: h.f.moderator, store: new PolicyStore(sql), relay: relay as never, operation: "replay",
      capacity: { communities: new Map([[h.f.community.idHex, h.staff.orgId]]), contract: recoveryContract } });
    expect(streamPubkeysForRelay(unrelated)).not.toContain(h.f.controlStream.key.pk);
    expect(await recoverPublication({ sql, decisions: h.outbox, cipher, actions, relay: relay as never, actor: recoveryStaff(h),
      request: { decisionId: decision.decisionId, expectedVersion: 0, eventId: old.id, operation: "replay", reason: "Synthetic auth setup" } })).toMatchObject({ state: "verified" });
    expect(streamPubkeysForRelay(url)).toContain(h.f.chatStream.key.pk);
    expect(streamPubkeysForRelay(unrelated)).not.toContain(h.f.chatStream.key.pk);
    const chatAuth = signStreamAuths("synthetic-chat-challenge", url, [h.f.chatStream.key.pk]);
    expect(chatAuth).toHaveLength(1); expect(verifyEvent(chatAuth[0])).toBe(true);
    expect(requests).toBe(0);
  } finally { server.stop(true); await h.cleanup(); }
});

for (const proof of ["canonical", "owner"] as const) for (const changed of ["deleted_channel", "promoted_target"] as const) test(`${proof} membership proof survives ${changed}, without granting replay`, async () => {
  const h = await memberHarness("member");
  try {
    const { decision, old } = await lostGeneration(h); h.published.push(old);
    if (proof === "owner") {
      h.published.push(await endorseGeneration(h, parseEdition(openWrap(old, h.f.controlStream.key))));
      h.published.push(await advanceOwner(h));
    }
    if (changed === "deleted_channel") {
      const channel = controlState(await recoveryPolicy(h)).folded.heads.get(h.f.channelId)!;
      h.published.push(await sealEdition(buildChannelEdition(Buffer.from(h.f.channelId, "hex"), { name: "general", private: false, deleted: true }, { actorPubkey: h.f.owner.pk, version: channel.version + 1n, prevHash: channel.hash }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
    } else {
      h.published.push(await sealEdition(buildGrantEdition(h.f.community.id, { member: decision.author, roleIds: [h.f.roleId] }, { actorPubkey: h.f.owner.pk, version: 1n }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
    }
    await expect(h.actions.authorize(decision)).rejects.toThrow(changed === "deleted_channel" ? /Current room authority unavailable/ : /Moderator lacks authority/);
    const result = await proveGeneration(h, decision.decisionId, old.id);
    expect(result).toMatchObject({ state: "not_applicable", code: proof === "owner" ? "concord_operator_superseded" : "concord_publication_settled" });
    expect(h.published.filter(event => event.id === old.id)).toHaveLength(1);
  } finally { await h.cleanup(); }
});
