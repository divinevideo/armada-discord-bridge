import { expect, spyOn, test } from "bun:test";
import type postgres from "postgres";
import { RelayPool } from "../../bridge/src/concord/pool";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { runModerationWorker, validateWorkerCommunity, type WorkerHealth } from "./runtime";
import { PolicyWatcher } from "./policyWatcher";
import { PublicCapacityStore } from "./publicCapacity";
import { ModerationWorker } from "./worker";
import { DiscordRestrictionObserver } from "./discordRestriction";
import type { Decisions } from "./decisions";
import { workerMetricsResponse } from "./workerMetrics";
test("worker provisioning rejects an owner signer and private channel material", async () => {
  const f = await moderationFixture();
  expect(() => validateWorkerCommunity(f.community, f.owner.pk, new Map([[f.community.idHex, "synthetic"]]))).toThrow();
  expect(() => validateWorkerCommunity({ ...f.community, privateChannels: [{} as any] }, f.moderator.pk, new Map([[f.community.idHex, "synthetic"]]))).toThrow();
  expect(() => validateWorkerCommunity(f.community, f.moderator.pk, new Map([[f.community.idHex, "synthetic"]]))).not.toThrow();
});

for (const callback of ["disconnect", "subscription error"] as const) {
  test(`worker authority stays cleared when ${callback} races the capacity await`, async () => {
    const f = await moderationFixture(), stop = new AbortController();
    const health: WorkerHealth = { ready: false, code: "starting", checkedAt: 0, authority: { available: true, validUntil: Date.now() + 30_000 } };
    const capacityEntered = Promise.withResolvers<void>(), releaseCapacity = Promise.withResolvers<void>(), refreshReturned = Promise.withResolvers<void>();
    let disconnect = () => {}, subscriptionError = () => {};
    const sql = Object.assign(async (parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("pg_try_advisory_xact_lock")) return [{ owned: true }];
      if (query.includes("moderation.incoming_removals")) refreshReturned.resolve();
      return [];
    }, { unsafe: (value: string) => value, begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql) }) as unknown as postgres.Sql;
    const mocks = [
      spyOn(RelayPool.prototype, "subscribe").mockImplementation(function (this: RelayPool, _filters, handlers) {
        disconnect = () => (this as unknown as { onDisconnect: () => void }).onDisconnect();
        subscriptionError = () => handlers.onError?.("ws://127.0.0.1:1", new Error("synthetic disconnect"));
        return () => {};
      }),
      spyOn(PolicyWatcher.prototype, "refresh").mockResolvedValue(f.policy),
      spyOn(PolicyWatcher.prototype, "disconnected").mockResolvedValue(),
      spyOn(PublicCapacityStore.prototype, "observeCurrent").mockImplementation(async () => { capacityEntered.resolve(); await releaseCapacity.promise; return { state: "unknown", reasonCode: "synthetic", remainingBudget: 0 }; }),
      spyOn(ModerationWorker.prototype, "tick").mockResolvedValue(false),
      spyOn(DiscordRestrictionObserver.prototype, "tick").mockResolvedValue(),
    ];
    const communities = new Map([[f.community.idHex, "synthetic"]]);
    const running = runModerationWorker({ sql, community: f.community, identity: f.moderator, communities, capacity: { communities, contract: undefined }, health, signal: stop.signal, relayUrl: "ws://127.0.0.1:1", bridgeTenantId: "synthetic", puppetMaster: "ab".repeat(32), discordToken: "synthetic", publicChannels: { guildId: "12345678901234567", channelIds: ["12345678901234568"], excludedCategoryIds: [] }, publicAuthors: [], decisions: { expire: async () => {} } as unknown as Decisions, lifecycle: { expireEvidence: async () => {}, expireAudit: async () => {} } });
    try {
      await capacityEntered.promise;
      const clearedBeforeAsyncWork = health.authority === undefined;
      (callback === "disconnect" ? disconnect : subscriptionError)();
      expect(health.authority).toBeUndefined();
      releaseCapacity.resolve();
      await refreshReturned.promise;
      expect(await (await workerMetricsResponse(sql, health.authority)).text()).toBe("concord_worker_authority_available 0\n");
      expect(clearedBeforeAsyncWork).toBe(true);
    } finally {
      releaseCapacity.resolve(); stop.abort();
      await running;
      for (const mock of mocks) mock.mockRestore();
    }
    expect(health.authority).toBeUndefined();
  });
}
