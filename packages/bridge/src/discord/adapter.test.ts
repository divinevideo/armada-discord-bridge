import { describe, expect, it } from "bun:test";

import { DiscordAdapter, isMissingPermissions, sanitizeUsername } from "./adapter";

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


describe("adapter effect authorization", () => {
  it("rechecks before the webhook retry after a rejected username", async () => {
    let allowed = true;
    let sends = 0;
    const adapter = new DiscordAdapter("synthetic", { onMessage: async () => {} }, async () => {
      if (!allowed) throw new Error("visibility denied");
    });
    const webhook = { send: async () => {
      sends++;
      allowed = false;
      throw { code: 50035, rawError: "USERNAME_INVALID" };
    } };
    (adapter as unknown as { webhookFor: () => Promise<unknown> }).webhookFor = async () => webhook;
    const link = { discordChannelId: "100000000000000002" } as never;
    await expect(adapter.send(link, { username: "test", content: "test" })).rejects.toThrow("visibility denied");
    expect(sends).toBe(1);
    await adapter.stop();
  });
});
