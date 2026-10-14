import { describe, expect, it } from "bun:test";
import { PublicChannelPolicy, parsePublicChannelRules } from "./publicChannelPolicy";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const CATEGORY = "100000000000000003";
const TICKETS = "100000000000000004";
const rules = { guildId: GUILD, channelIds: [CHANNEL], excludedCategoryIds: [TICKETS] };
function harness() {
  let view = true;
  let category = CATEGORY;
  let name = "Community";
  let everyone = "1024";
  let allow = "0";
  let available = true;
  const paths: string[] = [];
  const policy = new PublicChannelPolicy(rules, async (path) => {
    paths.push(path);
    if (!available) throw new Error("unavailable");
    if (path === `/guilds/${GUILD}/roles`) return [{ id: GUILD, permissions: everyone }];
    if (path === `/channels/${CHANNEL}`) return { id: CHANNEL, guild_id: GUILD, type: 0, parent_id: category, permission_overwrites: [{ id: GUILD, type: 0, allow, deny: view ? "0" : "1024" }] };
    if (path === `/channels/${category}`) return { id: category, guild_id: GUILD, type: 4, name };
    throw new Error("unexpected path");
  });
  return { policy, paths, private: () => { view = false; }, move: (id: string) => { category = id; }, rename: (value: string) => { name = value; }, base: (value: string) => { everyone = value; }, grant: (value: string) => { allow = value; }, unavailable: () => { available = false; } };
}

describe("public channel policy", () => {
  it("allows an allowlisted channel visible to everyone", async () => {
    await expect(harness().policy.assertPublicChannel(GUILD, CHANNEL)).resolves.toBeUndefined();
  });
  it("checks fresh effective permissions on every call", async () => {
    const h = harness();
    await h.policy.assertPublicChannel(GUILD, CHANNEL);
    h.private();
    await expect(h.policy.assertPublicChannel(GUILD, CHANNEL)).rejects.toThrow("not public");
  });
  it("accounts for everyone channel allow overwrites", async () => {
    const h = harness(); h.base("0"); h.grant("1024");
    await expect(h.policy.assertPublicChannel(GUILD, CHANNEL)).resolves.toBeUndefined();
  });
  it("excludes Tickets by stable ID even when renamed", async () => {
    const h = harness(); h.move(TICKETS); h.rename("Other");
    await expect(h.policy.assertPublicChannel(GUILD, CHANNEL)).rejects.toThrow("excluded category");
  });
  it("also excludes a newly created Tickets category", async () => {
    const h = harness(); h.rename("Tickets");
    await expect(h.policy.assertPublicChannel(GUILD, CHANNEL)).rejects.toThrow("excluded category");
  });
  it("rejects an unapproved guild or channel without fetching", async () => {
    const h = harness();
    await expect(h.policy.assertPublicChannel(TICKETS, CHANNEL)).rejects.toThrow("not allowlisted");
    await expect(h.policy.assertPublicChannel(GUILD, TICKETS)).rejects.toThrow("not allowlisted");
    expect(h.paths).toHaveLength(0);
  });
  it("fails closed when Discord cannot establish visibility", async () => {
    const h = harness(); h.unavailable();
    await expect(h.policy.assertPublicChannel(GUILD, CHANNEL)).rejects.toThrow();
  });
  it("rejects missing or malformed rules without leaking configuration", () => {
    for (const value of [undefined, "", "null", "{}", '{"guildId":"invalid"}', JSON.stringify({ ...rules, excludedCategoryIds: [] })]) {
      expect(() => parsePublicChannelRules(value)).toThrow("BRIDGE_PUBLIC_CHANNELS");
    }
    expect(parsePublicChannelRules(JSON.stringify(rules))).toEqual(rules);
  });
  it("rejects malformed or cross-guild channel data", async () => {
    for (const data of [null, {}, { id: CHANNEL, guild_id: TICKETS, type: 0 }, { id: CHANNEL, guild_id: GUILD, type: 12 }]) {
      const policy = new PublicChannelPolicy(rules, async () => data);
      await expect(policy.assertPublicChannel(GUILD, CHANNEL)).rejects.toThrow();
    }
  });
});
