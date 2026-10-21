import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { createPublicationRecoveryActions } from "./publicationOperator";
import { recoverPublication } from "./publicationRecovery";
import { expect, test } from "bun:test";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyWatcher } from "./policyWatcher";
test("a disconnect during snapshot fetch cannot install a fresh admitting policy", async () => {
  const f = await relayFixture();
  let finish!: (events: any[]) => void;
  let installed = 0, invalidated = 0;
  const store: any = { getPolicy: async () => f.policy, invalidate: async () => { invalidated++; }, install: async () => { installed++; } };
  const watcher = new PolicyWatcher(f.community, store, { queryStrict: async () => new Promise((resolve) => { finish = resolve; }) }, []);
  const refreshing = watcher.refresh();
  await Promise.resolve();
  await watcher.disconnected();
  finish([f.controlEvent]);
  await expect(refreshing).rejects.toThrow();
  expect(installed).toBe(0);
  expect(invalidated).toBeGreaterThan(0);
});

for (const invalidOriginal of [false, true]) test(`maintenance ${invalidOriginal ? "invalid original" : "missing proof"} cannot enable excluded admission during recovery`, async () => {
  const f = await moderationFixture();
  let admission = { ...f.policy, complete: false, validUntil: 0 }, installed = 0, invalidated = 0;
  const observedAdmission: boolean[] = [];
  const observe = () => { observedAdmission.push(admission.complete && admission.validUntil > Date.now()); };
  const store = {
    getPolicy: async () => { observe(); return admission; },
    install: async (policy: typeof admission) => { admission = policy; installed++; observe(); },
    invalidate: async () => { admission = { ...admission, complete: false, validUntil: 0 }; invalidated++; },
  };
  const relay = { queryStrict: async (filters: { ids?: string[] }[]) => { observe(); return filters[0].ids ? [] : f.policy.controlEvents; } };
  // Same watcher/actions composition as publicationOperator; its fresh
  // authority snapshot must never install a fresh relay-admission policy.
  const eventId = "a".repeat(64);
  const row = { decision_id: f.decision.decisionId, org_id: "synthetic-pilot", case_id: f.decision.caseId,
    action: "ban_member", author: f.member.pk, discord_guild_confirmed: false, expires_at: new Date(Date.now() + 60_000),
    signed_events: null, publication_metadata: null, publication_event_ids: [eventId], attempts: 8, recovery_version: 0, state: "failed", lease_until: null };
  const sql = Object.assign(async (strings: TemplateStringsArray) => {
    observe();
    return strings.join().includes("pg_try_advisory") ? [{ owned: true }] : [row];
  }, { begin: async (work: (tx: unknown) => Promise<unknown>) => work(sql) });
  const actions = createPublicationRecoveryActions({ sql: sql as never, community: f.community, identity: f.moderator, store: store as never, relay: relay as never, operation: "prove" });
  await expect(recoverPublication({ sql: sql as never,
    decisions: { get: async () => ({ target: f.decision.target, action: "ban_member" }) } as never,
    actions, relay: relay as never, cipher: undefined as never,
    actor: { orgId: "synthetic-pilot", actorId: "synthetic-operator", permissions: ["recover_publication", "ban_member", "view"] },
    request: { decisionId: f.decision.decisionId, expectedVersion: 0, eventId, operation: "prove", reason: "Synthetic maintenance",
      ...(invalidOriginal ? { originalEvent: f.policy.controlEvents[0] } : {}) },
  })).rejects.toThrow(invalidOriginal ? /identity mismatch/ : /supersession proof required/);
  observe();
  expect(installed).toBe(0);
  expect(invalidated).toBe(0);
  expect(observedAdmission.length).toBeGreaterThan(2);
  expect(observedAdmission.every(enabled => !enabled)).toBe(true);
  expect(admission).toMatchObject({ complete: false, validUntil: 0 });
  expect(row).toMatchObject({ signed_events: null, publication_metadata: null, attempts: 8, recovery_version: 0 });
});
