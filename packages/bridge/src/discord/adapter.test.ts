import { describe, expect, it } from "bun:test";

import { isMissingPermissions, sanitizeUsername } from "./adapter";

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

describe("isMissingPermissions", () => {
  it("matches Discord's 50013 and nothing else", () => {
    expect(isMissingPermissions({ code: 50013 })).toBe(true);
    expect(isMissingPermissions({ code: 50013, status: 403, rawError: { message: "Missing Permissions" } })).toBe(true);
    expect(isMissingPermissions({ code: 50035 })).toBe(false);
    expect(isMissingPermissions(new Error("boom"))).toBe(false);
    expect(isMissingPermissions(undefined)).toBe(false);
    expect(isMissingPermissions(null)).toBe(false);
  });
});
