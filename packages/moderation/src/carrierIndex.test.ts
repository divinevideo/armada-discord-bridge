import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { wrapSeal } from "@armada-bridge/concord-core";
import { refreshPolicy, relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { CarrierIndex } from "./carrierIndex";
import { RelayPurger, type PurgeDriver } from "./relayPurge";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const f = await relayFixture();
const store = new PolicyStore(sql);
const target = { communityId: f.policy.communityId, channelId: f.channelId, rumorId: f.allowedRumorId };
const decision = crypto.randomUUID();
beforeAll(async () => { await migrateModeration(sql); await store.install(refreshPolicy(f.policy), [f.chatStream, f.controlStream, f.guestbookStream], 0); });
afterAll(async () => { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${target.communityId}`; await sql.end(); });
test("indexes every wrapper and persists removal through restart and retry", async () => {
  const second = wrapSeal(f.allowedSeal, f.chatKey);
  expect((await store.admit(f.allowed)).action).toBe("accept");
  expect((await store.admit(second)).action).toBe("accept");
  const index = new CarrierIndex(sql);
  expect(await index.ids(target)).toEqual([f.allowed.id, second.id].sort());
  await index.start(target, decision);
  expect((await new PolicyStore(sql).admit(wrapSeal(f.allowedSeal, f.chatKey))).action).toBe("reject");
  await new CarrierIndex(sql).start(target, decision);
  await index.finish(decision, "verified");
  const [row] = await sql`SELECT state, attempts FROM moderation.removals WHERE decision_id = ${decision}`;
  expect(row.state).toBe("verified"); expect(row.attempts).toBe(2);
  await expect(index.start({ ...target, rumorId: "f".repeat(64) }, decision)).rejects.toThrow(/conflict/i);
});

test("blocked carrier scans cancel in SQL and settle before releasing admission", async () => {
  const index = new CarrierIndex(sql), decisionId = crypto.randomUUID();
  const blocker = await sql.reserve();
  let released = false, deleted = 0, verified = 0;
  const driver: PurgeDriver = {
    async barrier(work) {
      await blocker`BEGIN`;
      await blocker`LOCK TABLE moderation.carriers IN ACCESS EXCLUSIVE MODE`;
      try { return await work(); }
      finally {
        // underBarrier must have observed cancellation and rolled back already.
        await blocker`ROLLBACK`;
        released = true;
      }
    },
    async delete() { deleted++; },
    async remaining() { verified++; return []; },
  };
  try {
    const before = Date.now();
    const result = await new RelayPurger(index, driver).removeFromRelay(target, decisionId);
    expect(Date.now() - before).toBeLessThan(4000);
    expect(result).toMatchObject({ state: "failed", stage: "index", carrierIds: [] });
    expect(released).toBe(true);
    expect(deleted).toBe(0); expect(verified).toBe(0);
    const [row] = await sql`SELECT state, verified_at FROM moderation.removals WHERE decision_id = ${decisionId}`;
    expect(row.state).toBe("failed"); expect(row.verified_at).toBeNull();
    expect((await store.admit(f.allowed)).action).toBe("reject");
  } finally { blocker.release(); }
});

test("a blocked success record is canceled and cannot become verified after barrier release", async () => {
  const index = new CarrierIndex(sql), decisionId = crypto.randomUUID();
  await index.start(target, decisionId);
  const blocker = await sql.reserve();
  let barrierReleased = false, reachedAfterUpdate = false;
  await blocker`BEGIN`;
  await blocker`SELECT decision_id FROM moderation.removals WHERE decision_id = ${decisionId} FOR UPDATE`;
  const driver: PurgeDriver = {
    async barrier(work) { try { return await work(); } finally { barrierReleased = true; } },
    async delete() { throw new Error("not called"); },
    async remaining() { throw new Error("not called"); },
  };
  try {
    let error: unknown;
    try {
      await index.underBarrier(driver, async (bounded) => {
        await bounded.finish(decisionId, "verified");
        reachedAfterUpdate = true;
      });
    } catch (caught) { error = caught; }
    // These are server cancellation/lock-timeout codes, not a JS-only deadline.
    expect(["57014", "55P03"]).toContain((error as { code?: string })?.code ?? "");
    expect(barrierReleased).toBe(true); expect(reachedAfterUpdate).toBe(false);
  } finally { await blocker`ROLLBACK`; blocker.release(); }
  const [row] = await sql`SELECT state, verified_at FROM moderation.removals WHERE decision_id = ${decisionId}`;
  expect(row.state).toBe("pending"); expect(row.verified_at).toBeNull();
  expect(reachedAfterUpdate).toBe(false);
});

async function removalFixture(count: number) {
  const subject = { ...target, rumorId: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0") };
  const decisionId = crypto.randomUUID();
  const rows = await sql`INSERT INTO moderation.carriers (community_id, channel_id, rumor_id, event_id, author, kind, policy_revision, target_rumor_ids, targets_indexed)
    SELECT ${subject.communityId}, ${subject.channelId},
      CASE WHEN i % 2 = 0 THEN md5(i::text) || md5(i::text) ELSE ${subject.rumorId} END,
      md5(${decisionId}) || lpad(to_hex(i), 32, '0'), ${"d".repeat(64)},
      CASE WHEN i % 2 = 0 THEN 7 ELSE 9 END, 1,
      CASE WHEN i % 2 = 0 THEN ARRAY[${subject.rumorId}]::text[] ELSE '{}'::text[] END, true
    FROM generate_series(1, ${count}::integer) AS i RETURNING event_id`;
  const ids = rows.map(row => row.event_id as string).sort();
  return { subject, decisionId, ids, live: new Set([...ids, "f".repeat(64)]) };
}

test("removal deletes and verifies 257 message and reaction carriers in bounded batches", async () => {
  const { subject, decisionId, ids, live } = await removalFixture(257);
  const batches: number[] = [], verified: number[] = [];
  const driver: PurgeDriver = {
    async barrier(work) { return work(); },
    async delete(batch) {
      expect(batch.length).toBeLessThanOrEqual(128);
      batches.push(batch.length);
      for (const id of batch) live.delete(id);
    },
    async remaining(batch) { verified.push(batch.length); return batch.filter(id => live.has(id)); },
  };
  const result = await new RelayPurger(new CarrierIndex(sql), driver).removeFromRelay(subject, decisionId);
  expect(result).toMatchObject({ state: "verified", stage: "complete", removedCount: 257 });
  expect(batches).toEqual([128, 128, 1]); expect(verified).toEqual([128, 128, 1]);
  expect([...live]).toEqual(["f".repeat(64)]);
  // Keep the index for evidence and restore reconciliation after relay deletion.
  expect(await new CarrierIndex(sql).ids(subject)).toEqual(ids);
  const [row] = await sql`SELECT state, verified_at, verified_through FROM moderation.removals WHERE decision_id = ${decisionId}`;
  expect(row.state).toBe("verified"); expect(row.verified_at).not.toBeNull();
  expect(row.verified_through).toBe(ids[256]);
});

test("a new purger resumes from committed verified progress after a later batch fails", async () => {
  const { subject, decisionId, ids, live } = await removalFixture(257);
  let calls = 0;
  const driver: PurgeDriver = {
    async barrier(work) { return work(); },
    async delete(batch) {
      if (++calls === 2) throw new Error("Synthetic interrupted deletion");
      for (const id of batch) live.delete(id);
    },
    async remaining(batch) { return batch.filter(id => live.has(id)); },
  };
  const first = await new RelayPurger(new CarrierIndex(sql), driver).removeFromRelay(subject, decisionId);
  expect(first).toMatchObject({ state: "failed", stage: "delete", removedCount: 128 });
  const [progress] = await sql`SELECT state, verified_through FROM moderation.removals WHERE decision_id = ${decisionId}`;
  expect(progress.state).toBe("failed"); expect(progress.verified_through).toBe(ids[127]);
  const retried: string[] = [];
  driver.delete = async batch => { retried.push(...batch); for (const id of batch) live.delete(id); };
  expect((await new RelayPurger(new CarrierIndex(sql), driver).removeFromRelay(subject, decisionId)).state).toBe("verified");
  expect(retried).toEqual(ids.slice(128));
  expect([...live]).toEqual(["f".repeat(64)]);
  const [tombstone] = await sql`SELECT 1 FROM moderation.tombstones WHERE community_id = ${subject.communityId} AND channel_id = ${subject.channelId} AND rumor_id = ${subject.rumorId}`;
  expect(tombstone).toBeDefined();
});

test("a batch that remains on the relay never advances retry progress", async () => {
  const { subject, decisionId, ids, live } = await removalFixture(129);
  const driver: PurgeDriver = {
    async barrier(work) { return work(); },
    async delete() {},
    async remaining(batch) { return batch.filter(id => live.has(id)); },
  };
  expect(await new RelayPurger(new CarrierIndex(sql), driver).removeFromRelay(subject, decisionId)).toMatchObject({ state: "failed", stage: "carriers_remain" });
  const [progress] = await sql`SELECT state, verified_through FROM moderation.removals WHERE decision_id = ${decisionId}`;
  expect(progress.state).toBe("failed"); expect(progress.verified_through).toBeNull();
  const retried: string[] = [];
  driver.delete = async batch => { retried.push(...batch); for (const id of batch) live.delete(id); };
  expect((await new RelayPurger(new CarrierIndex(sql), driver).removeFromRelay(subject, decisionId)).state).toBe("verified");
  expect(retried).toEqual(ids);
});

test("batch checkpoints preserve the original deadline and settle before releasing admission", async () => {
  const { subject, decisionId, ids, live } = await removalFixture(257);
  const now = Date.now, started = now();
  let verified = 0, released = false;
  const driver: PurgeDriver = {
    async barrier(work) { try { return await work(); } finally { released = true; } },
    async delete(batch) { for (const id of batch) live.delete(id); },
    async remaining(batch) {
      const remaining = batch.filter(id => live.has(id));
      const elapsed = ++verified === 1 ? 20_000 : 31_000;
      Date.now = () => started + elapsed;
      return remaining;
    },
  };
  try {
    expect(await new RelayPurger(new CarrierIndex(sql), driver).removeFromRelay(subject, decisionId)).toMatchObject({ state: "failed", stage: "checkpoint", removedCount: 128 });
  } finally { Date.now = now; }
  expect(released).toBe(true);
  const [progress] = await sql`SELECT state, verified_at, verified_through FROM moderation.removals WHERE decision_id = ${decisionId}`;
  expect(progress.state).toBe("failed"); expect(progress.verified_at).toBeNull();
  expect(progress.verified_through).toBe(ids[127]);
});
