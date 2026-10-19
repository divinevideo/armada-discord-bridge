import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { refreshPolicy, relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { runPlugin } from "./strfryPlugin";
const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
beforeAll(() => migrateModeration(sql));
afterAll(() => sql.end());
test("canceled database admission rolls back control and carrier writes before the plugin rejects", async () => {
  for (const control of [false, true]) {
    const f = await relayFixture(), initial = new PolicyStore(sql);
    let resumed = false;
    const abort = new AbortController();
    const delayed = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === "begin") return (run: (tx: postgres.TransactionSql) => Promise<unknown>) => target.begin((tx) => run(new Proxy(tx, {
          apply(query, thisArg, args) {
            const pending = Reflect.apply(query, thisArg, args);
            const text = Array.isArray(args[0]) ? args[0].join("?") : "";
            if (text.includes(control ? "INSERT INTO moderation.accepted_control" : "INSERT INTO moderation.carriers")) return (async () => {
              const rows = await pending;
              abort.abort();
              resumed = true; return rows;
            })();
            return pending;
          },
        })));
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      await initial.install(refreshPolicy(f.policy), [f.chatStream, f.controlStream, f.guestbookStream], 0);
      const event = control ? f.controlEvent : f.allowed;
      const output: string[] = [];
      async function* input() { yield Buffer.from(JSON.stringify({ type: "new", event }) + "\n"); }
      await runPlugin(input(), (line) => { expect(resumed).toBe(true); output.push(line); }, (event) => new PolicyStore(delayed).admit(event, abort.signal), { timeoutMs: 10_000 });
      expect(JSON.parse(output[0]).action).toBe("reject");
      expect(await sql`SELECT 1 FROM moderation.accepted_control WHERE community_id = ${f.policy.communityId}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM moderation.carriers WHERE community_id = ${f.policy.communityId}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM moderation.observed_members WHERE community_id = ${f.policy.communityId}`).toHaveLength(0);
    } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.policy.communityId}`; }
  }
});
