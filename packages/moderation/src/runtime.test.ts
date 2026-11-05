import { expect, spyOn, test } from "bun:test";
import type postgres from "postgres";
import { RelayPool } from "../../bridge/src/concord/pool";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { runModerationWorker, validateWorkerCommunity, type WorkerHealth } from "./runtime";
import { PolicyWatcher } from "./policyWatcher";
import { PublicCapacityStore } from "./publicCapacity";
import { ModerationWorker } from "./worker";
import { DiscordRestrictionObserver } from "./discordRestriction";
import type { Decisions, DeliveryClaim } from "./decisions";
import type { ExecutionContext } from "./worker";
import { workerMetricsResponse } from "./workerMetrics";
test("worker provisioning rejects an owner signer and private channel material", async () => {
  const f = await moderationFixture();
  expect(() => validateWorkerCommunity(f.community, f.owner.pk, new Map([[f.community.idHex, "synthetic"]]))).toThrow();
  expect(() => validateWorkerCommunity({ ...f.community, privateChannels: [{} as any] }, f.moderator.pk, new Map([[f.community.idHex, "synthetic"]]))).toThrow();
  expect(() => validateWorkerCommunity(f.community, f.moderator.pk, new Map([[f.community.idHex, "synthetic"]]))).not.toThrow();
});

type Fixture = Awaited<ReturnType<typeof moderationFixture>>;
const fakeSql = (onQuery: (query: string) => void = () => {}) => {
  const sql = Object.assign(async (parts: TemplateStringsArray) => {
    const query = parts.join("");
    if (query.includes("pg_try_advisory_xact_lock")) return [{ owned: true }];
    onQuery(query);
    return [];
  }, { unsafe: (value: string) => value, begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql) }) as unknown as postgres.Sql;
  return sql;
};
const startWorker = (f: Fixture, sql: postgres.Sql, health: WorkerHealth, signal: AbortSignal) => {
  const communities = new Map([[f.community.idHex, "synthetic"]]);
  return runModerationWorker({ sql, community: f.community, identity: f.moderator, communities, capacity: { communities, contract: undefined }, health, signal, relayUrl: "ws://127.0.0.1:1", bridgeTenantId: "synthetic", puppetMaster: "ab".repeat(32), discordToken: "synthetic", publicChannels: { guildId: "12345678901234567", channelIds: ["12345678901234568"], excludedCategoryIds: [] }, publicAuthors: [], decisions: { expire: async () => {} } as unknown as Decisions, lifecycle: { expireEvidence: async () => {}, expireAudit: async () => {} } });
};
// These spies replace prototypes shared by every test file in the bun process.
// Restore them even when the worker rejects: an `await running` that throws
// would otherwise skip the restore and leak mocked RelayPool, PolicyWatcher and
// ModerationWorker methods into later files, which then pass or fail on mocks.
const restore = (mocks: { mockRestore(): void }[]) => { for (const mock of mocks) mock.mockRestore(); };

for (const callback of ["disconnect", "subscription error"] as const) {
  test(`worker authority stays cleared when ${callback} races the capacity await`, async () => {
    const f = await moderationFixture(), stop = new AbortController();
    const health: WorkerHealth = { ready: false, code: "starting", checkedAt: 0, authority: { available: true, validUntil: Date.now() + 30_000 } };
    const capacityEntered = Promise.withResolvers<void>(), releaseCapacity = Promise.withResolvers<void>(), refreshReturned = Promise.withResolvers<void>();
    let disconnect = () => {}, subscriptionError = () => {};
    const sql = fakeSql((query) => { if (query.includes("moderation.incoming_removals")) refreshReturned.resolve(); });
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
    const running = startWorker(f, sql, health, stop.signal);
    try {
      await capacityEntered.promise;
      // A routine refresh keeps the last observation; only the race clears it.
      const retainedDuringRefresh = health.authority?.available === true;
      (callback === "disconnect" ? disconnect : subscriptionError)();
      expect(health.authority).toBeUndefined();
      releaseCapacity.resolve();
      await refreshReturned.promise;
      expect(await (await workerMetricsResponse(sql, health.authority)).text()).toBe("concord_worker_authority_available 0\n");
      expect(retainedDuringRefresh).toBe(true);
    } finally {
      releaseCapacity.resolve(); stop.abort();
      try { await running; } finally { restore(mocks); }
    }
    expect(health.authority).toBeUndefined();
  });
}

test("a failed action-path refresh clears worker authority although the tick swallows it", async () => {
  const f = await moderationFixture(), stop = new AbortController();
  const health: WorkerHealth = { ready: false, code: "starting", checkedAt: 0 };
  const ticked = Promise.withResolvers<{ before?: boolean; after?: boolean; code: WorkerHealth["code"] }>();
  let refreshes = 0, acted = false;
  const sql = fakeSql();
  const mocks = [
    spyOn(RelayPool.prototype, "subscribe").mockReturnValue(() => {}),
    spyOn(PolicyWatcher.prototype, "refresh").mockImplementation(async () => { if (refreshes++) throw new Error("synthetic refresh failure"); return f.policy; }),
    spyOn(PolicyWatcher.prototype, "disconnected").mockResolvedValue(),
    spyOn(PublicCapacityStore.prototype, "observeCurrent").mockResolvedValue({ state: "unknown", reasonCode: "synthetic", remainingBudget: 0 }),
    // Real ticks catch every delivery failure, so the loop's own catch never
    // sees an action whose authorization refresh failed.
    spyOn(ModerationWorker.prototype, "tick").mockImplementation(async function (this: ModerationWorker) {
      if (acted) return false;
      acted = true;
      const before = health.authority?.available;
      const claim = { decision: f.decision, target: "concord", token: "synthetic", attempts: 0, signedEvents: null } as DeliveryClaim;
      const context = await (this as unknown as { context: (claim: DeliveryClaim, assertCurrent: () => Promise<void>) => Promise<ExecutionContext> }).context(claim, async () => {});
      await context.authorize(f.decision).catch(() => {});
      ticked.resolve({ before, after: health.authority?.available, code: health.code });
      return true;
    }),
    spyOn(DiscordRestrictionObserver.prototype, "tick").mockResolvedValue(),
  ];
  const running = startWorker(f, sql, health, stop.signal);
  try {
    const { before, after, code } = await ticked.promise;
    expect(before).toBe(true);
    expect(after).toBeUndefined();
    expect(code).toBe("ready");
  } finally {
    stop.abort();
    try { await running; } finally { restore(mocks); }
  }
});
