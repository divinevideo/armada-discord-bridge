import { expect, test } from "bun:test";
import { EvidenceCipher } from "./evidence";
import { randomBytes } from "node:crypto";
test("evidence is encrypted, target-bound and bounded; absent retention blocks ingestion", () => {
  expect(() => new EvidenceCipher(randomBytes(32), 0, 4096)).toThrow();
  const cipher = new EvidenceCipher(randomBytes(32), 3600, 4096);
  const blob = cipher.seal("case-a", { content: "synthetic evidence" });
  expect(blob.includes(Buffer.from("synthetic evidence"))).toBe(false);
  expect(cipher.open("case-a", blob)).toEqual({ content: "synthetic evidence" });
  expect(() => cipher.open("case-b", blob)).toThrow();
  expect(() => cipher.open("case-a", Buffer.from(blob).fill(0, 15, 20))).toThrow();
  expect(() => cipher.seal("case-a", { content: "x".repeat(5000) })).toThrow();
});
