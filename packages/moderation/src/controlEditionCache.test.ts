import { expect, test } from "bun:test";
import { buildChannelEdition, currentControlWriteGroup, hex32, openWrap, parseEdition, sealEdition } from "@armada-bridge/concord-core";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { ControlEditionCache } from "./controlEditionCache";
import { controlState, evaluateRelayEvent, verifiedEvent } from "./relayPolicy";

test("identical control bytes are decoded once, without sharing mutable editions", async () => {
  const f = await relayFixture(), cache = new ControlEditionCache();
  let calls = 0;
  const decode = () => { calls++; return parseEdition(openWrap(verifiedEvent(f.controlEvent), f.controlStream.key)); };
  const first = cache.read(f.controlEvent, f.controlStream, decode);
  const expected = structuredClone(first);
  first.content = "changed"; first.selfHash.fill(0);
  for (let i = 0; i < 200; i++) expect(cache.read(f.controlEvent, f.controlStream, decode)).toEqual(expected);
  expect(calls).toBe(1);
});

test("cache keys include actual event bytes and stream material, not claimed identifiers", async () => {
  const f = await relayFixture(), cache = new ControlEditionCache();
  const read = (event = f.controlEvent, stream = f.controlStream) => cache.read(event, stream, () => parseEdition(openWrap(verifiedEvent(event), stream.key)));
  read();
  for (const event of [{ ...f.controlEvent, sig: "00".repeat(64) }, { ...f.controlEvent, content: "changed" }]) expect(() => read(event)).toThrow();
  const wrong = { ...f.controlStream, key: { ...f.controlStream.key, convKey: new Uint8Array(32) } };
  expect(() => read(f.controlEvent, wrong)).toThrow();
  expect(read()).toEqual(structuredClone(parseEdition(openWrap(f.controlEvent, f.controlStream.key))));
});

test("failed decoding is not memoized and entry/byte bounds evict rather than trust", async () => {
  const f = await relayFixture(), edition = parseEdition(openWrap(f.controlEvent, f.controlStream.key));
  const cache = new ControlEditionCache(1);
  let calls = 0;
  expect(() => cache.read(f.controlEvent, f.controlStream, () => { throw new Error("synthetic failure"); })).toThrow();
  const read = (event = f.controlEvent) => cache.read(event, f.controlStream, () => { calls++; return edition; });
  read(); read({ ...f.controlEvent, created_at: f.controlEvent.created_at + 1 }); read();
  expect(calls).toBe(3);
  const noRoom = new ControlEditionCache(1, 1);
  noRoom.read(f.controlEvent, f.controlStream, () => { calls++; return edition; });
  noRoom.read(f.controlEvent, f.controlStream, () => { calls++; return edition; });
  expect(calls).toBe(5);
});

test("warm cryptographic decoding still folds new authority and rejects tampered policy bytes", async () => {
  const f = await relayFixture();
  const context = { policy: f.policy, stream: f.chatStream, now: Date.now, isRemoved: async () => false, authorOf: async () => undefined };
  expect((await evaluateRelayEvent(f.allowed, context)).action).toBe("accept");
  const head = controlState(f.policy).editions[0];
  const privateEdition = await sealEdition(buildChannelEdition(hex32(f.channelId), { name: "general", private: true }, { actorPubkey: f.owner.pk, version: head.version + 1n, prevHash: head.selfHash }), currentControlWriteGroup(f.community), f.owner.signer);
  // No revision bump: newly accepted control bytes must affect the next fold.
  f.policy.controlEvents.push(privateEdition);
  expect((await evaluateRelayEvent(f.allowed, context)).action).toBe("reject");
  f.policy.controlEvents.pop();
  expect((await evaluateRelayEvent(f.allowed, context)).action).toBe("accept");
  f.policy.controlEvents[0] = { ...f.controlEvent, sig: "00".repeat(64) };
  expect((await evaluateRelayEvent(f.allowed, context)).action).toBe("reject");
});
