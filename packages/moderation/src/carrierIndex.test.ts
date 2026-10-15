import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { wrapSeal } from "@armada-bridge/concord-core";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { CarrierIndex } from "./carrierIndex";
import { RelayPurger, type PurgeDriver } from "./relayPurge";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const f = await relayFixture();
const store = new PolicyStore(sql);
const target = { communityId: f.policy.communityId, channelId: f.channelId, rumorId: f.allowedRumorId };
const decision = crypto.randomUUID();
beforeAll(async () => { await migrateModeration(sql); await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0); });
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

test("carrier overflow fails closed without partial deletion or verification", async () => {
  const overflowTarget = { ...target, rumorId: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0") };
  const decisionId = crypto.randomUUID();
  await sql`INSERT INTO moderation.carriers (community_id, channel_id, rumor_id, event_id, author, kind, policy_revision)
    SELECT ${target.communityId}, ${target.channelId}, ${overflowTarget.rumorId},
      md5(${decisionId} || i::text) || md5(i::text || ${decisionId}), ${"d".repeat(64)}, 1059, 1
    FROM generate_series(1, 129) AS i`;
  let deleted = 0, queried = 0;
  const driver: PurgeDriver = {
    async barrier(work) { return work(); },
    async delete() { deleted++; },
    async remaining() { queried++; return []; },
  };
  const result = await new RelayPurger(new CarrierIndex(sql), driver).removeFromRelay(overflowTarget, decisionId);
  expect(result).toMatchObject({ state: "failed", stage: "index", carrierIds: [] });
  expect(deleted).toBe(0); expect(queried).toBe(0);
  const [row] = await sql`SELECT state, verified_at FROM moderation.removals WHERE decision_id = ${decisionId}`;
  expect(row.state).toBe("failed"); expect(row.verified_at).toBeNull();
  const [count] = await sql`SELECT count(*) AS count FROM moderation.carriers WHERE rumor_id = ${overflowTarget.rumorId}`;
  expect(Number(count.count)).toBe(129);
});
