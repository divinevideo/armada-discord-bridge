import { describe, expect, it } from "bun:test";

import { claimCodeDigest, digest, seal, unseal } from "./seal";

const KEY = "ab".repeat(32);

describe("seal/unseal", () => {
  it("round-trips", () => {
    const sealed = seal(KEY, "nsec1secret");
    expect(unseal(KEY, sealed)).toBe("nsec1secret");
  });

  it("produces distinct ciphertexts per call (fresh IV)", () => {
    expect(Buffer.compare(seal(KEY, "x"), seal(KEY, "x"))).not.toBe(0);
  });

  it("rejects tampering and wrong keys", () => {
    const sealed = seal(KEY, "payload");
    sealed[sealed.length - 1] ^= 1;
    expect(() => unseal(KEY, sealed)).toThrow();
    expect(() => unseal("cd".repeat(32), seal(KEY, "payload"))).toThrow();
    expect(() => seal("short", "x")).toThrow(/PORTAL_SEAL_KEY/);
  });
});

describe("digest", () => {
  it("is deterministic, so an equality lookup still finds the row", () => {
    expect(digest(KEY, "claim-code", "abc")).toBe(digest(KEY, "claim-code", "abc"));
  });

  it("separates labels, keys, and values", () => {
    expect(digest(KEY, "claim-code", "abc")).not.toBe(digest(KEY, "other", "abc"));
    expect(digest(KEY, "claim-code", "abc")).not.toBe(digest("cd".repeat(32), "claim-code", "abc"));
    expect(digest(KEY, "claim-code", "abc")).not.toBe(digest(KEY, "claim-code", "abd"));
    // The separator is not smearable: ("a", "b:c") must not collide with
    // ("a:b", "c").
    expect(digest(KEY, "a", "b:c")).not.toBe(digest(KEY, "a:b", "c"));
  });

  it("hides the code: nothing recoverable, nothing guessable without the key", () => {
    const stored = claimCodeDigest(KEY, "0a1b2c3d");
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain("0a1b2c3d");
  });

  it("normalises the code the way the bot and the form present it", () => {
    expect(claimCodeDigest(KEY, " 0A1B2C3D ")).toBe(claimCodeDigest(KEY, "0a1b2c3d"));
  });
});
