import { describe, expect, it } from "bun:test";

import { sanitizeUsername } from "./adapter";

describe("sanitizeUsername", () => {
  it("neutralizes forbidden substrings beyond lookalike normalization", () => {
    // Discord normalizes leetspeak, so the output must not contain the
    // forbidden words under any character-for-character substitution.
    expect(sanitizeUsername("Discord Fan")).toBe("disc-rd Fan");
    expect(sanitizeUsername("dIsCoRdIsCoRd")).toBe("disc-rdIsCoRd");
    expect(sanitizeUsername("clyde2")).toBe("cly-e2");
    expect(sanitizeUsername("mk (via discord)")).toBe("mk (via disc-rd)");
  });

  it("enforces the 2..80 length window", () => {
    expect(sanitizeUsername("x").length).toBeGreaterThanOrEqual(2);
    expect(sanitizeUsername("").length).toBeGreaterThanOrEqual(2);
    expect(sanitizeUsername("a".repeat(200)).length).toBe(80);
  });

  it("leaves ordinary names alone", () => {
    expect(sanitizeUsername("mireille")).toBe("mireille");
  });
});
