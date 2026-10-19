import { expect, test } from "bun:test";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { createHash } from "node:crypto";
import { authenticateReport } from "./reports";
const key = generateSecretKey();
function request(body = '{"reason":"spam"}', tags?: string[][], seconds = Math.floor(Date.now() / 1000)) {
  const url = "https://rooms.example/v1/reports";
  const event = finalizeEvent({ kind: 27235, created_at: seconds, tags: tags ?? [["u", url], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")]], content: "" }, key);
  return new Request(url, { method: "POST", body, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` } });
}
test("report authentication binds signer, URL, method, body and time", async () => {
  const valid = request();
  expect((await authenticateReport(valid, await valid.text(), "https://rooms.example")).pubkey).toHaveLength(64);
  for (const invalid of [request("{}", [["u", "https://elsewhere.example/v1/reports"], ["method", "POST"]]), request("{}", [["u", "https://rooms.example/v1/reports"], ["method", "GET"]]), request("{}", undefined, 1)]) {
    await expect(authenticateReport(invalid, await invalid.text(), "https://rooms.example")).rejects.toThrow();
  }
  await expect(authenticateReport(request(), "changed", "https://rooms.example")).rejects.toThrow();
});

import { afterAll, beforeAll } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { refreshPolicy, relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { EvidenceCipher, RelayEvidenceResolver } from "./evidence";
import { Reports } from "./reports";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const f = await relayFixture(), org = crypto.randomUUID();
const target = { communityId: f.policy.communityId, channelId: f.channelId, rumorId: f.allowedRumorId };
const cipher = new EvidenceCipher(randomBytes(32), 3600, 200_000);
const reports = new Reports(sql, cipher, new RelayEvidenceResolver(sql, async () => [f.allowed]), new Map([[f.policy.communityId, org]]), 10);
const reporter = { pubkey: f.member.pk, authEventId: "1".repeat(64) };
beforeAll(async () => { await migrateModeration(sql); const store = new PolicyStore(sql); await store.install(refreshPolicy(f.policy), [f.chatStream, f.controlStream, f.guestbookStream], 0); await store.admit(f.allowed); });
afterAll(async () => { await sql`DELETE FROM moderation.cases WHERE org_id = ${org}`; await sql`DELETE FROM moderation.report_auth WHERE reporter = ${reporter.pubkey}`; await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.policy.communityId}`; await sql.end(); });
test("reports resolve verified message data, reject replay and deduplicate fresh authentication", async () => {
  const first = await reports.submitReport({ target, reason: "synthetic report" }, reporter);
  await expect(reports.submitReport({ target, reason: "synthetic report" }, reporter)).rejects.toThrow(/replayed/);
  const duplicate = await reports.submitReport({ target, reason: "synthetic report" }, { ...reporter, authEventId: "2".repeat(64) });
  expect(duplicate).toEqual(first);
  const [stored] = await sql`SELECT * FROM moderation.cases WHERE case_id = ${first.caseId}`;
  const decoded = cipher.open(`${org}:${first.caseId}`, stored.evidence);
  expect(decoded.evidence.author).toBe(f.member.pk);
  expect(decoded.evidence.carrier.id).toBe(f.allowed.id);
  expect(Buffer.from(stored.evidence).includes(Buffer.from("synthetic report"))).toBe(false);
  await expect(reports.submitReport({ target, reason: "synthetic", author: f.owner.pk } as any, { ...reporter, authEventId: "3".repeat(64) })).rejects.toThrow(/Invalid/);
  await expect(reports.submitReport({ target: { ...target, communityId: "f".repeat(64) }, reason: "synthetic" }, { ...reporter, authEventId: "4".repeat(64) })).rejects.toThrow(/not reportable/);
});
test("forged carrier content never becomes evidence and expired cases are erased", async () => {
  const resolver = new RelayEvidenceResolver(sql, async () => [{ ...f.allowed, content: "forged" }]);
  await expect(resolver.resolve(target)).rejects.toThrow(/unavailable/);
  await sql`UPDATE moderation.cases SET expires_at = clock_timestamp() - interval '1 second' WHERE org_id = ${org}`;
  await reports.expire();
  expect((await sql`SELECT case_id FROM moderation.cases WHERE org_id = ${org}`).length).toBe(0);
  await expect(sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE moderation_validator");
    await tx`SELECT * FROM moderation.cases`;
  })).rejects.toThrow(/permission denied/);
});
test("only authorized same-org staff can read live evidence; carriers and reporter stay internal", async () => {
  const { caseId } = await reports.submitReport({ target, reason: "synthetic staff case" }, { ...reporter, authEventId: "5".repeat(64) });
  const actor = { orgId: org, actorId: "synthetic-staff", permissions: ["view"] };
  const view = await reports.getCase(caseId, actor);
  expect(view.author).toBe(f.member.pk);
  expect(view.reason).toBe("synthetic staff case");
  expect("carrier" in view).toBe(false);
  expect("reporter" in view).toBe(false);
  await expect(reports.getCase(caseId, { ...actor, orgId: "other" })).rejects.toThrow();
  await expect(reports.getCase(caseId, { ...actor, permissions: [] })).rejects.toThrow();
});
test("API database identity can deliver cases but cannot edit relay authority or bans", async () => {
  await sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE moderation_api');
    await tx`SELECT case_id FROM moderation.cases LIMIT 0`;
    await tx`SELECT decision_id FROM moderation.deliveries LIMIT 0`;
  });
  await expect(sql.begin(async (tx) => { await tx.unsafe('SET LOCAL ROLE moderation_api'); await tx`DELETE FROM moderation.member_bans WHERE FALSE`; })).rejects.toThrow(/permission denied/);
  await expect(sql.begin(async (tx) => { await tx.unsafe('SET LOCAL ROLE moderation_api'); await tx`DELETE FROM moderation.community_policy WHERE FALSE`; })).rejects.toThrow(/permission denied/);
});

import { Lifecycle } from "./lifecycle";
test("capacity insertion skips held expiry and never returns an expired held report as fresh evidence", async () => {
  const lifecycle = new Lifecycle(sql, cipher, new Map([[f.policy.communityId, org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
  const reporter = { pubkey: randomBytes(32).toString("hex"), authEventId: randomBytes(32).toString("hex") };
  const first = await reports.submitReport({ target, reason: "synthetic capacity case" }, reporter);
  const held = await lifecycle.placeEvidenceHold({ caseId: first.caseId, reason: "capacity hold", holdUntil: new Date(Date.now() + 60000).toISOString() }, { orgId: org, actorId: "synthetic-admin", permissions: ["manage_moderation_records"] });
  try {
    await sql`UPDATE moderation.cases SET expires_at = clock_timestamp() - interval '1 second' WHERE case_id = ${first.caseId}`;
    await expect(reports.submitReport({ target, reason: "repeat after expiry" }, { ...reporter, authEventId: randomBytes(32).toString("hex") })).rejects.toThrow(/held|expired/i);
    expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${first.caseId}`).length).toBe(1);
    const another = await reports.submitReport({ target, reason: "another synthetic reporter" }, { pubkey: randomBytes(32).toString("hex"), authEventId: randomBytes(32).toString("hex") });
    expect(another.caseId).not.toBe(first.caseId);
  } finally {
    await lifecycle.releaseEvidenceHold({ holdId: held.holdId, reason: "capacity test release" }, { orgId: org, actorId: "synthetic-admin", permissions: ["manage_moderation_records"] });
    await sql`DELETE FROM moderation.report_auth WHERE reporter = ${reporter.pubkey}`;
  }
});
