import { describe, expect, it } from "bun:test";
import {
  bytesToHex,
  channelGroupKey,
  mintCommunity,
  openWrap,
  voiceGroupKey,
  voiceMediaKey,
} from "@armada-bridge/concord-core";
import type { ChannelV2, OpenedChat } from "@armada-bridge/concord-core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import type { NostrFilter } from "@nostrify/nostrify";

import { ConcordClient, hasProxyTag } from "./concord/client";
import type { RelayLike } from "./concord/pool";
import { localIdentity } from "./concord/signer";
import { PuppetCache } from "./puppets";
import { BridgeRouter, MemoryMappingStore, fallbackProfile } from "./router";
import type { ChannelLink, DiscordInboundMessage } from "./router";

const MASTER = "ab".repeat(32);

class FakePool implements RelayLike {
  published: NostrEvent[] = [];
  async query(): Promise<NostrEvent[]> {
    return [];
  }
  async publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
  }
  subscribe(_filters: NostrFilter[], _handlers: { onEvent: (e: NostrEvent) => void }): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

class FakeWebhooks {
  sent: Array<{ username: string; content: string; embeds?: Array<{ description: string }> }> = [];
  deleted: string[] = [];
  reactions: Array<{ messageId: string; emoji: string }> = [];
  private seq = 9000;
  async send(
    _link: ChannelLink,
    message: { username: string; content: string; embeds?: Array<{ description: string }> },
  ): Promise<string> {
    this.sent.push(message);
    return String(this.seq++);
  }
  async delete(_link: ChannelLink, discordMessageId: string): Promise<void> {
    this.deleted.push(discordMessageId);
  }
  async react(_link: ChannelLink, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ messageId, emoji });
  }
}

function harness() {
  const ownerSk = generateSecretKey();
  const { community } = mintCommunity("Test", getPublicKey(ownerSk), ["wss://relay.example"]);
  const channelId = new Uint8Array(32).fill(7);
  const group = channelGroupKey(community.root, channelId, 0);
  const stream = { epoch: 0n, group };
  const channel: ChannelV2 = {
    id: channelId,
    idHex: bytesToHex(channelId),
    name: "general",
    isPrivate: false,
    voice: { room: voiceGroupKey(community.root, channelId, 0), mediaKey: voiceMediaKey(community.root, channelId, 0) },
    streams: [stream],
    current: stream,
  };
  const pool = new FakePool();
  const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
  // Pin the channel so the router resolves it without a control fold.
  client.channel = (idHex: string) => (idHex === channel.idHex ? channel : undefined);

  const puppets = new PuppetCache(MASTER);
  const store = new MemoryMappingStore();
  const webhooks = new FakeWebhooks();
  const link: ChannelLink = {
    discordGuildId: "g1",
    discordChannelId: "c1",
    communityId: community.idHex,
    concordChannelIdHex: channel.idHex,
    enabled: true,
  };
  const router = new BridgeRouter(client, puppets, store, webhooks, {
    resolve: async (pk: string) => fallbackProfile(pk),
  }, { applicationId: "app1", webhookIds: new Set(["wh1"]) });

  return { community, channel, pool, client, puppets, store, webhooks, link, router };
}

function discordMsg(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    id: "111222333",
    channelId: "c1",
    guildId: "g1",
    author: { id: "80351110224678912", display: "mk", bot: false },
    content: "hello armada",
    ...overrides,
  };
}

function concordChat(overrides: Partial<OpenedChat> = {}): OpenedChat {
  return {
    rumorId: "r".repeat(64),
    author: "f".repeat(64),
    kind: 9,
    content: "hello discord",
    tags: [],
    ms: Date.now(),
    createdAt: Math.floor(Date.now() / 1000),
    wrapId: "w".repeat(64),
    streamPk: "s".repeat(64),
    sealKind: 20013,
    seal: {} as OpenedChat["seal"],
    ...overrides,
  } as OpenedChat;
}

describe("BridgeRouter: Discord -> Concord", () => {
  it("bridges a message as a puppet-signed rumor with proxy tag and mapping", async () => {
    const { router, pool, store, channel, puppets, link } = harness();
    const rumorId = await router.onDiscordMessage(discordMsg(), link);

    expect(rumorId).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059);
    expect(wraps).toHaveLength(1);
    const opened = openWrap(wraps[0], channel.current.group);
    expect(opened.content).toBe("hello armada");
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(hasProxyTag(opened)).toBe(true);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      discordMessageId: "111222333",
      concordRumorId: rumorId,
      origin: "discord",
    });
  });

  it("skips own webhooks, own application, other bots, and disabled links", async () => {
    const { router, pool, link } = harness();
    expect(await router.onDiscordMessage(discordMsg({ webhookId: "wh1" }), link)).toBeUndefined();
    expect(await router.onDiscordMessage(discordMsg({ applicationId: "app1" }), link)).toBeUndefined();
    expect(
      await router.onDiscordMessage(
        discordMsg({ author: { id: "1", display: "bot", bot: true } }),
        link,
      ),
    ).toBeUndefined();
    expect(
      await router.onDiscordMessage(discordMsg(), { ...link, enabled: false }),
    ).toBeUndefined();
    expect(pool.published).toHaveLength(0);
  });

  it("publishes the puppet's kind 0 once, refreshing when identity changes", async () => {
    const { router, pool, puppets, link } = harness();
    await router.onDiscordMessage(discordMsg({ id: "1" }), link);
    await router.onDiscordMessage(discordMsg({ id: "2" }), link);

    const profiles = pool.published.filter((e) => e.kind === 0);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].pubkey).toBe(puppets.get("80351110224678912").pk);
    expect(JSON.parse(profiles[0].content)).toMatchObject({ name: "mk" });

    await router.onDiscordMessage(
      discordMsg({ id: "3", author: { id: "80351110224678912", display: "mk (afk)", bot: false } }),
      link,
    );
    const updated = pool.published.filter((e) => e.kind === 0);
    expect(updated).toHaveLength(2);
    expect(JSON.parse(updated[1].content)).toMatchObject({ name: "mk (afk)" });
  });

  it("transforms mentions, emoji, and attachments", async () => {
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(
      discordMsg({
        content: "hey <@42> look <:blob:999>",
        mentions: [{ id: "42", display: "alice" }],
        attachments: [{ url: "https://cdn.discordapp.com/x.png" }],
      }),
      link,
    );
    const wrap = pool.published.find((e) => e.kind === 1059)!;
    const opened = openWrap(wrap, channel.current.group);
    expect(opened.content).toBe("hey @alice look :blob:\nhttps://cdn.discordapp.com/x.png");
  });
});

describe("BridgeRouter: Concord -> Discord", () => {
  it("bridges a member message through the webhook with mapping rows", async () => {
    const { router, webhooks, store, link } = harness();
    const ids = await router.onConcordChat(concordChat(), link);

    expect(ids).toHaveLength(1);
    expect(webhooks.sent[0].content).toBe("hello discord");
    expect(webhooks.sent[0].username).toContain("nostr:");
    expect(store.rows[0]).toMatchObject({ origin: "concord", partIndex: 0 });
  });

  it("splits long messages and records one mapping row per part", async () => {
    const { router, webhooks, store, link } = harness();
    const ids = await router.onConcordChat(concordChat({ content: "word ".repeat(600) }), link);
    expect(ids.length).toBeGreaterThan(1);
    expect(webhooks.sent.every((m) => m.content.length <= 2000)).toBe(true);
    expect(store.rows).toHaveLength(ids.length);
  });

  it("never echoes: proxy-tagged, puppet-authored, already-mapped, banned", async () => {
    const { router, webhooks, puppets, store, client, link } = harness();

    expect(await router.onConcordChat(concordChat({ tags: [["proxy", "1", "discord"]] }), link)).toEqual([]);

    const puppet = puppets.get("80351110224678912");
    expect(await router.onConcordChat(concordChat({ author: puppet.pk }), link)).toEqual([]);

    await store.insert({
      discordMessageId: "999",
      discordChannelId: "c1",
      concordRumorId: "m".repeat(64),
      concordChannelId: link.concordChannelIdHex,
      communityId: link.communityId,
      origin: "concord",
      authorRef: "x",
      partIndex: 0,
    });
    expect(await router.onConcordChat(concordChat({ rumorId: "m".repeat(64) }), link)).toEqual([]);

    const banned = "b".repeat(64);
    client.folded = { banned: new Set([banned]) } as unknown as typeof client.folded;
    expect(await router.onConcordChat(concordChat({ author: banned }), link)).toEqual([]);

    expect(webhooks.sent).toHaveLength(0);
  });
});

describe("BridgeRouter: replies", () => {
  it("Discord reply to a mirrored Armada message carries a q tag naming rumor and author", async () => {
    const { router, pool, store, channel, link } = harness();
    // An Armada member's message, mirrored to Discord as id 9000.
    await router.onConcordChat(concordChat(), link);
    expect(store.rows[0].discordMessageId).toBe("9000");

    await router.onDiscordMessage(
      discordMsg({ id: "2", content: "replying!", referencedMessageId: "9000" }),
      link,
    );
    const wrap = pool.published.find((e) => e.kind === 1059)!;
    const opened = openWrap(wrap, channel.current.group);
    expect(opened.tags).toContainEqual(["q", "r".repeat(64), "", "f".repeat(64)]);
  });

  it("Discord reply to a bridged Discord message names the puppet author", async () => {
    const { router, pool, store, channel, puppets, link } = harness();
    const rumorId = await router.onDiscordMessage(discordMsg({ id: "1" }), link);
    await router.onDiscordMessage(discordMsg({ id: "2", referencedMessageId: "1" }), link);

    const wraps = pool.published.filter((e) => e.kind === 1059);
    const opened = openWrap(wraps[1], channel.current.group);
    expect(opened.tags).toContainEqual(["q", rumorId!, "", puppets.get("80351110224678912").pk]);
    expect(store.rows).toHaveLength(2);
  });

  it("unmapped references degrade to a bare message", async () => {
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(discordMsg({ referencedMessageId: "404404" }), link);
    const wrap = pool.published.find((e) => e.kind === 1059)!;
    const opened = openWrap(wrap, channel.current.group);
    expect(opened.tags.some((t) => t[0] === "q")).toBe(false);
  });

  it("Concord q-tag reply renders a jump-link embed on the first part", async () => {
    const { router, webhooks, store, link } = harness();
    await store.insert({
      discordMessageId: "555",
      discordChannelId: "c1",
      concordRumorId: "t".repeat(64),
      concordChannelId: link.concordChannelIdHex,
      communityId: link.communityId,
      origin: "discord",
      authorRef: "80351110224678912",
      partIndex: 0,
    });
    await router.onConcordChat(concordChat({ tags: [["q", "t".repeat(64)]] }), link);
    expect(webhooks.sent[0].embeds).toHaveLength(1);
    expect(webhooks.sent[0].embeds![0].description).toContain("https://discord.com/channels/g1/c1/555");
  });
});

describe("BridgeRouter: deletes", () => {
  it("Discord delete of a bridged message publishes a puppet kind 5 with proxy tag", async () => {
    const { router, pool, channel, puppets, link } = harness();
    const rumorId = await router.onDiscordMessage(discordMsg(), link);
    const before = pool.published.filter((e) => e.kind === 1059).length;

    const deleteRumorId = await router.onDiscordDelete(
      { id: "111222333", channelId: "c1", guildId: "g1" },
      link,
    );
    expect(deleteRumorId).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059);
    expect(wraps).toHaveLength(before + 1);
    const opened = openWrap(wraps[wraps.length - 1], channel.current.group);
    expect(opened.kind).toBe(5);
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(opened.tags).toContainEqual(["e", rumorId!]);
    expect(hasProxyTag(opened)).toBe(true);
  });

  it("Discord delete of an Armada member's mirror stops at Discord", async () => {
    const { router, pool, link } = harness();
    await router.onConcordChat(concordChat(), link); // mirror as id 9000
    const before = pool.published.filter((e) => e.kind === 1059).length;
    expect(await router.onDiscordDelete({ id: "9000", channelId: "c1", guildId: "g1" }, link)).toBeUndefined();
    expect(pool.published.filter((e) => e.kind === 1059)).toHaveLength(before);
  });

  it("Concord kind 5 removes every mapped part for the author, ignores strangers, honors moderators", async () => {
    const { router, webhooks, link } = harness();
    const ids = await router.onConcordChat(concordChat({ content: "word ".repeat(600) }), link);
    expect(ids.length).toBeGreaterThan(1);

    // A stranger without MANAGE_MESSAGES cannot delete.
    await router.onConcordChat(
      concordChat({ rumorId: "d1".repeat(32), kind: 5, author: "a".repeat(64), content: "", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.deleted).toHaveLength(0);

    // The author can.
    await router.onConcordChat(
      concordChat({ rumorId: "d2".repeat(32), kind: 5, content: "", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.deleted).toEqual(ids);
  });

  it("Concord moderator deletes propagate", async () => {
    const { router, webhooks, client, link } = harness();
    const ids = await router.onConcordChat(concordChat(), link);
    client.isModerator = () => true;
    await router.onConcordChat(
      concordChat({ rumorId: "d3".repeat(32), kind: 5, author: "a".repeat(64), content: "", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.deleted).toEqual(ids);
  });
});

describe("BridgeRouter: reactions", () => {
  const reaction = (overrides: Record<string, unknown> = {}) => ({
    messageId: "111222333",
    channelId: "c1",
    guildId: "g1",
    emoji: { name: "🔥", id: null },
    user: { id: "80351110224678912", display: "mk", bot: false },
    ...overrides,
  });

  it("Discord reaction publishes a puppet kind 7 targeting the mapped rumor", async () => {
    const { router, pool, channel, puppets, link } = harness();
    const rumorId = await router.onDiscordMessage(discordMsg(), link);

    const reactionRumorId = await router.onDiscordReaction(reaction(), link);
    expect(reactionRumorId).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059);
    const opened = openWrap(wraps[wraps.length - 1], channel.current.group);
    expect(opened.kind).toBe(7);
    expect(opened.content).toBe("🔥");
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(opened.tags).toContainEqual(["e", rumorId!]);
    expect(opened.tags).toContainEqual(["k", "9"]);
    expect(hasProxyTag(opened)).toBe(true);
  });

  it("skips custom emoji, bots, and unmapped messages", async () => {
    const { router, pool, link } = harness();
    await router.onDiscordMessage(discordMsg(), link);
    const before = pool.published.filter((e) => e.kind === 1059).length;

    expect(await router.onDiscordReaction(reaction({ emoji: { name: "blob", id: "999" } }), link)).toBeUndefined();
    expect(
      await router.onDiscordReaction(reaction({ user: { id: "1", display: "bot", bot: true } }), link),
    ).toBeUndefined();
    expect(await router.onDiscordReaction(reaction({ messageId: "404404" }), link)).toBeUndefined();
    expect(pool.published.filter((e) => e.kind === 1059)).toHaveLength(before);
  });

  it("Concord kind 7 reacts on the mapped Discord message, mapping NIP-25 likes", async () => {
    const { router, webhooks, link } = harness();
    await router.onConcordChat(concordChat(), link); // mirror as id 9000

    await router.onConcordChat(
      concordChat({ rumorId: "e1".repeat(32), kind: 7, content: "+", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    await router.onConcordChat(
      concordChat({ rumorId: "e2".repeat(32), kind: 7, content: "🔥", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.reactions).toEqual([
      { messageId: "9000", emoji: "👍" },
      { messageId: "9000", emoji: "🔥" },
    ]);
  });

  it("skips NIP-30 shortcodes and non-emoji content", async () => {
    const { router, webhooks, link } = harness();
    await router.onConcordChat(concordChat(), link);
    await router.onConcordChat(
      concordChat({ rumorId: "e3".repeat(32), kind: 7, content: ":pepe:", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    await router.onConcordChat(
      concordChat({ rumorId: "e4".repeat(32), kind: 7, content: "lol", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.reactions).toHaveLength(0);
  });
});
