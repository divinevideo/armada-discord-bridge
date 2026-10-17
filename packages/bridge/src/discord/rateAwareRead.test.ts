import { expect, it } from "bun:test";
import { DiscordReadScheduler } from "./rateAwareRead";

function clock() {
  let now = 0;
  const waits: number[] = [];
  return { waits, now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } };
}

it("honors a global 429 before retrying and serializes other routes", async () => {
  const time = clock();
  const calls: Array<[string, number]> = [];
  const lane = new DiscordReadScheduler(async (path) => {
    calls.push([path, time.now()]);
    return calls.length === 1
      ? Response.json({ retry_after: 0.25, global: true }, { status: 429 })
      : Response.json([]);
  }, time);
  await Promise.all([lane.get("/channels/1"), lane.get("/guilds/2/roles")]);
  expect(calls).toEqual([["/channels/1", 0], ["/channels/1", 250], ["/guilds/2/roles", 250]]);
  expect(time.waits).toEqual([250]);
});

it("uses exhausted bucket headers to delay the next read", async () => {
  const time = clock();
  let calls = 0;
  const lane = new DiscordReadScheduler(async () => {
    calls++;
    return Response.json([], { headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.5" } });
  }, time);
  await lane.get("/a");
  await lane.get("/b");
  expect(calls).toBe(2);
  expect(time.waits).toEqual([500]);
});

it("uses Retry-After for non-JSON 429s and bounds repeated retries", async () => {
  const time = clock();
  let calls = 0;
  const lane = new DiscordReadScheduler(async () => {
    calls++;
    return new Response("limited", { status: 429, headers: { "Retry-After": "0.1" } });
  }, time);
  await expect(lane.get("/a")).rejects.toThrow("rate limit unavailable");
  expect(calls).toBe(4);
  expect(time.waits).toEqual([100, 100, 100]);
});

it("does not shorten a rate limit that exceeds the request budget", async () => {
  const time = clock();
  let calls = 0;
  const lane = new DiscordReadScheduler(async () => {
    calls++;
    return Response.json({ retry_after: 60 }, { status: 429 });
  }, time);
  await expect(lane.get("/a")).rejects.toThrow("rate limit unavailable");
  await expect(lane.get("/b")).rejects.toThrow("rate limit unavailable");
  expect(calls).toBe(1);
  expect(time.waits).toEqual([]);
});

it("bounds admission and recovers the lane after a failed read", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const lane = new DiscordReadScheduler(async () => {
    await held;
    if (++calls === 1) throw new Error("network unavailable");
    return Response.json([]);
  });
  const pending = Array.from({ length: 64 }, () => lane.get("/a"));
  const settled = Promise.allSettled(pending);
  await expect(lane.get("/overflow")).rejects.toThrow("queue full");
  release();
  const results = await settled;
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(calls).toBe(64);
  await expect(lane.get("/after")).resolves.toEqual([]);
});
