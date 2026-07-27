import { describe, expect, it } from "bun:test";

import { PuppetCache, derivePuppet } from "./puppets";

const MASTER = "ab".repeat(32);

describe("puppet derivation", () => {
  it("is deterministic per (master secret, discord user)", () => {
    const a = derivePuppet(MASTER, "80351110224678912");
    const b = derivePuppet(MASTER, "80351110224678912");
    expect(a.pk).toBe(b.pk);
    expect(a.sk).toEqual(b.sk);
  });

  it("differs across users and across master secrets", () => {
    const a = derivePuppet(MASTER, "80351110224678912");
    const b = derivePuppet(MASTER, "80351110224678913");
    const c = derivePuppet("cd".repeat(32), "80351110224678912");
    expect(new Set([a.pk, b.pk, c.pk]).size).toBe(3);
  });

  it("produces a valid x-only pubkey", () => {
    const { pk } = derivePuppet(MASTER, "1");
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects non-snowflake ids", () => {
    expect(() => derivePuppet(MASTER, "not-a-snowflake")).toThrow();
    expect(() => derivePuppet(MASTER, "")).toThrow();
  });
});

describe("PuppetCache", () => {
  it("caches and answers pubkey membership", () => {
    const cache = new PuppetCache(MASTER);
    const p = cache.get("80351110224678912");
    expect(cache.get("80351110224678912")).toBe(p);
    expect(cache.isPuppetPubkey(p.pk)).toBe(true);
    expect(cache.isPuppetPubkey("00".repeat(32))).toBe(false);
  });

  it("evicts oldest past the cap but stays correct", () => {
    const cache = new PuppetCache(MASTER, 2);
    const a = cache.get("1");
    cache.get("2");
    cache.get("3"); // evicts "1"
    expect(cache.isPuppetPubkey(a.pk)).toBe(false);
    // Re-derivation still returns the same key material.
    expect(cache.get("1").pk).toBe(a.pk);
  });
});
