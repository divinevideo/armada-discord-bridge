import { describe, expect, it } from "bun:test";

import { seal, unseal } from "./seal";

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
