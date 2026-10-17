import { expect, test } from "bun:test";
import type postgres from "postgres";
import { BridgeLeaseUnavailableError, type BridgeLease } from "@armada-bridge/bridge/src/db/leases";
import type { PortalEnv } from "./env";
import { BridgeManager } from "./manager";

function fixture() {
  const row = {
    bridge_id: "lease-recovery", status: "active", discord_guild_id: "guild", discord_channel_id: "channel",
    invite_url_sealed: new Uint8Array([1]), master_secret_sealed: new Uint8Array([1]), primary_sk_sealed: new Uint8Array([1]),
    options: {},
  };
  let down = false;
  let expired = false;
  let token = 0;
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (down) throw new Error("database unavailable");
    const query = parts.join("?");
    if (query.includes("INSERT INTO bridge_leases")) { token++; expired = false; return [{ token: String(token) }]; }
    if (query.includes("UPDATE bridge_leases")) return expired ? [] : [{ resource: "channel" }];
    if (query.includes("SELECT 1 FROM bridge_leases")) return expired ? [] : [{}];
    if (query.includes("SELECT * FROM bridges")) return [row];
    if (query.includes("UPDATE bridges SET status =")) row.status = values[0] as string;
    return [];
  }) as unknown as postgres.Sql;
  const manager = new BridgeManager(sql, {} as PortalEnv, { assertPublicChannel: async () => {} });
  // Only relay/gateway construction is replaced: acquisition, terminal callback,
  // same-instance cleanup, durable status and retry dispatch are production code.
  const internal = manager as any;
  internal.adapter = {};
  const retries = new Set<string>();
  internal.scheduleStartRetry = (id: string) => { retries.add(id); };
  let chatsClosed = 0, controlClosed = 0, poolsClosed = 0;
  const register = (lease: BridgeLease) => {
    const rb = {
      id: row.bridge_id, lease, link: { discordChannelId: row.discord_channel_id }, router: {},
      unsubChat: () => { chatsClosed++; }, unsubControl: () => { controlClosed++; },
      pool: { close: async () => { poolsClosed++; } },
    };
    internal.running.set(row.bridge_id, rb);
    internal.byDiscordChannel.set(row.discord_channel_id, row.bridge_id);
    return rb;
  };
  internal.startOwned = async (_row: unknown, lease: BridgeLease) => { register(lease); };
  return {
    manager, internal, row, retries, register,
    down: (value: boolean) => { down = value; }, expire: () => { expired = true; },
    closed: () => [chatsClosed, controlClosed, poolsClosed],
  };
}

test("outage beyond expiry removes the running instance and retries without pausing durable status", async () => {
  const f = fixture();
  await f.manager.startImported(f.row as never);
  const old = f.internal.running.get(f.row.bridge_id);
  f.down(true);
  await expect(old.lease.renew()).rejects.toThrow("database unavailable");
  expect(f.manager.isLive(f.row.bridge_id)).toBe(true);
  expect(f.retries.size).toBe(0);
  f.expire();
  f.down(false);
  await expect(old.lease.renew()).rejects.toThrow(/lease/i);
  // Cleanup and retry may finish after the renewal promise rejects.
  await f.internal.onLeaseLost(f.row.bridge_id, old.lease);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.closed()).toEqual([1, 1, 1]);
  expect(f.manager.isLive(f.row.bridge_id)).toBe(false);
  expect(f.row.status).toBe("active");
  expect(f.retries.has(f.row.bridge_id)).toBe(true);
  f.down(true);
  await expect(f.internal.retryStart(f.row.bridge_id, 1)).rejects.toThrow("database unavailable");
  f.down(false);
  await f.internal.retryStart(f.row.bridge_id, 2);
  const replacement = f.internal.running.get(f.row.bridge_id);
  expect(replacement.lease.token).toBeGreaterThan(old.lease.token);
  await f.internal.onLeaseLost(f.row.bridge_id, old.lease);
  expect(f.internal.running.get(f.row.bridge_id)).toBe(replacement);
  expect(f.closed()).toEqual([1, 1, 1]);
  await replacement.lease.release();
});

test("loss during startup unwinds the same instance and retries even when release storage fails", async () => {
  const f = fixture();
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let lease!: BridgeLease;
  f.internal.startOwned = async (_row: unknown, current: BridgeLease) => {
    lease = current;
    entered();
    await gate;
    f.register(current);
  };
  const starting = f.manager.startImported(f.row as never);
  await ready;
  f.expire();
  await expect(lease.assertCurrent()).rejects.toThrow(/lease/i);
  f.down(true);
  finish();
  await expect(starting).rejects.toThrow(/lease/i);
  expect(f.closed()).toEqual([1, 1, 1]);
  expect(f.manager.isLive(f.row.bridge_id)).toBe(false);
  expect(f.retries.has(f.row.bridge_id)).toBe(true);
  expect(f.row.status).toBe("active");
});

test("terminal startup failure still schedules retry when status bookkeeping fails", async () => {
  const f = fixture();
  f.internal.startOwned = async (_row: unknown, lease: BridgeLease) => {
    f.expire();
    try { await lease.assertCurrent(); } finally { f.down(true); }
  };
  await f.internal.startTracked(f.row);
  expect(f.retries.has(f.row.bridge_id)).toBe(true);
  expect(f.row.status).toBe("active");
});

test("stop closes subscriptions and sockets and writes pause despite release failure", async () => {
  const f = fixture();
  f.register({ token: 1n, assertCurrent: async () => {}, renew: async () => {}, release: async () => { throw new Error("release failed"); } });
  await f.manager.stop(f.row.bridge_id, "paused");
  expect(f.closed()).toEqual([1, 1, 1]);
  expect(f.manager.isLive(f.row.bridge_id)).toBe(false);
  expect(f.internal.byDiscordChannel.has(f.row.discord_channel_id)).toBe(false);
  expect(f.row.status).toBe("paused");
  expect(f.retries.size).toBe(0);
});

test("lease contention selects the short retry without writing another owner's detail or failure streak", async () => {
  const f = fixture();
  const calls: unknown[][] = [];
  f.internal.scheduleStartRetry = (...args: unknown[]) => { calls.push(args); };
  f.internal.start = async () => { throw new BridgeLeaseUnavailableError("other owner"); };
  await f.internal.startTracked(f.row, 20);
  expect(calls).toEqual([[f.row.bridge_id, 20, true]]);
  expect(f.row.status).toBe("active");
  expect(f.row.options).toEqual({});
});

test("lease retry stays capped at 2.5–5 seconds regardless of the attempt count", () => {
  const manager = new BridgeManager({} as postgres.Sql, {} as PortalEnv);
  const internal = manager as any;
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    delays.push(delay);
    return original(callback, 60_000);
  }) as typeof setTimeout;
  try {
    internal.scheduleStartRetry("contended", 100, true);
    internal.scheduleStartRetry("contended", 101, true); // single timer per resource
    internal.scheduleStartRetry("relay-outage", 0);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(2_500);
    expect(delays[0]).toBeLessThanOrEqual(5_000);
    expect(delays[1]).toBeGreaterThanOrEqual(150_000);
  } finally {
    globalThis.setTimeout = original;
    internal.cancelStartRetry("contended");
    internal.cancelStartRetry("relay-outage");
  }
});
