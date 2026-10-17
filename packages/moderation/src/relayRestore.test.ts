import { expect, test } from "bun:test";
import { reconcileRestore } from "./relayRestore";
test("restore checks the external policy floor before scanning and removes rejected carriers", async () => {
  const calls: string[] = [];
  const accepted = { id: "a".repeat(64) }, removed = { id: "b".repeat(64) };
  const policy = { async assertRestoreReady() { calls.push("ready"); }, async admitRestored(event: any) { return event.id === accepted.id; } };
  const driver = { async *scan() { calls.push("scan"); yield accepted as any; yield removed as any; }, async delete(ids: string[]) { calls.push("delete"); expect(ids).toEqual([removed.id]); } };
  expect(await reconcileRestore(policy, driver, { ["c".repeat(64)]: 10 })).toEqual({ retained: 1, removed: 1 });
  expect(calls).toEqual(["ready", "scan", "delete", "ready"]);
  policy.assertRestoreReady = async () => { throw new Error("Policy revision behind recovery floor"); };
  calls.length = 0;
  await expect(reconcileRestore(policy, driver, { ["c".repeat(64)]: 10 })).rejects.toThrow(/floor/);
  expect(calls).toEqual([]);
});
