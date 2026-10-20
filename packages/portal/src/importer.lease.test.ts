import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate } from "@armada-bridge/bridge/src/db/migrate";
import { BridgeLeases, BridgeLeaseUnavailableError } from "@armada-bridge/bridge/src/db/leases";
import { Importer } from "./importer";
import type { PortalEnv } from "./env";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { max: 3, onnotice: () => {} });
const ids: string[] = [];
beforeAll(() => migrate(url));
afterAll(async () => {
  for (const id of ids) {
    await sql`DELETE FROM imports WHERE import_id = ${id}`;
    await sql`DELETE FROM bridge_leases WHERE resource = ${`import:${id}`}`;
  }
  await sql.end();
});

async function fixture(status = "publishing") {
  const [row] = await sql`INSERT INTO imports (owner_discord_id, discord_guild_id, status, status_detail, plan)
    VALUES ('lease-test', 'lease-test', ${status}, 'owner progress', '{}') RETURNING import_id`;
  ids.push(row.import_id);
  const importer = new Importer(sql, {} as PortalEnv, {} as never,
    undefined, undefined, undefined, undefined, undefined, 20);
  const internal = importer as unknown as {
    launch(id: string): void;
    launchHistoryOnly(id: string): void;
    runOwned(id: string): Promise<void>;
    importHistory(): Promise<void>;
  };
  return { id: row.import_id as string, importer, internal };
}

async function waitFor(check: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("import retry did not settle");
}

for (const historyOnly of [false, true]) {
  const label = historyOnly ? "history-only" : "normal";
  test(`${label}: contention preserves another owner's status, expiry resumes on the short timer`, async () => {
    const { id, importer, internal } = await fixture(historyOnly ? "history" : "wiring");
    const resource = `import:${id}`;
    const owner = (await new BridgeLeases(sql).acquire(resource))!;
    let runs = 0;
    const work = async () => {
      runs++;
      await sql`UPDATE imports SET status = 'done' WHERE import_id = ${id}`;
    };
    internal.runOwned = work;
    internal.importHistory = work;
    if (historyOnly) internal.launchHistoryOnly(id); else internal.launch(id);
    await Bun.sleep(70); // several contention retries, not just the first catch
    const [held] = await sql`SELECT status, status_detail FROM imports WHERE import_id = ${id}`;
    expect(held.status).toBe(historyOnly ? "history" : "wiring");
    expect(held.status_detail).toBe("owner progress");
    expect(runs).toBe(0);
    await sql`UPDATE bridge_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE resource = ${resource}`;
    await waitFor(async () => {
      const [row] = await sql`SELECT status FROM imports WHERE import_id = ${id}`;
      return row.status === "done" && importer.activeCount === 0;
    });
    expect(runs).toBe(1);
    await owner.release();
  });

  for (const terminal of [false, true]) {
    test(`${label}: ${terminal ? "terminal lease loss" : "error racing expiry"} cannot overwrite a successor`, async () => {
      const { id, importer, internal } = await fixture(historyOnly ? "history" : "publishing");
      let successor: Awaited<ReturnType<BridgeLeases["acquire"]>>;
      let runs = 0;
      const work = async () => {
        runs++;
        const resource = `import:${id}`;
        await sql`UPDATE bridge_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE resource = ${resource}`;
        successor = await new BridgeLeases(sql).acquire(resource);
        await sql`UPDATE imports SET status = 'done', status_detail = 'successor done' WHERE import_id = ${id}`;
        if (terminal) throw new BridgeLeaseUnavailableError("superseded");
        throw new Error("late pipeline failure");
      };
      internal.runOwned = work;
      internal.importHistory = work;
      if (historyOnly) internal.launchHistoryOnly(id); else internal.launch(id);
      await waitFor(async () => !!successor && importer.activeCount === 0);
      await successor!.release();
      await Bun.sleep(70); // retry sees done and must not run the pipeline again
      const [row] = await sql`SELECT status, status_detail FROM imports WHERE import_id = ${id}`;
      expect(row.status).toBe("done");
      expect(row.status_detail).toBe("successor done");
      expect(runs).toBe(1);
    });
  }
}

test("an owned pipeline failure records failed before releasing its lease", async () => {
  const { id, importer, internal } = await fixture();
  internal.runOwned = async () => { throw new Error("owned failure"); };
  internal.launch(id);
  await waitFor(async () => {
    const [row] = await sql`SELECT status, status_detail FROM imports WHERE import_id = ${id}`;
    return row.status === "failed" && row.status_detail === "Error: owned failure" && importer.activeCount === 0;
  });
});
