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
