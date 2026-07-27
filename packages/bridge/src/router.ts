/**
 * The bidirectional message router: the only place where Discord events and
 * Concord rumors meet. Ports (webhook sender, mapping store, profile
 * resolver) are interfaces so the router tests offline; the Discord gateway
 * adapter and Postgres store plug in at wiring time.
 *
 * Loop prevention, both layers, lives here:
 *  1. proxy tag: never bridge a Concord rumor that carries one; never bridge
 *     a Discord message authored by our own webhooks/application.
 *  2. identity: never bridge a Concord rumor authored by one of our puppets,
 *     and never bridge a rumor we already have a mapping row for.
 */

import { KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_MESSAGE, KIND_REACTION } from "@armada-bridge/concord-core";
import type { OpenedChat } from "@armada-bridge/concord-core";

import type { ConcordClient } from "./concord/client";
import { hasProxyTag, proxyTag } from "./concord/client";
import { localIdentity } from "./concord/signer";
import type { LocalIdentity } from "./concord/signer";
import { ffmpegAvailable, mp4ToGif } from "./gif";

type LocalIdentitySigner = LocalIdentity["signer"];
import type { PuppetCache } from "./puppets";
import { concordToDiscord, discordToConcord, splitForDiscord } from "./transform";
import type { DiscordMessageContent } from "./transform";

export interface ChannelLink {
  discordGuildId: string;
  discordChannelId: string;
  communityId: string;
  concordChannelIdHex: string;
  enabled: boolean;
}

export interface DiscordInboundMessage extends DiscordMessageContent {
  id: string;
  channelId: string;
  guildId: string;
  author: { id: string; display: string; avatarUrl?: string; bot: boolean };
  webhookId?: string;
  applicationId?: string;
  /** message_reference: the Discord message this one replies to. */
  referencedMessageId?: string;
}

export interface DiscordMessageDelete {
  id: string;
  channelId: string;
  guildId: string;
}

export interface DiscordReactionAdd {
  messageId: string;
  channelId: string;
  guildId: string;
  /** Unicode emoji have only a name; custom emoji carry an id. */
  emoji: { name: string | null; id: string | null };
  user: { id: string; display: string; avatarUrl?: string; bot: boolean };
}

export interface MessageMappingRow {
  discordMessageId: string;
  discordChannelId: string;
  concordRumorId: string;
  concordChannelId: string;
  communityId: string;
  origin: "discord" | "concord";
  authorRef: string;
  partIndex: number;
}

export interface ReactionMappingRow {
  /** The kind 7 rumor id. */
  rumorId: string;
  /** The Discord message the reaction sits on. */
  discordMessageId: string;
  /** Unicode emoji as it appears on Discord. */
  emoji: string;
  origin: "discord" | "concord";
  /** Discord user id or Concord pubkey of the reactor. */
  authorRef: string;
}

export interface MappingStore {
  insert(row: MessageMappingRow): Promise<void>;
  byRumorId(rumorId: string): Promise<MessageMappingRow[]>;
  byDiscordId(discordMessageId: string): Promise<MessageMappingRow[]>;
  insertReaction(row: ReactionMappingRow): Promise<void>;
  reactionByDiscord(messageId: string, userId: string, emoji: string): Promise<ReactionMappingRow | undefined>;
  reactionByRumorId(rumorId: string): Promise<ReactionMappingRow | undefined>;
  deleteReaction(rumorId: string): Promise<void>;
  /** Concord-origin reactions still mirrored onto this message with this emoji. */
  countConcordReactions(messageId: string, emoji: string): Promise<number>;
}

export interface WebhookSender {
  /** Post as the given persona; returns the created Discord message id. */
  send(
    link: ChannelLink,
    message: {
      username: string;
      avatarUrl?: string;
      content: string;
      embeds?: Array<{ description: string }>;
      files?: Array<{ name: string; data: Uint8Array }>;
    },
  ): Promise<string>;
  /** Remove a bridged message (webhook delete; bot delete for user posts). */
  delete(link: ChannelLink, discordMessageId: string): Promise<void>;
  /** Edit a webhook-authored mirror in place. */
  edit(link: ChannelLink, discordMessageId: string, content: string): Promise<void>;
  /** React as the bot account (webhooks cannot react). */
  react(link: ChannelLink, discordMessageId: string, emoji: string): Promise<void>;
  /** Remove the bot's own reaction. */
  unreact(link: ChannelLink, discordMessageId: string, emoji: string): Promise<void>;
}

/** Rehosting port: Discord CDN blobs -> durable storage and back (Blossom). */
export interface BlobPort {
  download(url: string, maxBytes: number): Promise<{ data: Uint8Array; mime: string }>;
  /** Upload signed by the puppet; returns the durable URL and content hash. */
  upload(
    data: Uint8Array,
    mime: string,
    author: LocalIdentity,
  ): Promise<{ url: string; sha256: string }>;
}

export interface RouterOptions {
  /** Kind 3302 is not frozen in the CORDs yet; off by default. */
  bridgeEdits?: boolean;
  /** When set, attachments rehost through Blossom instead of rotting CDN links. */
  blobs?: BlobPort;
}

/** Attachment ceiling both ways (webhook upload limit for standard guilds). */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

/**
 * NIP-25 reaction content -> a Discord-reactable unicode emoji, or undefined
 * for content Discord would reject ("+"/"" mean like, "-" dislike; NIP-30
 * `:shortcode:` custom emoji have no Discord equivalent).
 */
export function reactionEmoji(content: string): string | undefined {
  const c = content.trim();
  if (c === "" || c === "+") return "👍";
  if (c === "-") return "👎";
  if (/^:.+:$/.test(c)) return undefined;
  if (/\p{Extended_Pictographic}/u.test(c)) return c;
  return undefined;
}

export interface ProfileResolver {
  /** Display name + avatar for a Concord member (kind 0 lookup, cached). */
  resolve(pubkeyHex: string): Promise<{ name: string; avatarUrl?: string }>;
}

/** Fallback persona: shortened npub-ish handle, no avatar. */
export const fallbackProfile = (pk: string): { name: string; avatarUrl?: string } => ({
  name: `nostr:${pk.slice(0, 8)}`,
});

/**
 * GIF pickers (Tenor, Klipy) expose only an mp4 in the Discord embed; the
 * provider almost always hosts a true .gif variant too. Probe the likely
 * URLs (extension swap, Tenor's page-url + .gif redirect) and keep the mp4
 * only when no candidate actually serves an image.
 */
export async function resolveGifVariant(
  pageUrl: string,
  mediaUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (/\.gif(\?|$)/i.test(mediaUrl)) return mediaUrl;
  const candidates = [
    mediaUrl.replace(/\.mp4(\?|$)/i, ".gif$1"),
    `${pageUrl.replace(/\/+$/, "")}.gif`,
  ].filter((url) => url !== mediaUrl);
  for (const url of candidates) {
    try {
      const res = await fetchFn(url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok && (res.headers.get("content-type") ?? "").startsWith("image/")) return url;
    } catch {
      // dead candidate; try the next
    }
  }
  return mediaUrl;
}

/** When the message is only a GIF-picker page link, upgrade its embed media to a true .gif. */
export async function upgradeGifEmbed(
  msg: DiscordInboundMessage,
  fetchFn: typeof fetch = fetch,
): Promise<DiscordInboundMessage> {
  const bare = msg.content.trim();
  if (!/^https?:\/\/\S+$/.test(bare)) return msg;
  const embed = msg.embeds?.find((e) => e.url === bare && e.mediaUrl);
  if (!embed?.mediaUrl) return msg;
  const mediaUrl = await resolveGifVariant(bare, embed.mediaUrl, fetchFn);
  return { ...msg, embeds: [{ url: embed.url, mediaUrl }] };
}

export class BridgeRouter {
  /** discord user id -> last published "name|avatar" (skip republishing). */
  private readonly publishedProfiles = new Map<string, string>();

  constructor(
    private readonly client: ConcordClient,
    private readonly puppets: PuppetCache,
    private readonly store: MappingStore,
    private readonly webhooks: WebhookSender,
    private readonly profiles: ProfileResolver,
    private readonly self: { applicationId: string; webhookIds: Set<string> },
    private readonly options: RouterOptions = {},
  ) {}

  /**
   * Keep the puppet's kind 0 in step with the Discord identity so Armada
   * shows the person's name and avatar instead of an anonymous key. Failure
   * is tolerable (the message still bridges); it retries on the next change.
   */
  private async syncPuppetProfile(
    author: DiscordInboundMessage["author"],
    identity: { pk: string; signer: LocalIdentitySigner },
  ): Promise<void> {
    const fingerprint = `${author.display}|${author.avatarUrl ?? ""}`;
    if (this.publishedProfiles.get(author.id) === fingerprint) return;
    await this.client.publishProfile(identity, {
      name: author.display,
      picture: author.avatarUrl,
      about: "Bridged from Discord by armada-bridge.",
    });
    this.publishedProfiles.set(author.id, fingerprint);
  }

  /** Discord -> Concord. Returns the rumor id, or undefined when skipped. */
  async onDiscordMessage(msg: DiscordInboundMessage, link: ChannelLink): Promise<string | undefined> {
    if (!link.enabled) return undefined;
    // Layer 1: our own webhook posts and application messages never bounce back.
    if (msg.webhookId && this.self.webhookIds.has(msg.webhookId)) return undefined;
    if (msg.applicationId && msg.applicationId === this.self.applicationId) return undefined;
    // Other bots are configurable later; skipped by default to avoid bot loops.
    if (msg.author.bot) return undefined;

    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return undefined; // deleted or key not held; nothing to do

    const puppet = this.puppets.get(msg.author.id);
    const identity = { pk: puppet.pk, signer: localIdentity(puppet.sk).signer };

    const tags = [proxyTag(msg.guildId, msg.channelId, msg.id)];
    let source = await upgradeGifEmbed(msg);
    source = await this.transcodedGifFallback(source, identity);
    const attachments = await this.rehostAttachments(source, identity, tags);
    const content = discordToConcord({ ...source, attachments });
    if (content.length === 0) return undefined;

    await this.syncPuppetProfile(msg.author, identity).catch((error) =>
      console.warn(`bridge: puppet profile publish failed for ${msg.author.id}`, error),
    );
    if (msg.referencedMessageId) {
      // NIP-C7 inline quote-reply naming the mapped rumor and its author.
      // An unmapped reference (pre-bridge history) degrades to a bare message.
      const [target] = await this.store.byDiscordId(msg.referencedMessageId);
      if (target) {
        const authorPk =
          target.origin === "discord" ? this.puppets.get(target.authorRef).pk : target.authorRef;
        tags.push(["q", target.concordRumorId, "", authorPk]);
      }
    }

    const { rumor } = await this.client.sendChat(channel, {
      content,
      author: identity,
      tags,
    });

    await this.store.insert({
      discordMessageId: msg.id,
      discordChannelId: msg.channelId,
      concordRumorId: rumor.id,
      concordChannelId: link.concordChannelIdHex,
      communityId: link.communityId,
      origin: "discord",
      authorRef: msg.author.id,
      partIndex: 0,
    });
    return rumor.id;
  }

  /** Concord -> Discord. Returns created Discord message ids (may split). */
  async onConcordChat(chat: OpenedChat, link: ChannelLink): Promise<string[]> {
    if (!link.enabled) return [];
    // Layer 1 + 2: bridge-originated or already-bridged rumors never bounce.
    // The primary's own posts (confirm requests, announcements) stay
    // Armada-side; mirroring them trips Discord's webhook username filter
    // ("Discord <-> Armada Bridge Bot") and is noise regardless.
    if (chat.author === this.client.primaryPk) return [];
    if (hasProxyTag(chat)) return [];
    if (this.puppets.isPuppetPubkey(chat.author)) return [];
    if (this.client.isBanned(chat.author)) return [];

    if (chat.kind === KIND_DELETE) {
      await this.onConcordDelete(chat, link);
      return [];
    }
    if (chat.kind === KIND_REACTION) {
      await this.onConcordReaction(chat, link);
      return [];
    }
    if (chat.kind === KIND_EDIT) {
      await this.onConcordEdit(chat, link);
      return [];
    }
    // Kind 9 messages and kind 1111 thread replies both bridge; Discord has
    // no thread on our side yet, so comments flatten with a jump-link embed.
    if (chat.kind !== KIND_MESSAGE && chat.kind !== KIND_COMMENT) return [];
    if ((await this.store.byRumorId(chat.rumorId)).length > 0) return [];

    const profile = await this.profiles.resolve(chat.author).catch(() => fallbackProfile(chat.author));
    const media = await this.filesFromImeta(chat);
    const parts = splitForDiscord(concordToDiscord(stripAttachedUrls(chat.content, media?.urls)));
    const reply = await this.replyEmbed(chat, link);
    const files = media?.files;

    const ids: string[] = [];
    for (const [index, part] of parts.entries()) {
      const discordMessageId = await this.webhooks.send(link, {
        username: profile.name,
        avatarUrl: profile.avatarUrl,
        content: part,
        embeds: index === 0 && reply ? [reply] : undefined,
        files: index === 0 ? files : undefined,
      });
      ids.push(discordMessageId);
      await this.store.insert({
        discordMessageId,
        discordChannelId: link.discordChannelId,
        concordRumorId: chat.rumorId,
        concordChannelId: link.concordChannelIdHex,
        communityId: link.communityId,
        origin: "concord",
        authorRef: chat.author,
        partIndex: index,
      });
    }
    return ids;
  }

  /**
   * Discord MESSAGE_DELETE -> kind 5 from the original author's puppet.
   * Deleting a mirror of an Armada member's message stops at Discord: the
   * puppet cannot (and must not) tombstone someone else's rumor.
   */
  async onDiscordDelete(del: DiscordMessageDelete, link: ChannelLink): Promise<string | undefined> {
    if (!link.enabled) return undefined;
    const [row] = await this.store.byDiscordId(del.id);
    if (!row || row.origin !== "discord") return undefined;

    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return undefined;

    const puppet = this.puppets.get(row.authorRef);
    const { rumor } = await this.client.sendChat(channel, {
      kind: KIND_DELETE,
      content: "",
      author: { pk: puppet.pk, signer: localIdentity(puppet.sk).signer },
      tags: [["e", row.concordRumorId], proxyTag(del.guildId, del.channelId, del.id)],
    });
    return rumor.id;
  }

  /**
   * Discord MESSAGE_UPDATE -> kind 3302 from the original author's puppet.
   * Off unless bridgeEdits: the 3302 payload is not frozen in the CORDs.
   */
  async onDiscordEdit(msg: DiscordInboundMessage, link: ChannelLink): Promise<string | undefined> {
    if (!this.options.bridgeEdits || !link.enabled) return undefined;
    const [row] = await this.store.byDiscordId(msg.id);
    if (!row || row.origin !== "discord") return undefined;
    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return undefined;

    const content = discordToConcord(msg);
    if (content.length === 0) return undefined;

    const puppet = this.puppets.get(row.authorRef);
    const { rumor } = await this.client.sendChat(channel, {
      kind: KIND_EDIT,
      content,
      author: { pk: puppet.pk, signer: localIdentity(puppet.sk).signer },
      tags: [["e", row.concordRumorId], proxyTag(msg.guildId, msg.channelId, msg.id)],
    });
    return rumor.id;
  }

  /** Discord MESSAGE_REACTION_ADD -> kind 7 from the reactor's puppet. */
  async onDiscordReaction(reaction: DiscordReactionAdd, link: ChannelLink): Promise<string | undefined> {
    if (!link.enabled) return undefined;
    if (reaction.user.bot) return undefined;
    // Custom Discord emoji have an id and no unicode form; skip until NIP-30
    // emoji tags are carried (NEXT-STEPS section 1).
    if (reaction.emoji.id || !reaction.emoji.name) return undefined;

    const [row] = await this.store.byDiscordId(reaction.messageId);
    if (!row) return undefined;
    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return undefined;

    const puppet = this.puppets.get(reaction.user.id);
    const identity = { pk: puppet.pk, signer: localIdentity(puppet.sk).signer };
    await this.syncPuppetProfile(reaction.user, identity).catch((error) =>
      console.warn(`bridge: puppet profile publish failed for ${reaction.user.id}`, error),
    );

    const { rumor } = await this.client.sendChat(channel, {
      kind: KIND_REACTION,
      content: reaction.emoji.name,
      author: identity,
      tags: [
        ["e", row.concordRumorId],
        ["k", String(KIND_MESSAGE)],
        proxyTag(reaction.guildId, reaction.channelId, reaction.messageId),
      ],
    });
    await this.store.insertReaction({
      rumorId: rumor.id,
      discordMessageId: reaction.messageId,
      emoji: reaction.emoji.name,
      origin: "discord",
      authorRef: reaction.user.id,
    });
    return rumor.id;
  }

  /**
   * Discord MESSAGE_REACTION_REMOVE -> puppet kind 5 tombstoning the kind 7
   * rumor. The `k` tag marks it a reaction delete for Armada's fold.
   */
  async onDiscordReactionRemove(reaction: DiscordReactionAdd, link: ChannelLink): Promise<string | undefined> {
    if (!link.enabled) return undefined;
    if (reaction.user.bot) return undefined;
    if (reaction.emoji.id || !reaction.emoji.name) return undefined;

    const row = await this.store.reactionByDiscord(reaction.messageId, reaction.user.id, reaction.emoji.name);
    if (!row || row.origin !== "discord") return undefined;
    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return undefined;

    const puppet = this.puppets.get(reaction.user.id);
    const { rumor } = await this.client.sendChat(channel, {
      kind: KIND_DELETE,
      content: "",
      author: { pk: puppet.pk, signer: localIdentity(puppet.sk).signer },
      tags: [
        ["e", row.rumorId],
        ["k", String(KIND_REACTION)],
        proxyTag(reaction.guildId, reaction.channelId, reaction.messageId),
      ],
    });
    await this.store.deleteReaction(row.rumorId);
    return rumor.id;
  }

  /**
   * Kind 5 -> remove every mapped Discord part. Honored for the rumor's own
   * author and for MANAGE_MESSAGES holders (moderator deletes propagate).
   */
  private async onConcordDelete(chat: OpenedChat, link: ChannelLink): Promise<void> {
    const targets = chat.tags.filter((t) => t[0] === "e" && t[1]).map((t) => t[1]);
    for (const target of targets) {
      // A kind 7 tombstone: un-react on Discord once the last mirrored
      // reaction with that emoji is gone (many reactors collapse into one
      // bot reaction).
      const reaction = await this.store.reactionByRumorId(target);
      if (reaction) {
        const own = reaction.origin === "concord" && reaction.authorRef === chat.author;
        if (!own && !this.client.isModerator(chat.author)) continue;
        await this.store.deleteReaction(target);
        if (
          reaction.origin === "concord" &&
          (await this.store.countConcordReactions(reaction.discordMessageId, reaction.emoji)) === 0
        ) {
          await this.webhooks
            .unreact(link, reaction.discordMessageId, reaction.emoji)
            .catch((error) => console.warn(`bridge: discord unreact failed for ${reaction.discordMessageId}`, error));
        }
        continue;
      }

      const rows = await this.store.byRumorId(target);
      if (rows.length === 0) continue;
      const own = rows[0].origin === "concord" && rows[0].authorRef === chat.author;
      if (!own && !this.client.isModerator(chat.author)) continue;
      for (const row of rows) {
        await this.webhooks
          .delete(link, row.discordMessageId)
          .catch((error) => console.warn(`bridge: discord delete failed for ${row.discordMessageId}`, error));
      }
    }
  }

  /** Kind 7 -> bot reaction on the mapped Discord message. */
  private async onConcordReaction(chat: OpenedChat, link: ChannelLink): Promise<void> {
    if (await this.store.reactionByRumorId(chat.rumorId)) return; // relay echo
    const target = chat.tags.find((t) => t[0] === "e" && t[1])?.[1];
    if (!target) return;
    const emoji = reactionEmoji(chat.content);
    if (!emoji) return;
    const rows = await this.store.byRumorId(target);
    const row = rows.find((r) => r.partIndex === 0) ?? rows[0];
    if (!row) return;
    await this.webhooks.react(link, row.discordMessageId, emoji);
    await this.store.insertReaction({
      rumorId: chat.rumorId,
      discordMessageId: row.discordMessageId,
      emoji,
      origin: "concord",
      authorRef: chat.author,
    });
  }

  /**
   * Kind 3302 -> edit the webhook mirrors in place. Author-only (matching
   * Armada's apply-phase author check). Grown messages append fresh parts;
   * shrunk ones blank the leftovers.
   */
  private async onConcordEdit(chat: OpenedChat, link: ChannelLink): Promise<void> {
    if (!this.options.bridgeEdits) return;
    const target = chat.tags.find((t) => t[0] === "e" && t[1])?.[1];
    if (!target) return;
    const rows = (await this.store.byRumorId(target)).sort((a, b) => a.partIndex - b.partIndex);
    if (rows.length === 0) return;
    if (rows[0].origin !== "concord" || rows[0].authorRef !== chat.author) return;

    const parts = splitForDiscord(concordToDiscord(chat.content));
    for (let i = 0; i < rows.length; i++) {
      const content = i < parts.length ? parts[i] : "*(removed by edit)*";
      await this.webhooks
        .edit(link, rows[i].discordMessageId, content)
        .catch((error) => console.warn(`bridge: discord edit failed for ${rows[i].discordMessageId}`, error));
    }
    if (parts.length > rows.length) {
      const profile = await this.profiles.resolve(chat.author).catch(() => fallbackProfile(chat.author));
      for (let i = rows.length; i < parts.length; i++) {
        const discordMessageId = await this.webhooks.send(link, {
          username: profile.name,
          avatarUrl: profile.avatarUrl,
          content: parts[i],
        });
        await this.store.insert({
          discordMessageId,
          discordChannelId: link.discordChannelId,
          concordRumorId: target,
          concordChannelId: link.concordChannelIdHex,
          communityId: link.communityId,
          origin: "concord",
          authorRef: chat.author,
          partIndex: i,
        });
      }
    }
  }

  /**
   * The replied-to rumor -> an embed linking the mapped Discord message.
   * Kind 9 inline replies carry `q`; kind 1111 comments point at their
   * immediate parent with lowercase `e` (thread root `E` as fallback).
   */
  private async replyEmbed(
    chat: OpenedChat,
    link: ChannelLink,
  ): Promise<{ description: string } | undefined> {
    let target = chat.tags.find((t) => t[0] === "q" && t[1])?.[1];
    if (!target && chat.kind === KIND_COMMENT) {
      target =
        chat.tags.find((t) => t[0] === "e" && t[1])?.[1] ??
        chat.tags.find((t) => t[0] === "E" && t[1])?.[1];
    }
    if (!target) return undefined;
    const rows = await this.store.byRumorId(target);
    const row = rows.find((r) => r.partIndex === 0) ?? rows[0];
    if (!row) return undefined;
    const url = `https://discord.com/channels/${link.discordGuildId}/${row.discordChannelId}/${row.discordMessageId}`;
    if (row.origin === "concord") {
      const profile = await this.profiles
        .resolve(row.authorRef)
        .catch(() => fallbackProfile(row.authorRef));
      return { description: `Replying to ${profile.name} ([view message](${url}))` };
    }
    return { description: `Replying to [this message](${url})` };
  }

  /**
   * Rehost Discord CDN attachments (signed URLs expire in ~24h) on Blossom,
   * signed by the puppet, and record NIP-92 imeta tags. Any failure falls
   * back to the CDN link so the message still bridges.
   */
  /**
   * Last resort for gifv embeds with no real .gif anywhere (Klipy): download
   * the short mp4, transcode with ffmpeg, rehost on Blossom. Skipped without
   * ffmpeg or a Blossom server; any failure keeps the mp4 URL.
   */
  private async transcodedGifFallback(
    msg: DiscordInboundMessage,
    identity: LocalIdentity,
  ): Promise<DiscordInboundMessage> {
    const blobs = this.options.blobs;
    const embed = msg.embeds?.[0];
    if (!blobs || !embed?.mediaUrl || !/\.mp4(\?|$)/i.test(embed.mediaUrl)) return msg;
    if (embed.url !== msg.content.trim() || !ffmpegAvailable()) return msg;
    try {
      const { data } = await blobs.download(embed.mediaUrl, MAX_BLOB_BYTES);
      const gif = await mp4ToGif(data);
      if (gif.length > MAX_BLOB_BYTES) return msg;
      const { url } = await blobs.upload(gif, "image/gif", identity);
      return { ...msg, embeds: [{ url: embed.url, mediaUrl: url }] };
    } catch (error) {
      console.warn(`gif transcode fallback failed for ${embed.mediaUrl}:`, error);
      return msg;
    }
  }

  private async rehostAttachments(
    msg: DiscordInboundMessage,
    identity: LocalIdentity,
    tags: string[][],
  ): Promise<DiscordInboundMessage["attachments"]> {
    const blobs = this.options.blobs;
    if (!blobs || !msg.attachments?.length) return msg.attachments;

    const out: NonNullable<DiscordInboundMessage["attachments"]> = [];
    for (const attachment of msg.attachments) {
      try {
        const { data, mime } = await blobs.download(attachment.url, MAX_BLOB_BYTES);
        const { url, sha256 } = await blobs.upload(data, mime, identity);
        tags.push(["imeta", `url ${url}`, `m ${mime}`, `x ${sha256}`, `size ${String(data.length)}`]);
        out.push({ url, filename: attachment.filename });
      } catch (error) {
        console.warn(`bridge: blossom rehost failed for ${attachment.url}`, error);
        out.push(attachment);
      }
    }
    return out;
  }

  /** NIP-92 imeta tags -> downloaded webhook file uploads (URL fallback). */
  private async filesFromImeta(
    chat: OpenedChat,
  ): Promise<{ files: Array<{ name: string; data: Uint8Array }>; urls: string[] } | undefined> {
    const blobs = this.options.blobs;
    if (!blobs) return undefined;
    const files: Array<{ name: string; data: Uint8Array }> = [];
    const urls: string[] = [];
    for (const tag of chat.tags) {
      if (tag[0] !== "imeta") continue;
      const fields = new Map(tag.slice(1).map((f) => [f.split(" ")[0], f.slice(f.indexOf(" ") + 1)]));
      const url = fields.get("url");
      if (!url) continue;
      const size = Number(fields.get("size") ?? 0);
      if (size > MAX_BLOB_BYTES) continue; // stays a link in the content
      try {
        const { data, mime } = await blobs.download(url, MAX_BLOB_BYTES);
        const name = new URL(url).pathname.split("/").pop() || `file.${(mime.split("/")[1] ?? "bin").split("+")[0]}`;
        files.push({ name, data });
        urls.push(url);
      } catch (error) {
        console.warn(`bridge: imeta download failed for ${url}`, error);
      }
    }
    return files.length > 0 ? { files, urls } : undefined;
  }
}

/**
 * URLs that ride as file uploads leave the content, or Discord renders the
 * media twice (link unfurl + attachment). Oversized/failed blobs never make
 * this list, so their links survive.
 */
function stripAttachedUrls(content: string, urls: string[] | undefined): string {
  if (!urls || urls.length === 0) return content;
  let text = content;
  for (const url of urls) text = text.split(url).join("");
  return text.replace(/[^\S\n]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** In-memory store for tests and dry runs; Postgres implementation in db/. */
export class MemoryMappingStore implements MappingStore {
  rows: MessageMappingRow[] = [];
  async insert(row: MessageMappingRow): Promise<void> {
    this.rows.push(row);
  }
  async byRumorId(rumorId: string): Promise<MessageMappingRow[]> {
    return this.rows.filter((r) => r.concordRumorId === rumorId);
  }
  async byDiscordId(discordMessageId: string): Promise<MessageMappingRow[]> {
    return this.rows.filter((r) => r.discordMessageId === discordMessageId);
  }
  reactions: ReactionMappingRow[] = [];
  async insertReaction(row: ReactionMappingRow): Promise<void> {
    this.reactions.push(row);
  }
  async reactionByDiscord(messageId: string, userId: string, emoji: string): Promise<ReactionMappingRow | undefined> {
    return this.reactions.find(
      (r) => r.discordMessageId === messageId && r.authorRef === userId && r.emoji === emoji,
    );
  }
  async reactionByRumorId(rumorId: string): Promise<ReactionMappingRow | undefined> {
    return this.reactions.find((r) => r.rumorId === rumorId);
  }
  async deleteReaction(rumorId: string): Promise<void> {
    this.reactions = this.reactions.filter((r) => r.rumorId !== rumorId);
  }
  async countConcordReactions(messageId: string, emoji: string): Promise<number> {
    return this.reactions.filter(
      (r) => r.origin === "concord" && r.discordMessageId === messageId && r.emoji === emoji,
    ).length;
  }
}
