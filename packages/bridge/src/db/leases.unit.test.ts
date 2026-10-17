import { expect, test } from "bun:test";
import type postgres from "postgres";
import { BridgeLeases } from "./leases";

// Database time is advanced without waiting 90 seconds; every query still
// checks the same holder/token/expiry predicates as the real lease table.
function leaseStorage() {
  let now = 0;
  let expires = 0;
  let holder: unknown;
  let token = 0n;
  let outage = false;
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (outage) throw new Error("database unavailable");
    const query = parts.join("?");
    if (query.includes("INSERT INTO bridge_leases")) {
      if (expires > now) return [];
      holder = values[1];
      token++;
      expires = now + 90_000;
      return [{ token: token.toString() }];
    }
    const matches = values[1] === holder && values[2] === token.toString();
    if (query.includes("interval '90 seconds'")) {
      if (!matches || expires <= now) return [];
      expires = now + 90_000;
      return [{ resource: values[0] }];
    }
    if (query.includes("SELECT 1")) return matches && expires > now ? [{}] : [];
    if (matches) expires = now;
    return [];
  }) as unknown as postgres.Sql;
  return { sql, advance: (ms: number) => { now += ms; }, fail: (value: boolean) => { outage = value; } };
}

test("transient round trips emit nothing; outage beyond expiry emits terminal loss once", async () => {
  const db = leaseStorage();
  let losses = 0;
  const leases = new BridgeLeases(db.sql);
  const old = (await leases.acquire("channel", () => { losses++; }))!;
  db.fail(true);
  await expect(old.renew()).rejects.toThrow("database unavailable");
  await expect(old.assertCurrent()).rejects.toThrow("database unavailable");
  expect(losses).toBe(0);
  db.fail(false);
  await old.renew();
  await old.assertCurrent();
  expect(losses).toBe(0);
  db.fail(true);
  db.advance(91_000);
  db.fail(false);
  await expect(old.renew()).rejects.toThrow(/lease/i);
  expect(losses).toBe(1);
  const next = (await leases.acquire("channel"))!;
  expect(next.token).toBeGreaterThan(old.token);
  await expect(old.assertCurrent()).rejects.toThrow(/lease/i);
  await expect(old.renew()).rejects.toThrow(/lease/i);
  await old.release();
  await next.assertCurrent();
  expect(losses).toBe(1);
  await next.release();
});

test("assertCurrent confirmed loss emits once even with concurrent renewal", async () => {
  const db = leaseStorage();
  let losses = 0;
  const lease = (await new BridgeLeases(db.sql).acquire("channel", () => { losses++; }))!;
  db.advance(91_000);
  await Promise.allSettled([lease.assertCurrent(), lease.renew(), lease.assertCurrent()]);
  expect(losses).toBe(1);
  await lease.release();
  expect(losses).toBe(1);
});

test("release, including a failed release and an in-flight refused renewal, is not loss", async () => {
  const db = leaseStorage();
  let losses = 0;
  const lease = (await new BridgeLeases(db.sql).acquire("channel", () => { losses++; }))!;
  db.advance(91_000);
  const renewal = lease.renew().then(() => undefined, (error: Error) => error);
  db.fail(true);
  await expect(lease.release()).rejects.toThrow("database unavailable");
  expect((await renewal)?.message).toMatch(/lease/i);
  expect(losses).toBe(0);
});
