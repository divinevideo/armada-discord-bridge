import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate } from "./migrate";
import { BridgeLeases } from "./leases";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { max: 3, onnotice: () => {} });
const prefix = `lease-test-${crypto.randomUUID()}`;
const leases = new BridgeLeases(sql);
beforeAll(() => migrate(url));
afterAll(async () => {
  await sql`DELETE FROM bridge_leases WHERE resource LIKE ${prefix + "%"}`;
  await sql.end();
});

test("only one of two workers owns the channel", async () => {
  const results = await Promise.all([leases.acquire(prefix + "race"), leases.acquire(prefix + "race")]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const lease = results.find(Boolean)!;
  await lease.assertCurrent();
  await lease.release();
});

test("expiry transfers ownership and fences the old worker, including renewal and release", async () => {
  const resource = prefix + "expiry";
  const old = (await leases.acquire(resource))!;
  await sql`UPDATE bridge_leases SET expires_at = now() - interval '1 second' WHERE resource = ${resource}`;
  const next = (await leases.acquire(resource))!;
  expect(next.token > old.token).toBe(true);
  await expect(old.assertCurrent()).rejects.toThrow(/lease/i);
  await expect(old.renew()).rejects.toThrow(/lease/i);
  await old.release();
  await next.assertCurrent();
  await next.release();
  const restarted = (await leases.acquire(resource))!;
  expect(restarted.token > next.token).toBe(true);
  await restarted.release();
});

test("unavailable storage never authorizes an effect", async () => {
  const connection = postgres(url, { max: 1 });
  const lease = (await new BridgeLeases(connection).acquire(prefix + "failure"))!;
  await connection.end();
  await expect(lease.assertCurrent()).rejects.toThrow();
  await lease.release().catch(() => {});
});
