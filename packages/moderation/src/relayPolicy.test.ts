import { describe, expect, test } from "bun:test";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@armada-bridge/concord-core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { evaluateRelayEvent } from "./relayPolicy";
import type { AdmissionContext } from "./contracts";

const fixture = await relayFixture();
function context(overrides = {}) {
  return { policy: fixture.policy, stream: fixture.chatStream, now: Date.now, isRemoved: async () => false, authorOf: async () => undefined, ...overrides };
}

describe("relay admission", () => {
  test("accepts an allowed member but rejects a banned inner author on the same stream", async () => {
    expect(fixture.allowed.pubkey).toBe(fixture.banned.pubkey);
    expect((await evaluateRelayEvent(fixture.allowed, context())).action).toBe("accept");
    for (const authed of [undefined, fixture.member.pk, fixture.owner.pk]) {
      expect((await evaluateRelayEvent(fixture.banned, { ...context(), authed })).action).toBe("reject");
    }
  });
  test("rejects changed outer hashes and signatures even when a library verification flag is present", async () => {
    for (const event of [{ ...fixture.allowed, sig: "00".repeat(64) }, { ...fixture.allowed, content: "changed" }, { ...fixture.allowed, id: "ab".repeat(32) }]) {
      expect((await evaluateRelayEvent(event, context())).action).toBe("reject");
    }
  });
  test("rejects a rumor whose signer is not its claimed author", async () => {
    const rumor = buildRumor({ pubkey: fixture.member.pk, kind: 9, content: "synthetic", tags: channelBindingTags(fixture.channelId, 0n), ms: Date.now() });
    const event = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.owner.signer), fixture.chatKey);
    expect((await evaluateRelayEvent(event, context())).action).toBe("reject");
  });
  test("rejects forged rumor IDs, wrong channel/epoch, plaintext chat and cross-plane kinds", async () => {
    for (const variant of ["id", "channel", "epoch", "plaintext", "plane"]) {
      const rumor = buildRumor({ pubkey: fixture.member.pk, kind: variant === "plane" ? 3308 : 9, content: "synthetic", tags: channelBindingTags(variant === "channel" ? "dd".repeat(32) : fixture.channelId, variant === "epoch" ? 1n : 0n), ms: Date.now() });
      if (variant === "id") rumor.id = "00".repeat(32);
      const event = wrapSeal(await sealRumor(rumor, variant === "plaintext" ? KIND_SEAL_PLAINTEXT : KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.member.signer), fixture.chatKey);
      expect((await evaluateRelayEvent(event, context())).action).toBe("reject");
    }
  });
  test("fails closed for unknown streams, unavailable, stale or incomplete policy", async () => {
    for (const c of [context({ stream: undefined }), context({ policy: undefined }), context({ policy: { ...fixture.policy, complete: false } }), context({ now: () => fixture.policy.validUntil + 1 })]) {
      expect((await evaluateRelayEvent(fixture.allowed, c)).action).toBe("reject");
    }
  });
  test("rejects a removed rumor even in a new valid wrapper", async () => {
    const event = wrapSeal(fixture.allowedSeal, fixture.chatKey);
    expect((await evaluateRelayEvent(event, context({ isRemoved: async () => true }))).action).toBe("reject");
  });
  test("applies the same ban to ephemeral typing and refuses ordinary DMs", async () => {
    for (const author of [fixture.member, fixture.bannedMember]) {
      const rumor = buildRumor({ pubkey: author.pk, kind: 23311, content: "", tags: channelBindingTags(fixture.channelId, 0n), ms: Date.now() });
      const event = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, fixture.chatKey, author.signer), fixture.chatKey, { ephemeral: true });
      expect((await evaluateRelayEvent(event, context())).action).toBe(author === fixture.member ? "accept" : "reject");
    }
    const sk = generateSecretKey();
    const dm = finalizeEvent({ kind: 1059, content: "not a community stream", tags: [["p", getPublicKey(sk)]], created_at: Math.floor(Date.now() / 1000) }, sk);
    expect((await evaluateRelayEvent(dm, context({ stream: undefined }))).action).toBe("reject");
  });
  test("allows independently authorized control recovery while chat policy is stale", async () => {
    const c = context({ stream: fixture.controlStream, now: () => fixture.policy.validUntil + 1 });
    expect((await evaluateRelayEvent(fixture.controlEvent, c)).action).toBe("accept");
    expect((await evaluateRelayEvent(fixture.unauthorizedControl, c)).action).toBe("reject");
  });
  test("does not accept control-kind rumors in the guestbook", async () => {
    expect((await evaluateRelayEvent(fixture.controlEvent, context({ stream: fixture.guestbookStream }))).action).toBe("reject");
  });
  test("does not expose plaintext or errors in rejection messages", async () => {
    const result = await evaluateRelayEvent(fixture.allowed, context({ isRemoved: async () => { throw new Error("synthetic confidential payload"); } }));
    expect(result.action).toBe("reject");
    expect(JSON.stringify(result)).not.toContain("confidential");
  });
});

test("CORD-08 requires matching relay expiry and rejects expired or expiring tombstones", async () => {
  const future = String(Math.floor(Date.now() / 1000) + 120);
  for (const variant of ["matching", "missing", "changed", "expired", "delete"]) {
    const value = variant === "expired" ? "1" : future;
    const rumor = buildRumor({ pubkey: fixture.member.pk, kind: variant === "delete" ? 5 : 9, content: "synthetic expiry", tags: [...channelBindingTags(fixture.channelId, 0n), ["expiration", value], ["e", fixture.allowedRumorId]], ms: Date.now() });
    const wrapped = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.member.signer), fixture.chatKey);
    const event = finalizeEvent({ ...wrapped, tags: [...wrapped.tags, ...(variant === "missing" ? [] : [["expiration", variant === "changed" ? String(Number(value) + 1) : value]])] }, fixture.chatKey.sk);
    const result = await evaluateRelayEvent(event, context({ authorOf: async () => fixture.member.pk }));
    expect(result.action).toBe(variant === "matching" ? "accept" : "reject");
  }
});

test("policy expiring while a tombstone lookup is pending cannot admit a write", async () => {
  let now = fixture.policy.validUntil - 1;
  const result = await evaluateRelayEvent(fixture.allowed, context({ now: () => now, isRemoved: async () => { now++; return false; } }));
  expect(result.action).toBe("reject");
});

test("retired channel epochs reject newly authored messages", async () => {
  const f = await relayFixture();
  const context: AdmissionContext = { policy: f.policy, stream: { ...f.chatStream, retiredAt: 1 }, now: Date.now, isRemoved: async () => false, authorOf: async () => f.member.pk };
  expect((await evaluateRelayEvent(f.allowed, context)).action).toBe("reject");
});

test("authorized base rekey chunks remain admissible while public chat is suspended", async () => {
  const f = await relayFixture();
  const core = await import("@armada-bridge/concord-core");
  const group = core.baseRekeyGroupKey(f.community.root, f.community.id, 1n);
  const prevCommit = core.bytesToHex(core.epochKeyCommitment(0n, f.community.root));
  const rumor = core.buildRekeyRumors(f.owner.pk, { scope: { kind: "root" }, prevEpoch: 0n, newEpoch: 1n, prevCommit }, [], Date.now())[0];
  const event = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, f.owner.signer), group);
  const stream: any = { communityId: f.community.idHex, plane: "rekey", epoch: "1", previousEpoch: "0", previousCommit: prevCommit, key: { pk: group.pk, convKey: group.convKey } };
  const context: any = { policy: { ...f.policy, rekeyPending: true }, stream, now: Date.now, isRemoved: async () => false, authorOf: async () => undefined };
  expect((await evaluateRelayEvent(event, context)).action).toBe("accept");
  expect((await evaluateRelayEvent(f.allowed, { ...context, stream: f.chatStream })).action).toBe("reject");
  expect((await evaluateRelayEvent(event, { ...context, stream: { ...stream, previousCommit: "f".repeat(64) } })).action).toBe("reject");
});

import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { ConcordActions } from "./concordActions";
import { inspectRelayEvent } from "./relayPolicy";
import { buildJoinRumor, buildLeaveRumor, currentGuestbookGroup } from "@armada-bridge/concord-core";
test("only a delete of the deleter's own content, or a Leave, is marked as a retraction", async () => {
  const g = await moderationFixture(), guestbook = currentGuestbookGroup(g.community);
  const chat = (stream = g.chatStream, authorOf = async () => g.member.pk as string | undefined): AdmissionContext => ({ policy: g.policy, stream, now: Date.now, isRemoved: async () => false, authorOf });
  const rumor = async (kind: number) => wrapSeal(await sealRumor(buildRumor({ pubkey: g.member.pk, kind, content: kind === 3302 ? "edited" : "", tags: [...channelBindingTags(g.channelId, BigInt(g.chatStream.epoch)), ["e", g.allowedRumorId]], ms: Date.now() }), KIND_SEAL_ENCRYPTED, g.chatKey, g.member.signer), g.chatKey);
  const own = await inspectRelayEvent(await rumor(5), chat());
  expect(own.result.action).toBe("accept"); expect(own.retraction).toBe(true);
  // A moderator's cited removal of someone else's message is staff authority, not a retraction.
  const removal = await inspectRelayEvent((await new ConcordActions(g.community, g.moderator, async () => g.policy).prepare(g.decision))[0], chat());
  expect(removal.result.action).toBe("accept"); expect(removal.retraction).toBe(false);
  const edit = await inspectRelayEvent(await rumor(3302), chat());
  expect(edit.result.action).toBe("accept"); expect(edit.retraction).toBe(false);
  const motion = async (r: ReturnType<typeof buildLeaveRumor>) => inspectRelayEvent(wrapSeal(await sealRumor(r, KIND_SEAL_ENCRYPTED, guestbook, g.member.signer), guestbook), chat(g.guestbookStream));
  expect((await motion(buildLeaveRumor(g.member.pk, Date.now())))).toMatchObject({ result: { action: "accept" }, retraction: true });
  expect((await motion(buildJoinRumor(g.member.pk, Date.now())))).toMatchObject({ result: { action: "accept" }, retraction: false });
});
