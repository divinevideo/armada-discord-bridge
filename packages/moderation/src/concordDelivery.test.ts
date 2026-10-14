import { expect, test } from "bun:test";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { ConcordActions } from "./concordActions";
import { deliverConcord } from "./concordDelivery";
import type { DeliveryClaim } from "./decisions";
test("publication persists signed bytes first and verifies a fresh relay read", async () => {
  const f = await moderationFixture(), calls: string[] = [];
  let events: any[] = [];
  const claim: DeliveryClaim = { decision: f.decision, target: "concord", attempts: 1, token: crypto.randomUUID(), signedEvents: null };
  const action = new ConcordActions(f.community, f.moderator, async () => f.policy);
  const execute = () => deliverConcord(claim, action, { saveEvents: async (_claim, value) => { calls.push("persist"); events = value; return value; } }, { publish: async () => { calls.push("publish"); }, queryStrict: async () => { calls.push("query"); return events; } }, async () => { calls.push("ownership"); });
  expect((await execute()).state).toBe("verified");
  expect(calls.indexOf("persist")).toBeLessThan(calls.indexOf("publish"));
  expect(calls.indexOf("publish")).toBeLessThan(calls.indexOf("query"));
  claim.signedEvents = events;
  calls.length = 0;
  expect((await execute()).state).toBe("verified");
  expect(calls).not.toContain("persist");
});
test("a publish ACK without the event on a fresh read is not verified", async () => {
  const f = await moderationFixture();
  const claim: DeliveryClaim = { decision: f.decision, target: "concord", attempts: 1, token: crypto.randomUUID(), signedEvents: null };
  const result = await deliverConcord(claim, new ConcordActions(f.community, f.moderator, async () => f.policy), { saveEvents: async (_claim, events) => events }, { publish: async () => {}, queryStrict: async () => [] }, async () => {});
  expect(result.state).toBe("acknowledged");
});
