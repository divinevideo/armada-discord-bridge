import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyStore, migrateModeration } from "./policyStore";
const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
const fixture = await relayFixture();
const store = new PolicyStore(sql);
beforeAll(async () => { await migrateModeration(sql); });
afterAll(async () => {
  await sql`DELETE FROM moderation.community_policy WHERE community_id = ${fixture.policy.communityId}`;
  await sql.end();
});

test("persists policy and minimum carrier index before accepting", async () => {
  await store.install(fixture.policy, [fixture.chatStream, fixture.controlStream, fixture.guestbookStream], 0);
  expect((await store.admit(fixture.allowed)).action).toBe("accept");
  const rows = await sql`SELECT * FROM moderation.carriers WHERE event_id = ${fixture.allowed.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0].author).toBe(fixture.member.pk);
  expect(JSON.stringify(rows)).not.toContain("Synthetic relay message");
  expect((await store.admit(fixture.banned)).action).toBe("reject");
});

test("durable bans survive new store instances and reject stale installations", async () => {
  const revision = await store.setBan(fixture.policy.communityId, fixture.member.pk, true);
  expect(revision).toBe(2);
  expect((await new PolicyStore(sql).admit(fixture.allowed)).action).toBe("reject");
  await expect(store.install(fixture.policy, [fixture.chatStream, fixture.controlStream, fixture.guestbookStream], 0)).rejects.toThrow(/revision/i);
  expect((await store.admit(fixture.allowed)).action).toBe("reject");
  await expect(store.setBan(fixture.policy.communityId, fixture.owner.pk, true)).rejects.toThrow(/owner/i);
});

test("control refresh cannot discard a relay ban awaiting protocol delivery", async () => {
  await store.install({ ...fixture.policy, revision: 3, banned: [] }, [fixture.chatStream, fixture.controlStream, fixture.guestbookStream], 2);
  expect((await store.admit(fixture.allowed)).action).toBe("reject");
});

test("a tombstone persists independently of unbanning and blocks alternative carriers", async () => {
  await store.setBan(fixture.policy.communityId, fixture.member.pk, false);
  await store.remove({ communityId: fixture.policy.communityId, channelId: fixture.channelId, rumorId: fixture.allowedRumorId });
  expect((await new PolicyStore(sql).admit(fixture.allowed)).action).toBe("reject");
});

test("unknown stream or unavailable database fails closed", async () => {
  expect((await store.admit({ ...fixture.allowed, pubkey: "ff".repeat(32) })).action).toBe("reject");
  const closed = postgres(process.env.DATABASE_URL!);
  await closed.end();
  expect((await new PolicyStore(closed).admit(fixture.allowed)).action).toBe("reject");
});

test("validator role can index admissions but cannot change policy", async () => {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE moderation_validator");
    expect((await tx`SELECT community_id FROM moderation.community_policy WHERE community_id = ${fixture.policy.communityId}`).length).toBe(1);
  });
  await expect(sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE moderation_validator");
    await tx`UPDATE moderation.community_policy SET revision = revision + 1 WHERE community_id = ${fixture.policy.communityId}`;
  })).rejects.toThrow(/permission denied/);
});

test("control disconnect immediately invalidates admissions across processes", async () => {
  const f = await relayFixture();
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    expect((await store.admit(f.allowed)).action).toBe("accept");
    expect(await store.invalidate(f.policy.communityId)).toBe(2);
    expect((await new PolicyStore(sql).admit(f.allowed)).action).toBe("reject");
    await expect(store.install({ ...f.policy, revision: 2 }, [f.chatStream, f.controlStream, f.guestbookStream], 1)).rejects.toThrow(/revision/i);
    await store.install({ ...f.policy, revision: 3 }, [f.chatStream, f.controlStream, f.guestbookStream], 2);
    expect((await store.admit(f.allowed)).action).toBe("accept");
  } finally {
    await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.policy.communityId}`;
  }
});

test("validator database role performs a full admission and carrier insert", async () => {
  const f = await relayFixture();
  const validator = postgres(process.env.DATABASE_URL!, { max: 1, connection: { options: "-c role=moderation_validator" }, onnotice: () => {} });
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    expect((await new PolicyStore(validator).admit(f.allowed)).action).toBe("accept");
    expect((await sql`SELECT event_id FROM moderation.carriers WHERE event_id = ${f.allowed.id}`).length).toBe(1);
  } finally {
    await validator.end();
    await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.policy.communityId}`;
  }
});
