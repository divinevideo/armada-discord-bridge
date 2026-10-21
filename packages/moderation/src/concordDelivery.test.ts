import { expect, test } from "bun:test";
import { buildBanlistEdition, buildGrantEdition, bytesToHex, currentControlWriteGroup, grantLocator, openWrap, parseEdition, sealEdition } from "@armada-bridge/concord-core";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { ConcordActions } from "./concordActions";
import { deliverConcord, settledConcordReceipt } from "./concordDelivery";
import type { Decisions, DeliveryClaim } from "./decisions";
test("only exact not-applicable canonical receipt pairs count as settled", () => {
  for (const code of ["concord_publication_settled", "concord_superseded_publication_settled"]) {
    for (const state of ["pending", "acknowledged", "failed", "verified", "not_applicable"]) {
      expect(settledConcordReceipt(state, code)).toBe(state === "not_applicable");
    }
  }
  for (const code of [null, undefined, "concord_recovery_awaiting_proof", "unrelated_not_applicable"]) expect(settledConcordReceipt("not_applicable", code)).toBe(false);
});
function memoryDecisions(calls: string[] = []): Pick<Decisions, "saveEvents" | "replaceUnattemptedEvents" | "markPublicationAttempted"> {
  return {
    saveEvents: async (claim, events) => { calls.push("persist"); claim.signedEvents = events; claim.publicationAttempted = false; return events; },
    replaceUnattemptedEvents: async (claim, previous, events) => {
      expect(claim.publicationAttempted).toBe(false);
      expect(claim.signedEvents).toEqual(previous);
      calls.push("replace"); claim.signedEvents = events; return events;
    },
    markPublicationAttempted: async (claim, events) => { expect(claim.signedEvents).toEqual(events); calls.push("attempt"); claim.publicationAttempted = true; },
  };
}
async function preparedBan() {
  const f = await moderationFixture();
  const actions = new ConcordActions(f.community, f.moderator, async () => f.policy);
  const decision = { ...f.decision, action: "ban_member" as const };
  const events = await actions.prepare(decision);
  const claim: DeliveryClaim = { decision, target: "concord", attempts: 2, token: crypto.randomUUID(), signedEvents: events, publicationAttempted: false };
  const compete = async () => {
    const candidate = parseEdition(openWrap(events[0], f.controlStream.key));
    f.policy.controlEvents.push(await sealEdition(buildBanlistEdition(f.community.id, [f.bannedMember.pk, "ef".repeat(32)], { actorPubkey: f.owner.pk, version: candidate.version, prevHash: candidate.prevHash }), currentControlWriteGroup(f.community), f.owner.signer));
  };
  return { f, actions, claim, events, compete };
}
test("publication persists signed bytes first and verifies a fresh relay read", async () => {
  const f = await moderationFixture(), calls: string[] = [];
  let events: any[] = [];
  const claim: DeliveryClaim = { decision: f.decision, target: "concord", attempts: 1, token: crypto.randomUUID(), signedEvents: null };
  const action = new ConcordActions(f.community, f.moderator, async () => f.policy);
  const store = memoryDecisions(calls);
  const execute = () => deliverConcord(claim, action, store, { publish: async () => { calls.push("publish"); events = claim.signedEvents as any[]; }, queryStrict: async () => { calls.push("query"); return events; } }, async () => { calls.push("ownership"); });
  expect((await execute()).state).toBe("verified");
  expect(calls.indexOf("persist")).toBeLessThan(calls.indexOf("publish"));
  expect(calls.indexOf("attempt")).toBeLessThan(calls.indexOf("publish"));
  expect(calls.indexOf("publish")).toBeLessThan(calls.indexOf("query"));
  claim.signedEvents = events;
  calls.length = 0;
  expect((await execute()).state).toBe("verified");
  expect(calls).not.toContain("persist");
});
test("a publish ACK without the event on a fresh read is not verified", async () => {
  const f = await moderationFixture();
  const claim: DeliveryClaim = { decision: f.decision, target: "concord", attempts: 1, token: crypto.randomUUID(), signedEvents: null };
  const result = await deliverConcord(claim, new ConcordActions(f.community, f.moderator, async () => f.policy), memoryDecisions(), { publish: async () => {}, queryStrict: async () => [] }, async () => {});
  expect(result.state).toBe("acknowledged");
});
test("an unattempted persisted ban recovers after a competing edit and preserves unrelated bans", async () => {
  const { f, actions, claim, events, compete } = await preparedBan();
  await compete();
  const calls: string[] = [];
  const result = await deliverConcord(claim, actions, memoryDecisions(calls), {
    publish: async (event) => {
      calls.push("publish");
      expect(event.id).not.toBe(events[0].id);
      expect(claim.publicationAttempted).toBe(true);
      const edition = parseEdition(openWrap(event, f.controlStream.key));
      expect(JSON.parse(edition.content).sort()).toEqual([f.member.pk, f.bannedMember.pk, "ef".repeat(32)].sort());
      f.policy.controlEvents.push(event);
    }, queryStrict: async () => claim.signedEvents as any[],
  }, async () => {});
  expect(result.state).toBe("verified");
  expect(calls).toEqual(["replace", "attempt", "publish"]);
});
test("a transport failure keeps the same generation and retries its exact bytes", async () => {
  const { actions, claim, events } = await preparedBan();
  const calls: string[] = [], sent: string[] = [];
  const store = memoryDecisions(calls);
  await expect(deliverConcord(claim, actions, store, { publish: async (event) => { sent.push(event.id); throw new Error("uncertain timeout"); }, queryStrict: async () => [] }, async () => {})).rejects.toThrow("concord_transport_unavailable");
  expect(claim.publicationAttempted).toBe(true);
  expect(claim.signedEvents).toEqual(events);
  await deliverConcord(claim, actions, store, { publish: async (event) => { sent.push(event.id); }, queryStrict: async () => events }, async () => {});
  expect(sent).toEqual([events[0].id, events[0].id]);
  expect(calls).not.toContain("replace");
});
test("uncertain and legacy stale generations require operator recovery without replacement or publish", async () => {
  for (const attempted of [true, undefined]) {
    const { actions, claim, events, compete } = await preparedBan();
    claim.publicationAttempted = attempted;
    await compete();
    const calls: string[] = [];
    expect(await deliverConcord(claim, actions, memoryDecisions(calls), { publish: async () => { throw new Error("must not publish"); }, queryStrict: async () => { throw new Error("absence cannot prove non-publication"); } }, async () => {})).toEqual({ state: "failed", code: "concord_recovery_requires_operator" });
    expect(calls).toEqual([]);
    expect(claim.signedEvents).toEqual(events);
  }
});
test("an already applied ban is replayed, not rebased into a new generation", async () => {
  const { f, actions, claim, events } = await preparedBan();
  f.policy.controlEvents.push(events[0]);
  claim.publicationAttempted = true;
  const calls: string[] = [];
  const result = await deliverConcord(claim, actions, memoryDecisions(calls), { publish: async (event) => { expect(event).toEqual(events[0]); }, queryStrict: async () => events }, async () => {});
  expect(result.state).toBe("verified");
  expect(calls).toEqual(["attempt"]);
});
test("ban and unban readback survives canonical successors without replacing the signed generation", async () => {
  for (const action of ["ban_member", "unban_member"] as const) {
    for (const onRetry of [false, true]) {
      const f = await moderationFixture();
      const actions = new ConcordActions(f.community, f.moderator, async () => f.policy);
      const decision = { ...f.decision, author: f.bannedMember.pk, action };
      const events = await actions.prepare(decision);
      const claim: DeliveryClaim = { decision, target: "concord", attempts: 2, token: crypto.randomUUID(), signedEvents: events, publicationAttempted: onRetry };
      const extend = async () => {
        f.policy.controlEvents.push(events[0]);
        let head = parseEdition(openWrap(events[0], f.controlStream.key));
        for (let i = 0; i < 2; i++) {
          const members = [...JSON.parse(head.content), String(i + 1).repeat(64)];
          const successor = await sealEdition(buildBanlistEdition(f.community.id, members, { actorPubkey: f.owner.pk, version: head.version + 1n, prevHash: head.selfHash }), currentControlWriteGroup(f.community), f.owner.signer);
          f.policy.controlEvents.push(successor);
          head = parseEdition(openWrap(successor, f.controlStream.key));
        }
      };
      if (onRetry) await extend();
      const calls: string[] = [];
      const result = await deliverConcord(claim, actions, memoryDecisions(calls), { publish: async () => { if (!onRetry) await extend(); }, queryStrict: async () => events }, async () => {});
      expect(result).toEqual({ state: "verified", code: "concord_enforcement_verified" });
      expect(claim.signedEvents).toEqual(events);
      expect(calls).toEqual(["attempt"]);
    }
  }
});

test("a canonical successor reversing an applied unban does not verify enforcement", async () => {
  const f = await moderationFixture();
  const actions = new ConcordActions(f.community, f.moderator, async () => f.policy);
  const decision = { ...f.decision, author: f.bannedMember.pk, action: "unban_member" as const };
  const events = await actions.prepare(decision);
  const claim: DeliveryClaim = { decision, target: "concord", attempts: 1, token: crypto.randomUUID(), signedEvents: events, publicationAttempted: false };
  const result = await deliverConcord(claim, actions, memoryDecisions(), {
    publish: async () => {
      f.policy.controlEvents.push(events[0]);
      const head = parseEdition(openWrap(events[0], f.controlStream.key));
      f.policy.controlEvents.push(await sealEdition(buildBanlistEdition(f.community.id, [decision.author], { actorPubkey: f.owner.pk, version: head.version + 1n, prevHash: head.selfHash }), currentControlWriteGroup(f.community), f.owner.signer));
    }, queryStrict: async () => events,
  }, async () => {});
  expect(result).toEqual({ state: "acknowledged", code: "concord_awaiting_fold" });
});
test("revoked authority cannot recover an unattempted stale ban", async () => {
  const { f, actions, claim, events, compete } = await preparedBan();
  await compete();
  const grantId = bytesToHex(grantLocator(f.community.id, Buffer.from(f.moderator.pk, "hex")));
  const grant = f.policy.controlEvents.map((event) => parseEdition(openWrap(event, f.controlStream.key))).find((edition) => bytesToHex(edition.entityId) === grantId)!;
  f.policy.controlEvents.push(await sealEdition(buildGrantEdition(f.community.id, { member: f.moderator.pk, roleIds: [] }, { actorPubkey: f.owner.pk, version: grant.version + 1n, prevHash: grant.selfHash }), currentControlWriteGroup(f.community), f.owner.signer));
  const calls: string[] = [];
  await expect(deliverConcord(claim, actions, memoryDecisions(calls), { publish: async () => { throw new Error("must not publish"); }, queryStrict: async () => [] }, async () => {})).rejects.toThrow();
  expect(calls).toEqual([]);
  expect(claim.signedEvents).toEqual(events);
});
test("a stale worker whose recovery CAS fails cannot publish its replacement", async () => {
  const { actions, claim, events, compete } = await preparedBan();
  await compete();
  const store = memoryDecisions();
  store.replaceUnattemptedEvents = async () => { throw new Error("Delivery lease or unattempted generation lost"); };
  let published = false;
  await expect(deliverConcord(claim, actions, store, { publish: async () => { published = true; }, queryStrict: async () => [] }, async () => {})).rejects.toThrow(/lease/);
  expect(published).toBe(false);
  expect(claim.signedEvents).toEqual(events);
});
test("failure to persist publication intent prevents network publication", async () => {
  const { actions, claim } = await preparedBan();
  const store = memoryDecisions();
  store.markPublicationAttempted = async () => { throw new Error("Delivery lease or generation lost"); };
  let published = false;
  await expect(deliverConcord(claim, actions, store, { publish: async () => { published = true; }, queryStrict: async () => [] }, async () => {})).rejects.toThrow(/lease/);
  expect(published).toBe(false);
});
test("lease loss or revoked policy during the send-marker write prevents publication", async () => {
  for (const revokedPolicy of [false, true]) {
    const { f, actions, claim } = await preparedBan();
    let lost = false, published = false;
    const store = memoryDecisions();
    store.markPublicationAttempted = async () => { claim.publicationAttempted = true; if (revokedPolicy) f.policy.complete = false; else lost = true; };
    await expect(deliverConcord(claim, actions, store, { publish: async () => { published = true; }, queryStrict: async () => [] }, async () => { if (lost) throw new Error("Delivery lease lost"); })).rejects.toThrow();
    expect(published).toBe(false);
  }
});
test("a competing edit discovered after publication preserves the uncertain generation for an operator", async () => {
  const { actions, claim, events, compete } = await preparedBan();
  const calls: string[] = [];
  const result = await deliverConcord(claim, actions, memoryDecisions(calls), { publish: async () => { await compete(); }, queryStrict: async () => events }, async () => {});
  expect(result).toEqual({ state: "failed", code: "concord_recovery_requires_operator" });
  expect(claim.signedEvents).toEqual(events);
  expect(claim.publicationAttempted).toBe(true);
  expect(calls).toEqual(["attempt"]);
});
