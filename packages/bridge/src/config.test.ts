import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { loadConfig } from "./config";

const VALID = {
  DATABASE_URL: "postgres://localhost/bridge",
  BRIDGE_MASTER_SECRET: "ab".repeat(32),
  BRIDGE_PRIMARY_KEY: "cd".repeat(32),
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of [...Object.keys(VALID), "DISCORD_TOKEN", "LOG_LEVEL"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, VALID);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loadConfig", () => {
  it("loads a valid config with defaults", () => {
    const config = loadConfig();
    expect(config.databaseUrl).toBe(VALID.DATABASE_URL);
    expect(config.discordToken).toBe("");
    expect(config.logLevel).toBe("info");
  });

  it("rejects a malformed master secret", () => {
    process.env.BRIDGE_MASTER_SECRET = "not-hex";
    expect(() => loadConfig()).toThrow(/BRIDGE_MASTER_SECRET/);
  });

  it("rejects missing required vars", () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });
});
