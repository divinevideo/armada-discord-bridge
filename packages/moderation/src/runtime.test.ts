import { afterEach, expect, spyOn, test } from "bun:test";
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
// These spies replace prototypes shared by every test file in the bun process,
// so cleanup lives in afterEach, not in the test's own finally. A worker that
// rejects before the awaited hook fires, or never reaches it and times out,
// makes bun abandon the test body with its finally unrun: the mocked RelayPool,
// PolicyWatcher and ModerationWorker methods would leak into later files, which
// then pass or fail on mocks, and the worker loop would keep running.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const isolate = (stop: AbortController, mocks: { mockRestore(): void }[]) => { cleanups.push(() => { stop.abort(); for (const mock of mocks) mock.mockRestore(); }); };

for (const callback of ["disconnect", "subscription error"] as const) {
  test(`worker authority and readiness stay cleared when ${callback} races the capacity await`, async () => {
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
    isolate(stop, mocks);
    const running = startWorker(f, sql, health, stop.signal);
    try {
      await capacityEntered.promise;
      // A routine refresh keeps the last observation; only the race clears it.
      const retainedDuringRefresh = health.authority?.available === true;
      (callback === "disconnect" ? disconnect : subscriptionError)();
      expect(health.authority).toBeUndefined();
      releaseCapacity.resolve();
      await refreshReturned.promise;
      // A stale refresh publishes no readiness either: /readyz keeps the
      // disconnect's 503 rather than the pre-disconnect policy's 200.
      expect({ ready: health.ready, code: health.code, checkedAt: health.checkedAt }).toEqual({ ready: false, code: "policy_unavailable", checkedAt: 0 });
      expect(await (await workerMetricsResponse(sql, health.authority)).text()).toBe("# TYPE concord_worker_authority_available gauge\nconcord_worker_authority_available 0\n");
      expect(retainedDuringRefresh).toBe(true);
    } finally {
      releaseCapacity.resolve(); stop.abort();
      await running;
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
  isolate(stop, mocks);
  const running = startWorker(f, sql, health, stop.signal);
  try {
    const { before, after, code } = await ticked.promise;
    expect(before).toBe(true);
    expect(after).toBeUndefined();
    expect(code).toBe("ready");
  } finally {
    stop.abort();
    await running;
  }
});

// A worker whose refreshes succeed, so its first iteration publishes authority.
const greenWorker = (f: Fixture, health: WorkerHealth, stop: AbortController, hooks: { tick?: () => Promise<boolean>; restrictions?: () => Promise<void>; disconnected?: () => Promise<void> }) => {
  isolate(stop, [
    spyOn(RelayPool.prototype, "subscribe").mockReturnValue(() => {}),
    spyOn(PolicyWatcher.prototype, "refresh").mockResolvedValue(f.policy),
    spyOn(PolicyWatcher.prototype, "disconnected").mockImplementation(hooks.disconnected ?? (async () => {})),
    spyOn(PublicCapacityStore.prototype, "observeCurrent").mockResolvedValue({ state: "unknown", reasonCode: "synthetic", remainingBudget: 0 }),
    spyOn(ModerationWorker.prototype, "tick").mockImplementation(hooks.tick ?? (async () => false)),
    spyOn(DiscordRestrictionObserver.prototype, "tick").mockImplementation(hooks.restrictions ?? (async () => {})),
  ]);
  return startWorker(f, fakeSql(), health, stop.signal);
};

test("a loop failure outside refresh clears worker authority", async () => {
  const f = await moderationFixture(), stop = new AbortController();
  const health: WorkerHealth = { ready: false, code: "starting", checkedAt: 0 };
  const caught = Promise.withResolvers<{ before?: boolean; after?: boolean; code: WorkerHealth["code"] }>();
  let before: boolean | undefined;
  const running = greenWorker(f, health, stop, {
    restrictions: async () => { before = health.authority?.available; throw new Error("synthetic loop failure"); },
    // The loop's catch awaits disconnected() after clearing, so this sees its result.
    disconnected: async () => { caught.resolve({ before, after: health.authority?.available, code: health.code }); },
  });
  try {
    const observed = await caught.promise;
    expect(observed).toEqual({ before: true, after: undefined, code: "policy_unavailable" });
  } finally {
    stop.abort();
    await running;
  }
});

test("stopping the worker clears a green authority observation", async () => {
  const f = await moderationFixture(), stop = new AbortController();
  const health: WorkerHealth = { ready: false, code: "starting", checkedAt: 0 };
  const ticked = Promise.withResolvers<boolean | undefined>();
  const running = greenWorker(f, health, stop, { tick: async () => { ticked.resolve(health.authority?.available); return false; } });
  try {
    expect(await ticked.promise).toBe(true);
  } finally {
    stop.abort();
    await running;
  }
  expect(health.authority).toBeUndefined();
  expect(health.code).toBe("stopped");
});
