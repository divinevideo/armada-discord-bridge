import { describe, expect, test } from "bun:test";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@armada-bridge/concord-core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { evaluateRelayEvent } from "./relayPolicy";

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
