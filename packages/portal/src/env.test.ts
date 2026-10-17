import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadPortalEnv } from "./env";
const names = ["BRIDGE_MODE", "BRIDGE_PUBLIC_CHANNELS", "BRIDGE_COMMUNITY_ID", "BRIDGE_MASTER_SECRET", "PORTAL_SEAL_KEY", "DATABASE_URL", "PORTAL_DEV_LOGIN"];
let saved: Array<string | undefined>;
beforeEach(() => { saved = names.map(n => process.env[n]); for (const n of names) delete process.env[n]; process.env.PORTAL_SEAL_KEY = "ab".repeat(32); process.env.DATABASE_URL = "postgres://localhost/synthetic"; });
afterEach(() => { names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; }); });
test("existing portal environment loads without public pilot configuration", () => {
  expect(() => loadPortalEnv()).not.toThrow();
});
test("explicit public deployment requires its public channel configuration", () => {
  process.env.BRIDGE_MODE = "public";
  expect(() => loadPortalEnv()).toThrow(/BRIDGE_PUBLIC_CHANNELS/);
});

test("public portal binds its provisioned root to one configured community and guild", () => {
  const rules = { guildId: "100000000000000001", channelIds: ["100000000000000002"], excludedCategoryIds: ["100000000000000003"] };
  Object.assign(process.env, { BRIDGE_MODE: "public", BRIDGE_PUBLIC_CHANNELS: JSON.stringify(rules), BRIDGE_MASTER_SECRET: "cd".repeat(32), BRIDGE_COMMUNITY_ID: "ef".repeat(32) });
  expect(loadPortalEnv().puppetMaster).toEqual({ guildId: rules.guildId, communityId: "ef".repeat(32), key: "cd".repeat(32) });
  delete process.env.BRIDGE_COMMUNITY_ID;
  expect(() => loadPortalEnv()).toThrow(/provisioned puppet scope/);
});
