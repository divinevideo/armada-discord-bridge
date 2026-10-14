import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createModerationApi, signCoopRequest } from "./api";
const secret = randomBytes(32);
const actor = { orgId: "synthetic-org", actorId: "synthetic-reviewer", permissions: ["remove_message", "view", "retry"] };
const status = { decisionId: crypto.randomUUID(), target: { communityId: "a".repeat(64), channelId: "b".repeat(64), rumorId: "c".repeat(64) }, action: "remove_message" as const, deliveries: [] };
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
