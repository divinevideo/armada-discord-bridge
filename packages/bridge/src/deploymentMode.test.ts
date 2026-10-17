import { expect, test } from "bun:test";
import { guildInScope, loadDeploymentMode } from "./deploymentMode";
const rules = { guildId: "100000000000000001", channelIds: ["100000000000000002"], excludedCategoryIds: ["100000000000000003"] };
test("ordinary deployments remain legacy and support multiple guilds", () => {
  const config = loadDeploymentMode({ BRIDGE_MASTER_SECRET: "ab".repeat(32) });
  expect(config.mode).toBe("legacy");
  expect(config.publicChannels).toBeUndefined();
  expect(guildInScope(config, "guild-a")).toBe(true);
  expect(guildInScope(config, "guild-b")).toBe(true);
});
test("public mode validates its explicit rules and refuses other guilds", () => {
  const config = loadDeploymentMode({ BRIDGE_MODE: "public", BRIDGE_PUBLIC_CHANNELS: JSON.stringify(rules) });
  expect(config.publicChannels).toEqual(rules);
  expect(guildInScope(config, rules.guildId)).toBe(true);
  expect(guildInScope(config, "100000000000000004")).toBe(false);
  expect(guildInScope({ mode: "public" }, rules.guildId)).toBe(false);
});
test("missing or malformed public configuration never downgrades", () => {
  for (const value of [undefined, "{}", "broken"]) expect(() => loadDeploymentMode({ BRIDGE_MODE: "public", BRIDGE_PUBLIC_CHANNELS: value })).toThrow(/BRIDGE_PUBLIC_CHANNELS/);
  expect(() => loadDeploymentMode({ BRIDGE_MODE: "typo" })).toThrow(/BRIDGE_MODE/);
  expect(() => loadDeploymentMode({ BRIDGE_PUBLIC_CHANNELS: JSON.stringify(rules) })).toThrow(/BRIDGE_MODE=public/);
  expect(() => loadDeploymentMode({ BRIDGE_MODE: "legacy", BRIDGE_COMMUNITY_ID: "ab".repeat(32) })).toThrow(/BRIDGE_MODE=public/);
});
