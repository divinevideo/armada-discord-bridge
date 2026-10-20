import { expect, test } from "bun:test";
import { RelayPurger, type RemovalIndex, type PurgeDriver } from "./relayPurge";
const target = { communityId: "a".repeat(64), channelId: "b".repeat(64), rumorId: "c".repeat(64) };

test("tombstones before waiting for writers, then rescans and verifies before success", async () => {
  const calls: string[] = [];
  const ids = ["d".repeat(64), "e".repeat(64)];
  const index = {
    async start() { calls.push("tombstone"); return 2; },
    async ids() { calls.push("index"); return ids; },
    async finish(_id: string, state: string) { calls.push(state); },
  };
  const driver = {
    async barrier<T>(work: () => Promise<T>) { calls.push("barrier"); return work(); },
    async delete(actual: string[]) { calls.push("delete"); expect(actual).toEqual(ids); },
    async remaining(actual: string[]) { calls.push("query"); expect(actual).toEqual(ids); return []; },
  };
  expect((await new RelayPurger(index, driver).removeFromRelay(target, crypto.randomUUID())).state).toBe("verified");
  expect(calls).toEqual(["tombstone", "barrier", "index", "delete", "index", "query", "verified"]);
});

test("failed deletion or verification remains retryable and never claims completion", async () => {
  const states: string[] = [];
  const index = { async start() { return 4; }, async ids() { return ["d".repeat(64)]; }, async finish(_id: string, state: string) { states.push(state); } };
  const driver = { async barrier<T>(work: () => Promise<T>) { return work(); }, async delete() {}, async remaining() { return ["d".repeat(64)]; } };
  const purger = new RelayPurger(index, driver);
  expect((await purger.removeFromRelay(target, crypto.randomUUID())).state).toBe("failed");
  driver.remaining = async () => [];
  expect((await purger.removeFromRelay(target, crypto.randomUUID())).state).toBe("verified");
  expect(states).toEqual(["failed", "verified"]);
});

test("loss of admission while indexing stops all subsequent external effects", async () => {
  const controller = new AbortController(), states: string[] = [];
  let deletes = 0, queries = 0;
  const index = {
    async start() { return 4; },
    async ids() { controller.abort(); return ["d".repeat(64)]; },
    async finish(_id: string, state: string) { states.push(state); },
  };
  const driver = {
    async barrier<T>(work: (signal?: AbortSignal) => Promise<T>) { return work(controller.signal); },
    async delete() { deletes++; },
    async remaining() { queries++; return []; },
  };
  expect((await new RelayPurger(index, driver).removeFromRelay(target, crypto.randomUUID())).state).toBe("failed");
  expect(deletes).toBe(0); expect(queries).toBe(0); expect(states).toEqual(["failed"]);
});

test("a failed bounded-session commit cannot report verified", async () => {
  const states: string[] = [];
  const index: RemovalIndex = {
    async start() { return 4; }, async ids() { return []; },
    async finish(_id: string, state: string) { states.push(state); },
    async underBarrier<T>(driver: PurgeDriver, work: (index: RemovalIndex) => Promise<T>): Promise<T> {
      await driver.barrier(() => work(index));
      throw new Error("commit canceled");
    },
  };
  const driver = { async barrier<T>(work: () => Promise<T>) { return work(); }, async delete() {}, async remaining() { return []; } };
  expect((await new RelayPurger(index, driver).removeFromRelay(target, crypto.randomUUID())).state).toBe("failed");
  expect(states).toEqual(["verified", "failed"]);
});
