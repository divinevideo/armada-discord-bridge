import { expect, test } from "bun:test";
import { loadModerationConfig } from "./config";
import * as readiness from "./apiReadiness";
const env = {
  MODERATION_DATABASE_URL: "postgres://synthetic", MODERATION_PUBLIC_ORIGIN: "https://moderation.example",
  MODERATION_COMMUNITY_ORGS: JSON.stringify({ ["a".repeat(64)]: "synthetic-org" }), MODERATION_REPORT_ORIGINS: '["https://report.example"]',
  MODERATION_COOP_HMAC_KEY: "11".repeat(32), MODERATION_EVIDENCE_KEY: "22".repeat(32),
  MODERATION_EVIDENCE_RETENTION_SECONDS: "3600", MODERATION_EVIDENCE_MAX_BYTES: "100000", MODERATION_EVIDENCE_MAX_CASES: "100",
};
test("optional lifecycle policies have no numeric defaults and retain independent key material", () => {
  const config = loadModerationConfig(env);
  expect(config.auditRetentionSeconds).toBeUndefined(); expect(config.holdMaxSeconds).toBeUndefined();
  expect(config.coopSecret.equals(Buffer.from("11".repeat(32), "hex"))).toBe(true);
  expect(config.evidenceKey.equals(Buffer.from("22".repeat(32), "hex"))).toBe(true);
  expect(loadModerationConfig({ ...env, MODERATION_AUDIT_RETENTION_SECONDS: "86400", MODERATION_HOLD_MAX_SECONDS: "7200" })).toMatchObject({ auditRetentionSeconds: 86400, holdMaxSeconds: 7200 });
});
for (const name of ["MODERATION_AUDIT_RETENTION_SECONDS", "MODERATION_HOLD_MAX_SECONDS"]) {
  for (const value of ["", "0", "-1", "1.5", " 3", "3 ", "1e3", "NaN", "Infinity", "9007199254740992"]) {
    test(`reject malformed supplied ${name}: ${JSON.stringify(value)}`, () => expect(() => loadModerationConfig({ ...env, [name]: value })).toThrow(`Invalid ${name}`));
  }
}
test("capability foundation preserves read/replay/release and rejects new policy-dependent writes before allocation", async () => {
  const config = loadModerationConfig(env);
  const capabilities = readiness.moderationWriteCapabilities(config);
  expect(capabilities).toMatchObject({ reads: true, acceptedReplay: true, reconciliation: true, holdRelease: true, policyDependentWrites: false, code: "policy_configuration_required" });
  let allocated = false;
  await expect((async () => { readiness.requireLifecyclePolicy(config); allocated = true; })()).rejects.toMatchObject({ code: "policy_configuration_required" });
  expect(allocated).toBe(false);
  expect(readiness.moderationWriteCapabilities({ auditRetentionSeconds: 1, holdMaxSeconds: 2 })).toMatchObject({ policyDependentWrites: true, code: "ready" });
  expect(readiness.moderationWriteCapabilities({ auditRetentionSeconds: 1 })).toMatchObject({ policyDependentWrites: false });
  const response = readiness.lifecycleWriteReadinessResponse(config, true);
  expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ code: "policy_configuration_required", acceptedReplay: true });
  expect(readiness.lifecycleWriteReadinessResponse({ auditRetentionSeconds: 1, holdMaxSeconds: 2 }, true).status).toBe(200);
  expect(readiness.lifecycleWriteReadinessResponse({ auditRetentionSeconds: 1, holdMaxSeconds: 2 }, false).status).toBe(503);
});
