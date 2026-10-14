import { expect, test } from "bun:test";
import { RelayPurger } from "./relayPurge";
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
