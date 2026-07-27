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

import { KIND_DELETE, KIND_MESSAGE, KIND_REACTION } from "@armada-bridge/concord-core";
import type { OpenedChat } from "@armada-bridge/concord-core";

import type { ConcordClient } from "./concord/client";
import { hasProxyTag, proxyTag } from "./concord/client";
import { localIdentity } from "./concord/signer";
import type { LocalIdentity } from "./concord/signer";

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

export interface MappingStore {
  insert(row: MessageMappingRow): Promise<void>;
  byRumorId(rumorId: string): Promise<MessageMappingRow[]>;
  byDiscordId(discordMessageId: string): Promise<MessageMappingRow[]>;
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
    },
  ): Promise<string>;
  /** Remove a bridged message (webhook delete; bot delete for user posts). */
  delete(link: ChannelLink, discordMessageId: string): Promise<void>;
  /** React as the bot account (webhooks cannot react). */
  react(link: ChannelLink, discordMessageId: string, emoji: string): Promise<void>;
}

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
    const content = discordToConcord(msg);
    if (content.length === 0) return undefined;

    const identity = { pk: puppet.pk, signer: localIdentity(puppet.sk).signer };
    await this.syncPuppetProfile(msg.author, identity).catch((error) =>
      console.warn(`bridge: puppet profile publish failed for ${msg.author.id}`, error),
    );

    const tags = [proxyTag(msg.id)];
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
    if (chat.kind !== KIND_MESSAGE) return []; // threads/edits/zaps: not yet bridged
    if ((await this.store.byRumorId(chat.rumorId)).length > 0) return [];

    const profile = await this.profiles.resolve(chat.author).catch(() => fallbackProfile(chat.author));
    const parts = splitForDiscord(concordToDiscord(chat.content));
    const reply = await this.replyEmbed(chat, link);

    const ids: string[] = [];
    for (const [index, part] of parts.entries()) {
      const discordMessageId = await this.webhooks.send(link, {
        username: profile.name,
        avatarUrl: profile.avatarUrl,
        content: part,
        embeds: index === 0 && reply ? [reply] : undefined,
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
      tags: [["e", row.concordRumorId], proxyTag(del.id)],
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
        proxyTag(reaction.messageId),
      ],
    });
    return rumor.id;
  }

  /**
   * Kind 5 -> remove every mapped Discord part. Honored for the rumor's own
   * author and for MANAGE_MESSAGES holders (moderator deletes propagate).
   */
  private async onConcordDelete(chat: OpenedChat, link: ChannelLink): Promise<void> {
    const targets = chat.tags.filter((t) => t[0] === "e" && t[1]).map((t) => t[1]);
    for (const target of targets) {
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

  /** Kind 7 -> bot reaction on the mapped Discord message (add-only). */
  private async onConcordReaction(chat: OpenedChat, link: ChannelLink): Promise<void> {
    const target = chat.tags.find((t) => t[0] === "e" && t[1])?.[1];
    if (!target) return;
    const emoji = reactionEmoji(chat.content);
    if (!emoji) return;
    const rows = await this.store.byRumorId(target);
    const row = rows.find((r) => r.partIndex === 0) ?? rows[0];
    if (!row) return;
    await this.webhooks.react(link, row.discordMessageId, emoji);
  }

  /** A kind 9 `q` tag -> an embed linking the mapped Discord message. */
  private async replyEmbed(
    chat: OpenedChat,
    link: ChannelLink,
  ): Promise<{ description: string } | undefined> {
    const target = chat.tags.find((t) => t[0] === "q" && t[1])?.[1];
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
}
