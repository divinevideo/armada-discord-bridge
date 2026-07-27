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
import { BridgeRouter, MemoryMappingStore, fallbackProfile, resolveGifVariant } from "./router";
import type { ChannelLink, DiscordInboundMessage, RouterOptions } from "./router";

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
  sent: Array<{
    username: string;
    content: string;
    embeds?: Array<{ description: string }>;
    files?: Array<{ name: string; data: Uint8Array }>;
  }> = [];
  deleted: string[] = [];
  reactions: Array<{ messageId: string; emoji: string }> = [];
  private seq = 9000;
  async send(
    _link: ChannelLink,
    message: {
      username: string;
      content: string;
      embeds?: Array<{ description: string }>;
      files?: Array<{ name: string; data: Uint8Array }>;
    },
  ): Promise<string> {
    this.sent.push(message);
    return String(this.seq++);
  }
  async delete(_link: ChannelLink, discordMessageId: string): Promise<void> {
    this.deleted.push(discordMessageId);
  }
  edited: Array<{ messageId: string; content: string }> = [];
  async edit(_link: ChannelLink, messageId: string, content: string): Promise<void> {
    this.edited.push({ messageId, content });
  }
  async react(_link: ChannelLink, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ messageId, emoji });
  }
  unreacted: Array<{ messageId: string; emoji: string }> = [];
  async unreact(_link: ChannelLink, messageId: string, emoji: string): Promise<void> {
    this.unreacted.push({ messageId, emoji });
  }
}

function harness(options?: RouterOptions) {
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
  }, { applicationId: "app1", webhookIds: new Set(["wh1"]) }, options ?? {});

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

  it("swaps a GIF-picker page link for the embed's direct media URL", async () => {
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(
      discordMsg({
        content: "https://klipy.com/gifs/monday-already-monday-again-1",
        embeds: [
          {
            url: "https://klipy.com/gifs/monday-already-monday-again-1",
            mediaUrl: "https://static.klipy.com/monday.gif",
          },
        ],
      }),
      link,
    );
    const opened = openWrap(pool.published.filter((e) => e.kind === 1059)[0], channel.current.group);
    expect(opened.content).toBe("https://static.klipy.com/monday.gif");

    // Prose containing a link keeps its content untouched.
    const second = await router.onDiscordMessage(
      discordMsg({
        id: "111222334",
        content: "look at https://klipy.com/gifs/x",
        embeds: [{ url: "https://klipy.com/gifs/x", mediaUrl: "https://static.klipy.com/x.gif" }],
      }),
      link,
    );
    expect(second).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059);
    expect(openWrap(wraps[wraps.length - 1], channel.current.group).content).toBe("look at https://klipy.com/gifs/x");
  });

  it("resolveGifVariant probes for a real .gif and falls back to the mp4", async () => {
    const gifOk = (async () =>
      new Response(null, { status: 200, headers: { "content-type": "image/gif" } })) as unknown as typeof fetch;
    const allDead = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const htmlTrap = (async () =>
      new Response(null, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

    // Already a gif: no probing.
    expect(await resolveGifVariant("https://p", "https://cdn/x.gif", allDead)).toBe("https://cdn/x.gif");
    // Extension swap verified by HEAD.
    expect(await resolveGifVariant("https://klipy.com/gifs/x", "https://static.klipy.com/a.mp4", gifOk)).toBe(
      "https://static.klipy.com/a.gif",
    );
    // A 200 that serves html is not a gif.
    expect(await resolveGifVariant("https://tenor.com/view/x", "https://media.tenor.com/a.mp4", htmlTrap)).toBe(
      "https://media.tenor.com/a.mp4",
    );
    // Nothing viable: keep the mp4.
    expect(await resolveGifVariant("https://p/x", "https://cdn/a.mp4", allDead)).toBe("https://cdn/a.mp4");
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

    // The bridge's own announcements (confirm requests etc.) stay Armada-side.
    expect(await router.onConcordChat(concordChat({ author: client.primaryPk }), link)).toEqual([]);

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

  it("Discord reaction remove tombstones the kind 7 with a k=7 delete", async () => {
    const { router, pool, channel, puppets, store, link } = harness();
    await router.onDiscordMessage(discordMsg(), link);
    const reactionRumorId = await router.onDiscordReaction(reaction(), link);
    expect(store.reactions).toHaveLength(1);

    const deleteRumorId = await router.onDiscordReactionRemove(reaction(), link);
    expect(deleteRumorId).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059);
    const opened = openWrap(wraps[wraps.length - 1], channel.current.group);
    expect(opened.kind).toBe(5);
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(opened.tags).toContainEqual(["e", reactionRumorId!]);
    expect(opened.tags).toContainEqual(["k", "7"]);
    expect(store.reactions).toHaveLength(0);

    // Removing a never-bridged reaction is a no-op.
    expect(await router.onDiscordReactionRemove(reaction(), link)).toBeUndefined();
  });

  it("Concord kind 5 on a reaction rumor un-reacts only when the last reactor leaves", async () => {
    const { router, webhooks, link } = harness();
    await router.onConcordChat(concordChat(), link); // mirror as id 9000

    await router.onConcordChat(
      concordChat({ rumorId: "e1".repeat(32), kind: 7, content: "🔥", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    await router.onConcordChat(
      concordChat({ rumorId: "e2".repeat(32), kind: 7, content: "🔥", author: "c".repeat(64), tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.reactions).toHaveLength(2);

    await router.onConcordChat(
      concordChat({ rumorId: "d5".repeat(32), kind: 5, content: "", tags: [["e", "e1".repeat(32)], ["k", "7"]] }),
      link,
    );
    expect(webhooks.unreacted).toHaveLength(0); // c's reaction still mirrored

    await router.onConcordChat(
      concordChat({ rumorId: "d6".repeat(32), kind: 5, content: "", author: "c".repeat(64), tags: [["e", "e2".repeat(32)], ["k", "7"]] }),
      link,
    );
    expect(webhooks.unreacted).toEqual([{ messageId: "9000", emoji: "🔥" }]);
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

describe("BridgeRouter: thread replies (kind 1111)", () => {
  it("flattens a Concord thread reply to Discord with a parent jump link", async () => {
    const { router, webhooks, store, link } = harness();
    await router.onConcordChat(concordChat(), link); // parent mirrored as 9000

    const ids = await router.onConcordChat(
      concordChat({
        rumorId: "t1".repeat(32),
        kind: 1111,
        content: "thread reply",
        tags: [
          ["K", "9"], ["E", "r".repeat(64), "", "f".repeat(64)], ["P", "f".repeat(64)],
          ["k", "9"], ["e", "r".repeat(64), "", "f".repeat(64)], ["p", "f".repeat(64)],
        ],
      }),
      link,
    );
    expect(ids).toHaveLength(1);
    expect(webhooks.sent[1].content).toBe("thread reply");
    expect(webhooks.sent[1].embeds![0].description).toContain("/9000");
    // Mapped, so reactions/deletes on the comment resolve too.
    expect(store.rows.some((r) => r.concordRumorId === "t1".repeat(32))).toBe(true);
  });
});

describe("BridgeRouter: edits (kind 3302, behind flag)", () => {
  it("does nothing in either direction by default", async () => {
    const { router, pool, webhooks, link } = harness();
    await router.onDiscordMessage(discordMsg(), link);
    await router.onConcordChat(concordChat(), link);
    const before = pool.published.filter((e) => e.kind === 1059).length;

    expect(await router.onDiscordEdit(discordMsg({ content: "edited" }), link)).toBeUndefined();
    await router.onConcordChat(
      concordChat({ rumorId: "x1".repeat(32), kind: 3302, content: "fixed", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(pool.published.filter((e) => e.kind === 1059)).toHaveLength(before);
    expect(webhooks.edited).toHaveLength(0);
  });

  it("Discord MESSAGE_UPDATE publishes a puppet kind 3302 naming the rumor", async () => {
    const { router, pool, channel, puppets, link } = harness({ bridgeEdits: true });
    const rumorId = await router.onDiscordMessage(discordMsg(), link);

    const editRumorId = await router.onDiscordEdit(discordMsg({ content: "edited!" }), link);
    expect(editRumorId).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059);
    const opened = openWrap(wraps[wraps.length - 1], channel.current.group);
    expect(opened.kind).toBe(3302);
    expect(opened.content).toBe("edited!");
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(opened.tags).toContainEqual(["e", rumorId!]);
    expect(hasProxyTag(opened)).toBe(true);
  });

  it("Concord kind 3302 edits the mirror in place, author-only", async () => {
    const { router, webhooks, link } = harness({ bridgeEdits: true });
    await router.onConcordChat(concordChat(), link); // mirror as 9000

    await router.onConcordChat(
      concordChat({ rumorId: "x2".repeat(32), kind: 3302, content: "not yours", author: "a".repeat(64), tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.edited).toHaveLength(0);

    await router.onConcordChat(
      concordChat({ rumorId: "x3".repeat(32), kind: 3302, content: "fixed", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(webhooks.edited).toEqual([{ messageId: "9000", content: "fixed" }]);
  });
});

class FakeBlobs {
  uploads: Array<{ size: number; mime: string; author: string }> = [];
  async download(_url: string, _maxBytes: number): Promise<{ data: Uint8Array; mime: string }> {
    return { data: new Uint8Array([1, 2, 3]), mime: "image/png" };
  }
  async upload(
    data: Uint8Array,
    mime: string,
    author: { pk: string },
  ): Promise<{ url: string; sha256: string }> {
    this.uploads.push({ size: data.length, mime, author: author.pk });
    return { url: "https://blossom.example/abc123", sha256: "ab".repeat(32) };
  }
}

describe("BridgeRouter: attachments via Blossom", () => {
  it("rehosts Discord attachments and carries imeta tags on the rumor", async () => {
    const blobs = new FakeBlobs();
    const { router, pool, channel, puppets, link } = harness({ blobs });
    await router.onDiscordMessage(
      discordMsg({ content: "look", attachments: [{ url: "https://cdn.discordapp.com/x.png", filename: "x.png" }] }),
      link,
    );
    const wrap = pool.published.find((e) => e.kind === 1059)!;
    const opened = openWrap(wrap, channel.current.group);
    expect(opened.content).toBe("look\nhttps://blossom.example/abc123");
    const imeta = opened.tags.find((t) => t[0] === "imeta")!;
    expect(imeta).toContain("url https://blossom.example/abc123");
    expect(imeta).toContain("m image/png");
    expect(blobs.uploads[0].author).toBe(puppets.get("80351110224678912").pk);
  });

  it("falls back to the CDN link when rehosting fails", async () => {
    const blobs = new FakeBlobs();
    blobs.upload = async () => {
      throw new Error("server down");
    };
    const { router, pool, channel, link } = harness({ blobs });
    await router.onDiscordMessage(
      discordMsg({ content: "look", attachments: [{ url: "https://cdn.discordapp.com/x.png" }] }),
      link,
    );
    const opened = openWrap(pool.published.find((e) => e.kind === 1059)!, channel.current.group);
    expect(opened.content).toBe("look\nhttps://cdn.discordapp.com/x.png");
    expect(opened.tags.some((t) => t[0] === "imeta")).toBe(false);
  });

  it("re-uploads Concord imeta blobs as Discord files", async () => {
    const { router, webhooks, link } = harness({ blobs: new FakeBlobs() });
    await router.onConcordChat(
      concordChat({
        content: "pic https://blossom.example/abc123",
        tags: [["imeta", "url https://blossom.example/abc123", "m image/png", "size 3"]],
      }),
      link,
    );
    expect(webhooks.sent[0].files).toHaveLength(1);
    expect(webhooks.sent[0].files![0].name).toBe("abc123");
    expect(webhooks.sent[0].files![0].data).toEqual(new Uint8Array([1, 2, 3]));
  });
});
