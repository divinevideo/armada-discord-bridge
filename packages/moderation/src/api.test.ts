import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createModerationApi, signCoopRequest } from "./api";
import { DecisionRefusedError } from "./decisions";
const secret = randomBytes(32);
const actor = { orgId: "synthetic-org", actorId: "synthetic-reviewer", permissions: ["remove_message", "view", "retry"] };
const status = { executionId: crypto.randomUUID(), sourceOrder: null, decisionId: crypto.randomUUID(), target: { communityId: "a".repeat(64), channelId: "b".repeat(64), rumorId: "c".repeat(64) }, action: "remove_message" as const, discordGuildConfirmed: false, supersededBy: null, deliveries: [] };
let accepted = 0;
const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([actor.orgId]), reports: { async submitReport() { throw new Error("not called"); } }, decisions: { async acceptDecision() { accepted++; return status; }, async get() { return status; }, async retry() { return status; } } });
test("staff endpoints require signed actor/org, method and body; acceptance is queued", async () => {
  const url = "http://moderation.internal/v1/decisions", body = "{}";
  expect((await api(new Request(url, { method: "POST", body }))).status).toBe(403);
  const headers = signCoopRequest(secret, actor, "POST", "/v1/decisions", body);
  expect((await api(new Request(url, { method: "POST", body, headers }))).status).toBe(202);
  expect(accepted).toBe(1);
  expect((await api(new Request(url, { method: "POST", body: '{"altered":true}', headers }))).status).toBe(403);
  expect((await api(new Request(url, { method: "POST", body, headers: signCoopRequest(secret, { ...actor, orgId: "other" }, "POST", "/v1/decisions", body) }))).status).toBe(403);
  expect((await api(new Request(url, { method: "POST", body, headers: signCoopRequest(secret, actor, "POST", "/v1/decisions", body, 1) }))).status).toBe(403);
  expect(accepted).toBe(1);
});
test("oversized and unknown requests are bounded before authentication", async () => {
  expect((await api(new Request("http://moderation.internal/v1/reports", { method: "POST", body: "x".repeat(65_537) }))).status).toBe(413);
  expect((await api(new Request("http://moderation.internal/admin/purge", { method: "POST" }))).status).toBe(404);
});

test("only approved web origins can preflight the public report endpoint", async () => {
  const corsApi = createModerationApi({ publicOrigin: "https://rooms.example", allowedReportOrigins: new Set(["https://divine.example"]), coopSecret: secret, orgs: new Set([actor.orgId]), reports: { async submitReport() { return { caseId: crypto.randomUUID() }; } }, decisions: { async acceptDecision() { return status; }, async get() { return status; }, async retry() { return status; } } });
  const preflight = await corsApi(new Request("https://rooms.example/v1/reports", { method: "OPTIONS", headers: { origin: "https://divine.example", "access-control-request-method": "POST" } }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://divine.example");
  expect((await corsApi(new Request("https://rooms.example/v1/reports", { method: "OPTIONS", headers: { origin: "https://untrusted.example" } }))).status).toBe(403);
  const staff = await corsApi(new Request("https://rooms.example/v1/decisions", { method: "OPTIONS", headers: { origin: "https://divine.example" } }));
  expect(staff.headers.get("access-control-allow-origin")).toBeNull();
});

test("case evidence and delivery status require the signed staff route", async () => {
  const caseId = crypto.randomUUID(), path = `/v1/cases/${caseId}`;
  let viewed = 0;
  const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([actor.orgId]), reports: { async submitReport() { throw new Error(); }, async getCase(id, staff) { expect(id).toBe(caseId); expect(staff.actorId).toBe(actor.actorId); viewed++; return { caseId, target: status.target, author: "d".repeat(64), content: "synthetic evidence", reason: "synthetic report", createdAt: 1, expiresAt: new Date().toISOString() }; } }, decisions: { async acceptDecision() { return status; }, async get() { return status; }, async retry() { return status; }, async forCase() { return [status]; } } });
  expect((await api(new Request("https://rooms.example" + path))).status).toBe(403);
  expect(viewed).toBe(0);
  const response = await api(new Request("https://rooms.example" + path, { headers: signCoopRequest(secret, actor, "GET", path, "") }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ caseId, content: "synthetic evidence", decisions: [status] });
});

test("anonymous reports and forged staff signatures cannot exhaust valid staff capacity", async () => {
  let calls = 0;
  const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([actor.orgId]), reports: { async submitReport() { throw new Error("unauthenticated report reached storage"); } }, decisions: { async acceptDecision() { calls++; return status; }, async get() { return status; }, async retry() { return status; } } });
  const url = "https://rooms.example/v1/decisions", body = "{}";
  const forged = signCoopRequest(randomBytes(32), actor, "POST", "/v1/decisions", body);
  const results = await Promise.all(Array.from({ length: 101 }, async () => [
    (await api(new Request("https://rooms.example/v1/reports", { method: "POST", body }))).status,
    (await api(new Request(url, { method: "POST", body, headers: forged }))).status,
  ]));
  expect(results.some(([report]) => report === 429)).toBe(true);
  expect(results.every(([, staff]) => staff === 403)).toBe(true);
  expect(calls).toBe(0);
  const signed = () => new Request(url, { method: "POST", body, headers: signCoopRequest(secret, actor, "POST", "/v1/decisions", body) });
  const valid = await Promise.all(Array.from({ length: 101 }, () => api(signed())));
  expect(valid.filter((response) => response.status === 202)).toHaveLength(100);
  expect(valid.filter((response) => response.status === 429)).toHaveLength(1);
  expect(calls).toBe(100);
});

test("pre-auth body reads cancel slow streams and enforce the byte cap without waiting for cancel hooks", async () => {
  const makeApi = () => createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([actor.orgId]), reports: { async submitReport() { throw new Error("not called"); } }, decisions: { async acceptDecision() { throw new Error("not called"); }, async get() { return status; }, async retry() { return status; } } });
  for (const path of ["/v1/reports", "/v1/decisions"]) {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([123])); }, cancel() { canceled = true; return new Promise(() => {}); } });
    const request = new Request("https://rooms.example" + path, { method: "POST", body: stream });
    expect((await makeApi()(request)).status).toBe(413);
    expect(canceled).toBe(true);
  }
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65_537)); }, cancel() { canceled = true; return new Promise(() => {}); } });
  expect((await makeApi()(new Request("https://rooms.example/v1/decisions", { method: "POST", body: stream }))).status).toBe(413);
  expect(canceled).toBe(true);
});

test("a Retry refused because a newer member decision superseded it returns its code as a conflict", async () => {
  let refusal: Error = new DecisionRefusedError("member_decision_superseded", "superseded");
  const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([actor.orgId]), reports: { async submitReport() { throw new Error("not called"); } }, decisions: { async acceptDecision() { return status; }, async get() { return status; }, async retry() { throw refusal; } } });
  const retryPath = `/v1/decisions/${status.decisionId}/retry`;
  const post = () => api(new Request("https://rooms.example" + retryPath, { method: "POST", body: "", headers: signCoopRequest(secret, actor, "POST", retryPath, "") }));
  const refused = await post();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "member_decision_superseded" });
  // Every other failure keeps the opaque rejection, message text included.
  refusal = new Error("member_decision_superseded");
  const other = await post();
  expect(other.status).toBe(400);
  expect(await other.json()).toEqual({ error: "decision_not_accepted" });
});

test("publication refresh only schedules authenticated readback and returns current status", async () => {
  let calls = 0;
  const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([actor.orgId]), reports: { async submitReport() { throw new Error(); } }, decisions: { async acceptDecision() { throw new Error(); }, async get() { return status; }, async retry() { throw new Error("Do not reopen Retry"); }, async refreshPublicationProof(id, staff) { calls++; expect(id).toBe(status.decisionId); expect(staff).toEqual(actor); return status; } } });
  const path = `/v1/decisions/${status.decisionId}/publication-refresh`, body = "{}";
  expect((await api(new Request("https://rooms.example" + path, { method: "POST", body }))).status).toBe(403);
  const response = await api(new Request("https://rooms.example" + path, { method: "POST", body, headers: signCoopRequest(secret, actor, "POST", path, body) }));
  expect(response.status).toBe(202); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.json()).toEqual(status); expect(calls).toBe(1);
  const injected = JSON.stringify({ target: "browser supplied" });
  expect((await api(new Request("https://rooms.example" + path, { method: "POST", body: injected, headers: signCoopRequest(secret, actor, "POST", path, injected) }))).status).toBe(400);
  expect(calls).toBe(1);
});
