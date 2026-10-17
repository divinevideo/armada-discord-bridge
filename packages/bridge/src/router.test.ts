import { describe, expect, it } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";
import {
  KIND_JOIN_LEAVE,
  KIND_TYPING,
  KIND_WRAP_EPHEMERAL,
  bytesToHex,
  channelGroupKey,
  guestbookGroups,
  mintCommunity,
  openGuestbookWraps,
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
import type { safeProbe } from "./net";
import { BridgeRouter, MemoryMappingStore, applyCustomEmoji, concordCustomEmojiToDiscord, escapeMarkdown, fallbackProfile, reactionEmoji, resolveGifVariant } from "./router";
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
  typing = 0;
  async sendTyping(_link: ChannelLink): Promise<void> {
    this.typing++;
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
  }, { applicationId: "app1", webhookIds: new Set(["wh1"]) }, { beforeSideEffect: async () => {}, ...options });

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
    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
    expect(wraps).toHaveLength(1);
    const opened = openWrap(wraps[0], channel.current.group);
    expect(opened.content).toBe("hello armada");
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(hasProxyTag(opened)).toBe(true);
    // NIP-48: full permalink as value, "web" as the protocol marker.
    expect(opened.tags).toContainEqual([
      "proxy",
      "https://discord.com/channels/g1/c1/111222333",
      "web",
    ]);

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
    const opened = openWrap(pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)[0], channel.current.group);
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
    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
    expect(openWrap(wraps[wraps.length - 1], channel.current.group).content).toBe("look at https://klipy.com/gifs/x");
  });

  it("tags the substituted GIF-picker media, naming exactly the URL in the content", async () => {
    // A picker send has no `attachments`, so it used to cross carrying nothing
    // but a bare URL — and Armada exempts only imeta-tagged URLs from
    // tracking-param stripping, so a signed provider URL broke on the way in.
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(
      discordMsg({
        content: "https://klipy.com/gifs/x",
        embeds: [{ url: "https://klipy.com/gifs/x", mediaUrl: "https://static.klipy.com/x.gif" }],
      }),
      link,
    );
    const opened = openWrap(
      pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!,
      channel.current.group,
    );
    const imeta = opened.tags.find((t) => t[0] === "imeta")!;
    expect(imeta).toEqual(["imeta", "url https://static.klipy.com/x.gif", "m image/gif"]);
    expect(imeta).toContain(`url ${opened.content}`);
  });

  it("leaves prose containing a link untagged", async () => {
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(
      discordMsg({
        content: "look at https://klipy.com/gifs/x",
        embeds: [{ url: "https://klipy.com/gifs/x", mediaUrl: "https://static.klipy.com/x.gif" }],
      }),
      link,
    );
    const opened = openWrap(
      pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!,
      channel.current.group,
    );
    // No substitution happened, so a tag naming the media URL would name a URL
    // the content does not contain — an orphan Armada appends a second embed for.
    expect(opened.tags.some((t) => t[0] === "imeta")).toBe(false);
  });

  it("does not tag an embed media URL it cannot type", async () => {
    // `x` and `size` would be lies (the bytes are never downloaded) and a
    // guessed `m` is worse than none: Armada renders a file card for an imeta
    // whose MIME is neither image, video nor audio.
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(
      discordMsg({
        content: "https://example.com/page",
        embeds: [{ url: "https://example.com/page", mediaUrl: "https://example.com/media" }],
      }),
      link,
    );
    const opened = openWrap(
      pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!,
      channel.current.group,
    );
    expect(opened.content).toBe("https://example.com/media");
    expect(opened.tags.some((t) => t[0] === "imeta")).toBe(false);
  });

  it("resolves a Klipy send through the Items API and rehosts the real GIF", async () => {
    const blobs = new FakeBlobs(new TextEncoder().encode("GIF89a..."), "image/gif");
    const asked: string[] = [];
    const klipy = {
      resolveGif: async (page: string) => {
        asked.push(page);
        return { url: "https://static.klipy.com/ii/a/b/REAL.gif", width: 300, height: 200, size: 9 };
      },
    };
    const { router, pool, channel, link } = harness({ blobs, klipy });
    // No embed: Discord can attach it later, and the slug is all the lookup needs.
    await router.onDiscordMessage(discordMsg({ content: "https://klipy.com/gifs/monday-1" }), link);
    const opened = openWrap(
      pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!,
      channel.current.group,
    );
    expect(asked).toEqual(["https://klipy.com/gifs/monday-1"]);
    expect(opened.content).toBe("https://blossom.example/abc123.gif");
    const imeta = opened.tags.filter((t) => t[0] === "imeta");
    expect(imeta).toHaveLength(1);
    expect(imeta[0]).toContain("url https://blossom.example/abc123.gif");
    expect(imeta[0]).toContain("m image/gif");
    expect(imeta[0]).toContain("dim 300x200");
    expect(blobs.uploads[0].mime).toBe("image/gif");
  });

  it("links the real Klipy GIF when Blossom refuses it", async () => {
    const blobs = new FakeBlobs(new TextEncoder().encode("GIF89a..."), "image/gif");
    blobs.upload = async () => {
      throw new Error("blossom down");
    };
    const klipy = { resolveGif: async () => ({ url: "https://static.klipy.com/ii/a/b/REAL.gif" }) };
    const { router, pool, channel, link } = harness({ blobs, klipy });
    await router.onDiscordMessage(discordMsg({ content: "https://klipy.com/gifs/monday-1" }), link);
    const opened = openWrap(
      pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!,
      channel.current.group,
    );
    expect(opened.content).toBe("https://static.klipy.com/ii/a/b/REAL.gif");
    expect(opened.tags.find((t) => t[0] === "imeta")).toEqual([
      "imeta",
      "url https://static.klipy.com/ii/a/b/REAL.gif",
      "m image/gif",
    ]);
  });

  it("does not rehost bytes from Klipy that are not a GIF", async () => {
    const blobs = new FakeBlobs(new TextEncoder().encode("<html>"), "image/gif");
    const klipy = { resolveGif: async () => ({ url: "https://static.klipy.com/ii/a/b/REAL.gif" }) };
    const { router, link } = harness({ blobs, klipy });
    await router.onDiscordMessage(discordMsg({ content: "https://klipy.com/gifs/monday-1" }), link);
    expect(blobs.uploads).toHaveLength(0);
  });

  it("leaves a Klipy link in prose to the ordinary path", async () => {
    const asked: string[] = [];
    const klipy = {
      resolveGif: async (page: string) => {
        asked.push(page);
        return undefined;
      },
    };
    const { router, link } = harness({ klipy });
    await router.onDiscordMessage(discordMsg({ content: "lol https://klipy.com/gifs/monday-1" }), link);
    expect(asked).toHaveLength(0);
  });

  it("resolveGifVariant probes for a real .gif and falls back to the mp4", async () => {
    const gifOk: typeof safeProbe = async () => ({ ok: true, mime: "image/gif" });
    const allDead: typeof safeProbe = async () => ({ ok: false, mime: "" });
    const htmlTrap: typeof safeProbe = async () => ({ ok: true, mime: "text/html" });

    // Already a gif: no probing.
    expect(await resolveGifVariant("https://p", "https://cdn/x.gif", allDead)).toBe("https://cdn/x.gif");
    // Extension swap verified by HEAD.
    expect(await resolveGifVariant("https://tenor.com/view/x", "https://media.tenor.com/a.mp4", gifOk)).toBe(
      "https://media.tenor.com/a.gif",
    );
    // Never on Klipy: its CDN answers every missing rendition with a
    // placeholder GIF, so a probe that says yes proves nothing.
    expect(await resolveGifVariant("https://klipy.com/gifs/x", "https://static.klipy.com/a.mp4", gifOk)).toBe(
      "https://static.klipy.com/a.mp4",
    );
    // A 200 that serves html is not a gif.
    expect(await resolveGifVariant("https://tenor.com/view/x", "https://media.tenor.com/a.mp4", htmlTrap)).toBe(
      "https://media.tenor.com/a.mp4",
    );
    // Nothing viable: keep the mp4.
    expect(await resolveGifVariant("https://p/x", "https://cdn/a.mp4", allDead)).toBe("https://cdn/a.mp4");
  });

  it("resolveGifVariant probes only through the guard, and takes its refusals", async () => {
    // The media URL is an OpenGraph value off a page the message author chose,
    // so this is the SSRF path: the probe must be the guarded one, and a
    // refusal (undefined) must read as "no", not as an absent content-type.
    const probed: string[] = [];
    const refuseAll: typeof safeProbe = async (url) => {
      probed.push(url);
      return undefined;
    };
    expect(
      await resolveGifVariant("https://tenor.com/view/x", "http://169.254.169.254/latest/meta-data/x.mp4", refuseAll),
    ).toBe("http://169.254.169.254/latest/meta-data/x.mp4");
    expect(probed).toEqual([
      "http://169.254.169.254/latest/meta-data/x.gif",
      "https://tenor.com/view/x.gif",
    ]);
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
    const wrap = pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!;
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

  it("caps the fan-out one rumor can become, and says the tail was dropped", async () => {
    const { router, webhooks, store, link } = harness();
    // A rumor near what NIP-44 can carry: uncapped this is ~33 sends and 33
    // mapping rows from a single publish by a single member.
    const ids = await router.onConcordChat(concordChat({ content: "word ".repeat(13_000) }), link);

    expect(ids).toHaveLength(10);
    expect(store.rows).toHaveLength(10);
    expect(webhooks.sent.every((m) => m.content.length <= 2000)).toBe(true);
    expect(webhooks.sent[9].content).toMatch(/… \d+ more parts not mirrored$/);
  });

  it("mirrors one rumor at a time, in order", async () => {
    const { router, webhooks, link } = harness();
    // Fire-and-forget is how both entry points dispatch; concurrent runs used
    // to interleave and hold every rumor's attachments at once.
    const sends = [1, 2, 3, 4, 5].map((n) =>
      router.onConcordChat(concordChat({ rumorId: String(n).repeat(64), content: `msg ${n}` }), link),
    );
    await Promise.all(sends);
    expect(webhooks.sent.map((m) => m.content)).toEqual(["msg 1", "msg 2", "msg 3", "msg 4", "msg 5"]);
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
    const wrap = pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!;
    const opened = openWrap(wrap, channel.current.group);
    expect(opened.tags).toContainEqual(["q", "r".repeat(64), "", "f".repeat(64)]);
  });

  it("Discord reply to a bridged Discord message names the puppet author", async () => {
    const { router, pool, store, channel, puppets, link } = harness();
    const rumorId = await router.onDiscordMessage(discordMsg({ id: "1" }), link);
    await router.onDiscordMessage(discordMsg({ id: "2", referencedMessageId: "1" }), link);

    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
    const opened = openWrap(wraps[1], channel.current.group);
    expect(opened.tags).toContainEqual(["q", rumorId!, "", puppets.get("80351110224678912").pk]);
    expect(store.rows).toHaveLength(2);
  });

  it("unmapped references degrade to a bare message", async () => {
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(discordMsg({ referencedMessageId: "404404" }), link);
    const wrap = pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!;
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
    const before = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk).length;

    const deleteRumorId = await router.onDiscordDelete(
      { id: "111222333", channelId: "c1", guildId: "g1" },
      link,
    );
    expect(deleteRumorId).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
    expect(wraps).toHaveLength(before + 1);
    const opened = openWrap(wraps[wraps.length - 1], channel.current.group);
    expect(opened.kind).toBe(5);
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(opened.tags).toContainEqual(["e", rumorId!]);
    expect(hasProxyTag(opened)).toBe(true);
  });

  it("Discord delete of an Armada member's mirror stops at Discord", async () => {
    // `channel` was missing from this destructure, so `channel.current.group.pk`
    // was an unresolved name. It never threw only because `e.kind === 1059`
    // short-circuits the `&&` on an empty publish log -- the assertion was
    // comparing 0 to 0 and would have crashed the moment it had anything to
    // count. tsc had been flagging it the whole time.
    const { router, pool, channel, link } = harness();
    await router.onConcordChat(concordChat(), link); // mirror as id 9000
    const before = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk).length;
    expect(await router.onDiscordDelete({ id: "9000", channelId: "c1", guildId: "g1" }, link)).toBeUndefined();
    expect(pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)).toHaveLength(before);
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
    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
    const opened = openWrap(wraps[wraps.length - 1], channel.current.group);
    expect(opened.kind).toBe(7);
    expect(opened.content).toBe("🔥");
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(opened.tags).toContainEqual(["e", rumorId!]);
    expect(opened.tags).toContainEqual(["k", "9"]);
    expect(hasProxyTag(opened)).toBe(true);
  });

  it("bridges custom emoji reactions as NIP-30 :shortcode: with an emoji tag", async () => {
    const { router, pool, channel, link } = harness();
    const rumorId = await router.onDiscordMessage(discordMsg(), link);

    const id = await router.onDiscordReaction(
      reaction({ emoji: { name: "blob", id: "999", animated: false } }),
      link,
    );
    expect(id).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
    const opened = openWrap(wraps[wraps.length - 1], channel.current.group);
    expect(opened.kind).toBe(7);
    expect(opened.content).toBe(":blob:");
    expect(opened.tags).toContainEqual(["e", rumorId!]);
    expect(opened.tags).toContainEqual(["emoji", "blob", "https://cdn.discordapp.com/emojis/999.png"]);
  });

  it("skips bots and unmapped messages", async () => {
    const { router, pool, channel, link } = harness();
    await router.onDiscordMessage(discordMsg(), link);
    const before = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk).length;

    expect(
      await router.onDiscordReaction(reaction({ user: { id: "1", display: "bot", bot: true } }), link),
    ).toBeUndefined();
    expect(await router.onDiscordReaction(reaction({ messageId: "404404" }), link)).toBeUndefined();
    expect(pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)).toHaveLength(before);
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
    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
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
    const { router, pool, webhooks, channel, link } = harness();
    await router.onDiscordMessage(discordMsg(), link);
    await router.onConcordChat(concordChat(), link);
    const before = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk).length;

    expect(await router.onDiscordEdit(discordMsg({ content: "edited" }), link)).toBeUndefined();
    await router.onConcordChat(
      concordChat({ rumorId: "x1".repeat(32), kind: 3302, content: "fixed", tags: [["e", "r".repeat(64)]] }),
      link,
    );
    expect(pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)).toHaveLength(before);
    expect(webhooks.edited).toHaveLength(0);
  });

  it("Discord MESSAGE_UPDATE publishes a puppet kind 3302 naming the rumor", async () => {
    const { router, pool, channel, puppets, link } = harness({ bridgeEdits: true });
    const rumorId = await router.onDiscordMessage(discordMsg(), link);

    const editRumorId = await router.onDiscordEdit(discordMsg({ content: "edited!" }), link);
    expect(editRumorId).toBeDefined();
    const wraps = pool.published.filter((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk);
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
  /** Served bytes and content-type; overridable to stand in for a real blob host. */
  constructor(
    public data: Uint8Array = new Uint8Array([1, 2, 3]),
    public mime = "image/png",
  ) {}
  async download(_url: string, _maxBytes: number): Promise<{ data: Uint8Array; mime: string }> {
    return { data: this.data, mime: this.mime };
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

/**
 * One attachment as Armada's composer would send it: AES-256-GCM under a
 * 32-byte key and a 16-byte nonce, tag appended, `ox` over the PLAINTEXT.
 */
function encryptedAttachment(
  plaintext: Uint8Array,
  mime = "image/png",
): { blobs: FakeBlobs; tag: string[] } {
  const key = randomBytes(32);
  const nonce = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    // Served as octet-stream: the host describes the CIPHERTEXT, so only `m` knows.
    blobs: new FakeBlobs(new Uint8Array(ciphertext), "application/octet-stream"),
    tag: [
      "imeta",
      "url https://blossom.example/abc123",
      `m ${mime}`,
      `size ${String(ciphertext.length)}`,
      "encryption-algorithm aes-gcm",
      `decryption-key ${key.toString("hex")}`,
      `decryption-nonce ${nonce.toString("hex")}`,
      `ox ${bytesToHex(sha256(plaintext))}`,
    ],
  };
}

describe("BridgeRouter: attachments via Blossom", () => {
  it("rehosts Discord attachments and carries imeta tags on the rumor", async () => {
    const blobs = new FakeBlobs();
    const { router, pool, channel, puppets, link } = harness({ blobs });
    await router.onDiscordMessage(
      discordMsg({ content: "look", attachments: [{ url: "https://cdn.discordapp.com/x.png", filename: "x.png" }] }),
      link,
    );
    const wrap = pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!;
    const opened = openWrap(wrap, channel.current.group);
    // The extension is on the URL: Blossom is content-addressed, and the
    // extension is the only thing Armada's inline-media test can read off a
    // bare URL in the content.
    expect(opened.content).toBe("look\nhttps://blossom.example/abc123.png");
    const imeta = opened.tags.find((t) => t[0] === "imeta")!;
    // Byte-for-byte the URL in the content: Armada keys its imeta map on the
    // string, and a mismatch reads as untagged AND appends a duplicate embed.
    expect(imeta).toContain("url https://blossom.example/abc123.png");
    expect(imeta).toContain("m image/png");
    expect(imeta).toContain("name x.png");
    expect(blobs.uploads[0].author).toBe(puppets.get("80351110224678912").pk);
  });

  it("types an octet-stream attachment by its CDN filename, not by the served header", async () => {
    // Discord serves some attachments as application/octet-stream. Trusting it
    // names the blob `.octet-stream` and Armada renders a download card for
    // what is plainly a png.
    const blobs = new FakeBlobs(new Uint8Array([1, 2, 3]), "application/octet-stream");
    const { router, pool, channel, link } = harness({ blobs });
    await router.onDiscordMessage(
      discordMsg({ content: "look", attachments: [{ url: "https://cdn.discordapp.com/x.png", filename: "x.png" }] }),
      link,
    );
    const opened = openWrap(
      pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!,
      channel.current.group,
    );
    expect(opened.tags.find((t) => t[0] === "imeta")!).toContain("m image/png");
    expect(blobs.uploads[0].mime).toBe("image/png");
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
    const opened = openWrap(pool.published.find((e) => e.kind === 1059 && e.pubkey === channel.current.group.pk)!, channel.current.group);
    expect(opened.content).toBe("look\nhttps://cdn.discordapp.com/x.png");
    expect(opened.tags.some((t) => t[0] === "imeta")).toBe(false);
  });

  it("re-uploads Concord imeta blobs as Discord files and drops their URLs from the text", async () => {
    const { router, webhooks, link } = harness({ blobs: new FakeBlobs() });
    await router.onConcordChat(
      concordChat({
        content: "pic https://blossom.example/abc123",
        tags: [["imeta", "url https://blossom.example/abc123", "m image/png", "size 3"]],
      }),
      link,
    );
    expect(webhooks.sent[0].files).toHaveLength(1);
    // Discord types an upload by its FILENAME. A content-addressed Blossom URL
    // has no extension, so the name comes from `m`, which is the only field
    // that knows — the served content-type describes the ciphertext.
    expect(webhooks.sent[0].files![0].name).toBe("abc123.png");
    expect(webhooks.sent[0].files![0].data).toEqual(new Uint8Array([1, 2, 3]));
    expect(webhooks.sent[0].content).toBe("pic");
  });

  it("decrypts an encrypted attachment before handing it to Discord", async () => {
    // The whole reported bug: every Concord community attachment is
    // client-encrypted, and the bridge used to upload the AES-GCM ciphertext
    // to Discord verbatim, under a name with no extension.
    const plaintext = new Uint8Array([9, 8, 7, 6, 5]);
    const { blobs, tag } = encryptedAttachment(plaintext);
    const { router, webhooks, link } = harness({ blobs });
    await router.onConcordChat(
      concordChat({ content: "pic https://blossom.example/abc123", tags: [tag] }),
      link,
    );
    expect(webhooks.sent[0].files).toHaveLength(1);
    expect(webhooks.sent[0].files![0].data).toEqual(plaintext);
    expect(webhooks.sent[0].files![0].name).toBe("abc123.png");
    expect(webhooks.sent[0].content).toBe("pic");
  });

  it("accepts base64 key material, which Armada's own reader does", async () => {
    const plaintext = new Uint8Array([4, 4, 4]);
    const { blobs, tag } = encryptedAttachment(plaintext);
    const rebased = tag.map((field) => {
      const [name, value] = [field.slice(0, field.indexOf(" ")), field.slice(field.indexOf(" ") + 1)];
      if (name !== "decryption-key" && name !== "decryption-nonce") return field;
      return `${name} ${Buffer.from(value, "hex").toString("base64")}`;
    });
    const { router, webhooks, link } = harness({ blobs });
    await router.onConcordChat(concordChat({ content: "pic", tags: [rebased] }), link);
    expect(webhooks.sent[0].files![0].data).toEqual(plaintext);
  });

  it("refuses a blob whose plaintext does not match its `ox`", async () => {
    // A swapped blob under a key the sender published. Attaching it anyway
    // would republish someone else's bytes into Discord under that name.
    const { blobs, tag } = encryptedAttachment(new Uint8Array([1, 1, 1]));
    const lying = tag.map((f) => (f.startsWith("ox ") ? `ox ${"cd".repeat(32)}` : f));
    const { router, webhooks, link } = harness({ blobs });
    await router.onConcordChat(
      concordChat({ content: "pic https://blossom.example/abc123", tags: [lying] }),
      link,
    );
    expect(webhooks.sent[0].files).toBeUndefined();
    // The download failed, so the URL survives as a link rather than vanishing.
    expect(webhooks.sent[0].content).toBe("pic https://blossom.example/abc123");
  });

  it("never attaches a blob encrypted with something it cannot apply", async () => {
    // Fail closed. Treating an unreadable `encryption-algorithm` as plaintext
    // is precisely how ciphertext reached Discord in the first place.
    const { router, webhooks, link } = harness({ blobs: new FakeBlobs() });
    await router.onConcordChat(
      concordChat({
        content: "pic https://blossom.example/abc123",
        tags: [
          [
            "imeta",
            "url https://blossom.example/abc123",
            "m image/png",
            "size 3",
            "encryption-algorithm chacha20-poly1305",
            `decryption-key ${"ab".repeat(32)}`,
            `decryption-nonce ${"cd".repeat(16)}`,
          ],
        ],
      }),
      link,
    );
    expect(webhooks.sent[0].files).toBeUndefined();
    expect(webhooks.sent[0].content).toBe("pic https://blossom.example/abc123");
  });

  it("refuses an aes-gcm tag whose key material is the wrong length", async () => {
    const { router, webhooks, link } = harness({ blobs: new FakeBlobs() });
    await router.onConcordChat(
      concordChat({
        content: "pic https://blossom.example/abc123",
        tags: [
          [
            "imeta",
            "url https://blossom.example/abc123",
            "m image/png",
            "size 3",
            "encryption-algorithm aes-gcm",
            `decryption-key ${"ab".repeat(16)}`,
            `decryption-nonce ${"cd".repeat(16)}`,
          ],
        ],
      }),
      link,
    );
    expect(webhooks.sent[0].files).toBeUndefined();
  });

  it("keeps a sender-chosen filename out of the multipart header", async () => {
    // `name` is remote input that lands in `filename=`; a quote or a newline
    // there rewrites the part header, and a path is one the far side may honor.
    const { router, webhooks, link } = harness({ blobs: new FakeBlobs() });
    await router.onConcordChat(
      concordChat({
        content: "pic",
        tags: [
          [
            "imeta",
            "url https://blossom.example/abc123",
            "m image/png",
            "size 3",
            'name ../../etc/"passwd\r\n.png',
          ],
        ],
      }),
      link,
    );
    const name = webhooks.sent[0].files![0].name;
    expect(name).not.toContain("/");
    expect(name).not.toContain('"');
    expect(name).not.toContain("\r");
    expect(name).not.toContain("\n");
    expect(name.startsWith(".")).toBe(false);
    expect(name.endsWith(".png")).toBe(true);
  });

  it("sends a media-only message as just the file, never URL plus file", async () => {
    const { router, webhooks, link } = harness({ blobs: new FakeBlobs() });
    const ids = await router.onConcordChat(
      concordChat({
        content: "https://blossom.example/abc123",
        tags: [["imeta", "url https://blossom.example/abc123", "m image/gif", "size 3"]],
      }),
      link,
    );
    expect(ids).toHaveLength(1);
    expect(webhooks.sent).toHaveLength(1);
    expect(webhooks.sent[0].content).toBe("");
    expect(webhooks.sent[0].files).toHaveLength(1);
  });

  it("keeps the URL in the text when the blob is too large to attach", async () => {
    const { router, webhooks, link } = harness({ blobs: new FakeBlobs() });
    await router.onConcordChat(
      concordChat({
        content: "https://blossom.example/abc123",
        tags: [["imeta", "url https://blossom.example/abc123", "m image/gif", "size 99999999"]],
      }),
      link,
    );
    expect(webhooks.sent[0].content).toBe("https://blossom.example/abc123");
    expect(webhooks.sent[0].files).toBeUndefined();
  });
});

describe("BridgeRouter: guestbook joins", () => {
  it("publishes one kind 3306 join per puppet, on first message only", async () => {
    const { router, pool, community, puppets, link } = harness();
    await router.onDiscordMessage(discordMsg({ id: "1" }), link);
    await router.onDiscordMessage(discordMsg({ id: "2" }), link);

    const joins = openGuestbookWraps(pool.published, guestbookGroups(community));
    expect(joins).toHaveLength(1);
    expect(joins[0].kind).toBe(KIND_JOIN_LEAVE);
    const guestbookPks = guestbookGroups(community).map((group) => group.pk);
    expect(pool.published.findIndex((event) => guestbookPks.includes(event.pubkey))).toBeLessThan(pool.published.findIndex((event) => event.kind === 0));
    expect(joins[0].author).toBe(puppets.get("80351110224678912").pk);
  });

  it("backdates the join to a history message's timestamp", async () => {
    const { router, pool, community, link } = harness();
    const ms = Date.parse("2024-03-01T12:00:00Z");
    await router.onDiscordMessage(discordMsg({ timestampMs: ms }), link);

    const [join] = openGuestbookWraps(pool.published, guestbookGroups(community));
    expect(join.ms).toBe(ms);
  });
});

describe("BridgeRouter: typing", () => {
  it("Discord typing becomes an ephemeral 23311 wrap from the puppet, throttled", async () => {
    const { router, pool, channel, puppets, link } = harness();
    await router.onDiscordTyping("80351110224678912", link);
    await router.onDiscordTyping("80351110224678912", link); // inside throttle window

    const ephemeral = pool.published.filter((e) => e.kind === KIND_WRAP_EPHEMERAL);
    expect(ephemeral).toHaveLength(1);
    const opened = openWrap(ephemeral[0], channel.current.group);
    expect(opened.kind).toBe(KIND_TYPING);
    expect(opened.author).toBe(puppets.get("80351110224678912").pk);
    expect(opened.tags).toContainEqual(["channel", channel.idHex]);
  });

  it("Concord typing becomes the bot's Discord indicator, throttled per channel", async () => {
    const { router, webhooks, link } = harness();
    await router.onConcordChat(concordChat({ kind: KIND_TYPING, content: "" }), link);
    await router.onConcordChat(
      concordChat({ kind: KIND_TYPING, content: "", rumorId: "t".repeat(64) }),
      link,
    );
    expect(webhooks.typing).toBe(1);
    expect(webhooks.sent).toHaveLength(0); // never mirrored as a message
  });
});

describe("custom emoji round-trip", () => {
  it("applyCustomEmoji rewrites shortcodes with Discord CDN emoji tags", () => {
    expect(
      applyCustomEmoji("hi :pepe: bye :pepe:", [["emoji", "pepe", "https://cdn.discordapp.com/emojis/123.png"]]),
    ).toBe("hi <:pepe:123> bye <:pepe:123>");
    expect(
      applyCustomEmoji("go :party:", [["emoji", "party", "https://cdn.discordapp.com/emojis/9.gif"]]),
    ).toBe("go <a:party:9>");
    // Foreign emoji hosts stay as plain shortcodes.
    expect(
      applyCustomEmoji("hm :blob:", [["emoji", "blob", "https://example.com/blob.png"]]),
    ).toBe("hm :blob:");
  });

  it("refuses an emoji tag whose URL only mentions the CDN", () => {
    // The old test was a substring match anywhere in the string.
    const smuggled = "https://evil.example/?x=cdn.discordapp.com/emojis/1.png";
    expect(applyCustomEmoji("hm :blob:", [["emoji", "blob", smuggled]])).toBe("hm :blob:");
    expect(concordCustomEmojiToDiscord([["emoji", "blob", smuggled]])).toBeUndefined();
    expect(
      concordCustomEmojiToDiscord([["emoji", "blob", "http://cdn.discordapp.com.evil.test/emojis/1.png"]]),
    ).toBeUndefined();
  });

  // The bound that the unicode path got in 0def35b and the fallback beside it
  // did not: this string ends up in a Discord API path.
  it("refuses an emoji name Discord would never have issued", () => {
    const cdn = "https://cdn.discordapp.com/emojis/1.png";
    expect(concordCustomEmojiToDiscord([["emoji", "A".repeat(60_000), cdn]])).toBeUndefined();
    expect(concordCustomEmojiToDiscord([["emoji", "not a name", cdn]])).toBeUndefined();
    expect(concordCustomEmojiToDiscord([["emoji", "x", cdn]])).toBeUndefined();
    expect(concordCustomEmojiToDiscord([["emoji", "pepe", cdn]])).toBe("pepe:1");
    expect(applyCustomEmoji(":x:", [["emoji", "A".repeat(60_000), cdn]])).toBe(":x:");
  });

  it("mirrors an Armada message with a Discord-CDN emoji tag as native markup", async () => {
    const { router, webhooks, link } = harness();
    await router.onConcordChat(
      concordChat({
        content: "hello :pepe:",
        tags: [["emoji", "pepe", "https://cdn.discordapp.com/emojis/456.png"]],
      }),
      link,
    );
    expect(webhooks.sent[0].content).toBe("hello <:pepe:456>");
  });
});

describe("reactionEmoji", () => {
  it("passes real emoji through, including ZWJ sequences and skin tones", () => {
    expect(reactionEmoji("👍")).toBe("👍");
    expect(reactionEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(reactionEmoji("👍🏽")).toBe("👍🏽");
    expect(reactionEmoji("🏳️‍🌈")).toBe("🏳️‍🌈");
    expect(reactionEmoji("  🎉  ")).toBe("🎉");
  });

  it("keeps the NIP-25 sentinels", () => {
    expect(reactionEmoji("")).toBe("👍");
    expect(reactionEmoji("+")).toBe("👍");
    expect(reactionEmoji("-")).toBe("👎");
  });

  it("refuses an emoji with a payload welded to it", () => {
    // The old test was "contains a pictograph" while it returned the WHOLE
    // string, so this put 60KB into a Discord reaction API path.
    expect(reactionEmoji(`👍${"A".repeat(60_000)}`)).toBeUndefined();
    expect(reactionEmoji("👍 not an emoji")).toBeUndefined();
    expect(reactionEmoji("👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍")).toBeUndefined();
  });

  it("still refuses shortcodes and plain text", () => {
    expect(reactionEmoji(":shrug:")).toBeUndefined();
    expect(reactionEmoji("nice")).toBeUndefined();
    expect(reactionEmoji("123")).toBeUndefined();
  });
});

describe("escapeMarkdown", () => {
  it("defuses a link injected through a kind 0 display name", () => {
    const escaped = escapeMarkdown("[#general](https://phishing.example)");
    expect(escaped).not.toMatch(/\[[^\\]*\]\(/);
    expect(escaped).toContain("\\[");
    expect(escaped).toContain("\\]");
    expect(escaped).toContain("\\(");
  });

  it("leaves ordinary names readable", () => {
    expect(escapeMarkdown("mk fain")).toBe("mk fain");
    expect(escapeMarkdown("Alice")).toBe("Alice");
  });

  it("clips a name that would crowd out the embed", () => {
    const out = escapeMarkdown("x".repeat(500));
    expect(out.length).toBeLessThan(120);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("public channel policy at side-effect boundaries", () => {
  it("does not spend visibility reads on throttled Discord typing", async () => {
    let checks = 0;
    const h = harness({ beforeSideEffect: async () => { checks++; } });
    await h.router.onDiscordTyping("80351110224678912", h.link);
    const before = checks;
    const published = h.pool.published.length;
    expect(before).toBeGreaterThan(0);
    await h.router.onDiscordTyping("80351110224678912", h.link);
    expect(checks).toBe(before);
    expect(h.pool.published).toHaveLength(published);
  });

  it("does not publish typing when visibility is denied", async () => {
    const h = harness({ beforeSideEffect: async () => { throw new Error("visibility denied"); } });
    await expect(h.router.onDiscordTyping("80351110224678912", h.link)).rejects.toThrow("visibility denied");
    expect(h.pool.published).toHaveLength(0);
  });

  it("sheds a full chat queue without visibility reads and checks queued sends after revocation", async () => {
    let checks = 0;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ beforeSideEffect: async () => {
      checks++;
      entered();
      await blocked;
      throw new Error("visibility denied");
    } });
    const queued = Array.from({ length: 200 }, (_, i) => h.router.onConcordChat(concordChat({ rumorId: String(i).padStart(64, "0") }), h.link));
    const settled = Promise.allSettled(queued);
    await started;
    expect(checks).toBe(1);
    expect(await h.router.onConcordChat(concordChat(), h.link)).toEqual([]);
    expect(checks).toBe(1);
    release();
    const results = await settled;
    expect(results.every((result) => result.status === "rejected" && result.reason.message === "visibility denied")).toBe(true);
    expect(checks).toBe(200);
    expect(h.webhooks.sent).toHaveLength(0);
    expect(h.store.rows).toHaveLength(0);
  });

  it("does not spend policy reads on bot or own-webhook/application echoes", async () => {
    let checks = 0;
    const h = harness({ beforeSideEffect: async () => { checks++; throw new Error("unavailable"); } });
    for (const msg of [
      discordMsg({ webhookId: "wh1" }),
      discordMsg({ applicationId: "app1" }),
      discordMsg({ author: { ...discordMsg().author, bot: true } }),
    ]) {
      expect(await h.router.onDiscordMessage(msg, h.link)).toBeUndefined();
    }
    for (const method of ["onDiscordReaction", "onDiscordReactionRemove"] as const) {
      expect(await h.router[method]({ user: { bot: true } } as never, h.link)).toBeUndefined();
    }
    expect(checks).toBe(0);
    expect(h.pool.published).toHaveLength(0);
    expect(h.webhooks.sent).toHaveLength(0);
  });

  it("does not publish or map content when authorization is denied", async () => {
    const h = harness({ beforeSideEffect: async () => { throw new Error("channel unavailable"); } });
    await expect(h.router.onDiscordMessage(discordMsg(), h.link)).rejects.toThrow("channel unavailable");
    expect(h.pool.published).toHaveLength(0);
    expect(await h.store.byDiscordId("111222333")).toHaveLength(0);
  });

  it("rechecks before uploading an attachment after visibility changes", async () => {
    let publicNow = true;
    const uploads: Uint8Array[] = [];
    const h = harness({
      beforeSideEffect: async () => { if (!publicNow) throw new Error("channel unavailable"); },
      blobs: {
        download: async () => { publicNow = false; return { data: new Uint8Array([1]), mime: "image/png" }; },
        upload: async (data) => { uploads.push(data); return { url: "https://media.example/test.png", sha256: "a".repeat(64) }; },
      },
    });
    await expect(h.router.onDiscordMessage(discordMsg({ attachments: [{ url: "https://cdn.discordapp.com/test.png", filename: "test.png" }] }), h.link)).rejects.toThrow("channel unavailable");
    expect(uploads).toHaveLength(0);
    expect(h.pool.published).toHaveLength(0);
  });
});

 it("fails closed when a router has no effect policy", async () => {
   const h = harness({ beforeSideEffect: undefined });
   await expect(h.router.onDiscordMessage(discordMsg(), h.link)).rejects.toThrow("Bridge effect policy is not configured");
   expect(h.pool.published).toHaveLength(0);
 });


describe("revocation applies to all message operations", () => {
  for (const method of ["onDiscordEdit", "onDiscordDelete", "onDiscordReaction", "onDiscordReactionRemove", "onConcordChat"] as const) {
    it(`blocks ${method} after permission loss`, async () => {
      const h = harness({ beforeSideEffect: async () => { throw new Error("visibility denied"); } });
      const event = method === "onConcordChat" ? concordChat() : { user: { bot: false } };
      await expect(h.router[method](event as never, h.link)).rejects.toThrow("visibility denied");
      expect(h.pool.published).toHaveLength(0);
      expect(h.webhooks.sent).toHaveLength(0);
    });
  }
});
