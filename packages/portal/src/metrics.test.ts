import { afterAll, expect, test } from "bun:test";
import postgres from "postgres";
import { portalMetricsResponse } from "./metrics";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://bridge:bridge@localhost:5432/bridge", { max: 1, connect_timeout: 3, onnotice() {} });
const dbUp = await sql`SELECT 1`.then(() => true, () => false);
afterAll(() => sql.end());
test.skipIf(!dbUp)("portal metrics count only persisted paused and severed statuses with no identifying labels", async () => {
  await sql.begin(async tx => {
    await tx`CREATE TEMP TABLE bridges (status text) ON COMMIT DROP`;
    const empty = await portalMetricsResponse(tx as unknown as postgres.Sql, true, 0);
    expect(await empty.text()).toContain("# TYPE armada_bridges_paused gauge\narmada_bridges_paused 0\n# TYPE armada_bridges_severed gauge\narmada_bridges_severed 0\n");
    for (const status of ["draft", "pending_confirm", "active", "paused", "paused", "severed", "unlinked"]) await tx`INSERT INTO bridges VALUES (${status})`;
    const response = await portalMetricsResponse(tx as unknown as postgres.Sql, false, 2);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# TYPE armada_discord_connected gauge\narmada_discord_connected 0\n# TYPE armada_relay_sockets_down gauge\narmada_relay_sockets_down 2\n# TYPE armada_bridges_paused gauge\narmada_bridges_paused 2\n# TYPE armada_bridges_severed gauge\narmada_bridges_severed 1\n");
    await tx`UPDATE bridges SET status = 'active' WHERE status IN ('paused', 'severed')`;
    expect(await (await portalMetricsResponse(tx as unknown as postgres.Sql, true, 0)).text()).toContain("# TYPE armada_bridges_paused gauge\narmada_bridges_paused 0\n# TYPE armada_bridges_severed gauge\narmada_bridges_severed 0\n");
  });
});
test("portal SQL failure fails the entire scrape without leaking database details", async () => {
  const broken = (async () => { throw new Error("private database details"); }) as unknown as postgres.Sql;
  const response = await portalMetricsResponse(broken, true, 0);
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("unavailable");
});
