import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { reconcileRestore } from "./relayRestore";
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

test("restore preserves verified historical control and rejects tombstoned chat", async () => {
  expect(await store.admitRestored(fixture.allowed)).toBe(false);
  expect(await store.admitRestored(fixture.policy.controlEvents[0])).toBe(true);
  const [row] = await sql`SELECT revision FROM moderation.community_policy WHERE community_id = ${fixture.policy.communityId}`;
  await store.assertRestoreReady({ [fixture.policy.communityId]: Number(row.revision) });
  await expect(store.assertRestoreReady({ [fixture.policy.communityId]: Number(row.revision) + 1 })).rejects.toThrow(/floor/);
});

test("restore aborts without deleting when policy expires after its initial readiness check", async () => {
  const f = await relayFixture();
  const deleted: string[] = [];
  let scanned = false;
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    const rows = await sql`SELECT community_id, revision FROM moderation.community_policy`;
    const floors = Object.fromEntries(rows.map((row) => [row.community_id, Number(row.revision)]));
    await expect(reconcileRestore(store, {
      async *scan() {
        scanned = true;
        await sql`UPDATE moderation.community_policy SET payload = payload || '{"validUntil":0}'::jsonb WHERE community_id = ${f.policy.communityId}`;
        yield f.allowed;
      },
      async delete(ids) { deleted.push(...ids); },
    }, floors)).rejects.toThrow(/Recovery policy unavailable/);
    expect(scanned).toBe(true);
    expect(deleted).toEqual([]);
    expect((await store.admit(f.allowed)).action).toBe("reject");
  } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.policy.communityId}`; }
});

test("restore propagates an admission lookup failure instead of deleting the carrier", async () => {
  const f = await relayFixture();
  const deleted: string[] = [];
  let failures = 0;
  const unavailable = new Proxy(sql, {
    get(target, property, receiver) {
      if (property === "begin") return (run: (tx: postgres.TransactionSql) => Promise<unknown>) => target.begin(async (tx) => run(new Proxy(tx, {
        apply(query, thisArg, args) {
          if (Array.isArray(args[0]) && args[0].join("?").includes("FROM moderation.tombstones")) {
            failures++;
            return Promise.reject(new Error("Synthetic admission database failure"));
          }
          return Reflect.apply(query, thisArg, args);
        },
      })));
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    const rows = await sql`SELECT community_id, revision FROM moderation.community_policy`;
    const floors = Object.fromEntries(rows.map((row) => [row.community_id, Number(row.revision)]));
    await expect(reconcileRestore(new PolicyStore(unavailable), {
      async *scan() { yield f.allowed; },
      async delete(ids) { deleted.push(...ids); },
    }, floors)).rejects.toThrow(/Synthetic admission database failure/);
    expect(failures).toBe(1);
    expect(deleted).toEqual([]);
    expect((await new PolicyStore(unavailable).admit(f.allowed)).action).toBe("reject");
    expect(failures).toBe(2);
  } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.policy.communityId}`; }
});

test("restore deletes an old public carrier after its channel is deleted or made private", async () => {
  const { buildChannelEdition, currentControlWriteGroup, hex32, openWrap, parseEdition, sealEdition } = await import("@armada-bridge/concord-core");
  for (const deleted of [false, true]) {
    const f = await relayFixture();
    try {
      await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
      expect((await store.admit(f.allowed)).action).toBe("accept");
      const head = parseEdition(openWrap(f.controlEvent, f.controlStream.key));
      const options = { actorPubkey: f.owner.pk, version: 2n, prevHash: head.selfHash };
      const rumor = buildChannelEdition(hex32(f.channelId), { name: "general", private: !deleted, ...(deleted ? { deleted: true } : {}) }, options);
      const event = await sealEdition(rumor, currentControlWriteGroup(f.community), f.owner.signer);
      await store.install({ ...f.policy, revision: 2, controlEvents: [...f.policy.controlEvents, event] }, [f.controlStream, f.guestbookStream], 1);
      expect((await store.admit(f.allowed)).action).toBe("reject");
      const rows = await sql`SELECT community_id, revision FROM moderation.community_policy`;
      const floors = Object.fromEntries(rows.map((row) => [row.community_id, Number(row.revision)]));
      const removed: string[] = [];
      expect(await reconcileRestore(store, { async *scan() { yield f.allowed; }, async delete(ids) { removed.push(...ids); } }, floors)).toEqual({ retained: 0, removed: 1 });
      expect(removed).toEqual([f.allowed.id]);
      // Unknown scope must still abort when another recovery policy goes stale.
      await sql`UPDATE moderation.community_policy SET payload = payload || '{"validUntil":0}'::jsonb WHERE community_id = ${f.policy.communityId}`;
      await expect(store.admitRestored(f.allowed)).rejects.toThrow(/Recovery policy unavailable/);
    } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.policy.communityId}`; }
  }
});

test("a verified public guestbook join permits profile bootstrap without granting moderation authority", async () => {
  const f = await relayFixture();
  const core = await import("@armada-bridge/concord-core");
  const nostr = await import("nostr-tools/pure");
  const newcomer = nostr.generateSecretKey(), pk = nostr.getPublicKey(newcomer);
  const signer = { signEvent: async (template: any) => nostr.finalizeEvent(template, newcomer) };
  const profile = await signer.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: "{}" });
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    expect((await store.admit(profile)).action).toBe("reject");
    const joined = await core.sealGuestbook(core.buildJoinRumor(pk, Date.now()), core.currentGuestbookGroup(f.community), signer);
    expect((await store.admit(joined)).action).toBe("accept");
    expect((await store.admit(profile)).action).toBe("accept");
    await store.setBan(f.community.idHex, pk, true);
    expect((await store.admit(profile)).action).toBe("reject");
  } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`; }
});
