import { afterAll, expect, test } from "bun:test";
import postgres from "postgres";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { migrateModeration, PolicyStore } from "./policyStore";
import { createExecutionContext } from "./executionContext";
import { ConcordActions } from "./concordActions";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
afterAll(() => sql.end());
test("relay bans commit before draining writers and unban waits for verified Concord delivery", async () => {
  await migrateModeration(sql);
  const f = await moderationFixture(), store = new PolicyStore(sql);
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    let barriers = 0;
    const context = createExecutionContext({ sql, store, actions: new ConcordActions(f.community, f.moderator, async () => (await store.getPolicy(f.community.idHex))!), claim: { decision: { ...f.decision, action: "ban_member" }, target: "divine_relay", attempts: 1, token: crypto.randomUUID(), signedEvents: null }, assertCurrent: async () => {}, decisions: {} as any, relay: {} as any, discord: {} as any, purger: {} as any, driver: { barrier: async <T>(work: () => Promise<T>) => { barriers++; expect((await store.admit(f.allowed)).action).toBe("reject"); return work(); } } });
    expect(await context.setRelayBan({ ...f.decision, action: "ban_member" })).toBe(true);
    expect(barriers).toBe(1);
    expect(await context.setRelayBan({ ...f.decision, action: "unban_member" })).toBe(false);
    expect((await store.admit(f.allowed)).action).toBe("reject");
  } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`; }
});
