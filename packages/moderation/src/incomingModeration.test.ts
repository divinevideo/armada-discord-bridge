import { afterAll, expect, test } from "bun:test";
import postgres from "postgres";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { ConcordActions } from "./concordActions";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
afterAll(() => sql.end());
test("accepted Concord bans apply to the very next raw admission before a watcher refresh", async () => {
  await migrateModeration(sql);
  const f = await moderationFixture(), store = new PolicyStore(sql);
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    const [event] = await new ConcordActions(f.community, f.moderator, async () => f.policy).prepare({ ...f.decision, action: "ban_member" });
    expect((await store.admit(event)).action).toBe("accept");
    expect((await store.admit(f.allowed)).action).toBe("reject");
  } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`; }
});
test("accepted Concord deletion queues durable removal and prevents alternate carrier replay", async () => {
  const f = await moderationFixture(), store = new PolicyStore(sql);
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    expect((await store.admit(f.allowed)).action).toBe("accept");
    const [event] = await new ConcordActions(f.community, f.moderator, async () => f.policy).prepare(f.decision);
    expect((await store.admit(event)).action).toBe("accept");
    expect((await store.admit(f.allowed)).action).toBe("reject");
    const rows = await sql`SELECT rumor_id FROM moderation.incoming_removals WHERE community_id = ${f.community.idHex}`;
    expect(rows.map((row) => row.rumor_id)).toEqual([f.allowedRumorId]);
  } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`; }
});
