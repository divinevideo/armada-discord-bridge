import { describe, expect, it } from "bun:test";
import { PublicChannelPolicy, parsePublicChannelRules } from "./publicChannelPolicy";
import { DiscordReadScheduler } from "./rateAwareRead";

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

describe("fresh batch authorization", () => {
  it("does not publish when the retried snapshot reports revocation after a 429", async () => {
    let now = 0;
    let limited = true;
    let effects = 0;
    const paths: string[] = [];
    const lane = new DiscordReadScheduler(async (path) => {
      paths.push(path);
      if (limited) {
        limited = false;
        return Response.json({ retry_after: 0.01 }, { status: 429 });
      }
      return Response.json(path.endsWith("/roles")
        ? [{ id: GUILD, permissions: "1024" }]
        : [{ id: CHANNEL, guild_id: GUILD, type: 0, parent_id: null, permission_overwrites: [{ id: GUILD, type: 0, deny: "1024", allow: "0" }] }]);
    }, { now: () => now, sleep: async (ms) => { now += ms; } });
    const policy = new PublicChannelPolicy(rules, (path) => lane.get(path));
    const publish = async () => { await policy.assertPublicChannels(GUILD, [CHANNEL]); effects++; };
    await expect(publish()).rejects.toThrow("not public");
    expect(effects).toBe(0);
    expect(paths).toEqual([`/guilds/${GUILD}/channels`, `/guilds/${GUILD}/channels`, `/guilds/${GUILD}/roles`]);
    expect(now).toBe(10);
  });

  const ids = Array.from({ length: 100 }, (_, i) => String(200000000000000000n + BigInt(i)));
  function batchHarness() {
    const paths: string[] = [];
    const channels = ids.map((id) => ({ id, guild_id: GUILD, type: 0, parent_id: CATEGORY, permission_overwrites: [] as unknown[] }));
    const parent = { id: CATEGORY, guild_id: GUILD, type: 4, name: "Community", permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: "1024" }] };
    const roles = [{ id: GUILD, permissions: "1024" }];
    const policy = new PublicChannelPolicy({ ...rules, channelIds: ids }, async (path) => {
      paths.push(path);
      if (path === `/guilds/${GUILD}/channels`) return [...channels, parent];
      if (path === `/guilds/${GUILD}/roles`) return roles;
      throw new Error("unexpected route");
    });
    return { policy, paths, channels, parent, roles };
  }

  it("makes two fresh requests per effect for 100 selected channels", async () => {
    const h = batchHarness();
    for (let effect = 0; effect < 20; effect++) await h.policy.assertPublicChannels(GUILD, ids);
    expect(h.paths).toEqual(Array.from({ length: 20 }, () => [`/guilds/${GUILD}/channels`, `/guilds/${GUILD}/roles`]).flat());
  });

  it("blocks the next effect when any selected channel loses visibility", async () => {
    const h = batchHarness();
    let effects = 0;
    const publish = async () => { await h.policy.assertPublicChannels(GUILD, ids); effects++; };
    await publish();
    h.channels[99].permission_overwrites = [{ id: GUILD, type: 0, allow: "0", deny: "1024" }];
    await expect(publish()).rejects.toThrow("not public");
    expect(effects).toBe(1);
    expect(h.paths).toHaveLength(4);
  });

  it("checks fresh guild roles and category names without inheriting category overwrites", async () => {
    const h = batchHarness();
    await h.policy.assertPublicChannels(GUILD, ids);
    h.roles[0].permissions = "0";
    await expect(h.policy.assertPublicChannels(GUILD, ids)).rejects.toThrow("not public");
    h.roles[0].permissions = "1024";
    h.parent.name = " Tickets ";
    await expect(h.policy.assertPublicChannels(GUILD, ids)).rejects.toThrow("excluded category");
  });

  it("preserves excluded IDs and rejects missing, duplicate, cross-guild or non-text channels", async () => {
    const excluded = batchHarness();
    excluded.channels[0].parent_id = TICKETS;
    await expect(excluded.policy.assertPublicChannels(GUILD, ids)).rejects.toThrow("excluded category");
    const missing = batchHarness(); missing.channels.pop();
    await expect(missing.policy.assertPublicChannels(GUILD, ids)).rejects.toThrow();
    const duplicate = batchHarness(); duplicate.channels.push(duplicate.channels[0]);
    await expect(duplicate.policy.assertPublicChannels(GUILD, ids)).rejects.toThrow();
    const foreign = batchHarness(); foreign.channels[0].guild_id = TICKETS;
    await expect(foreign.policy.assertPublicChannels(GUILD, ids)).rejects.toThrow();
    const thread = batchHarness(); thread.channels[0].type = 11;
    await expect(thread.policy.assertPublicChannels(GUILD, ids)).rejects.toThrow();
  });

  it("binds omitted guild IDs to the authenticated guild-list route", async () => {
    const policy = new PublicChannelPolicy(rules, async (path) => path.endsWith("/roles")
      ? [{ id: GUILD, permissions: "1024" }]
      : [
        { id: CHANNEL, type: 0, parent_id: CATEGORY, permission_overwrites: [] },
        { id: CATEGORY, type: 4, name: "Community" },
      ]);
    await expect(policy.assertPublicChannels(GUILD, [CHANNEL])).resolves.toBeUndefined();
  });
});
