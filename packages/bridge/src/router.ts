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

import type { OpenedChat } from "@armada-bridge/concord-core";

import type { ConcordClient } from "./concord/client";
import { hasProxyTag, proxyTag } from "./concord/client";
import { localIdentity } from "./concord/signer";
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
}

export interface WebhookSender {
  /** Post as the given persona; returns the created Discord message id. */
  send(
    link: ChannelLink,
    message: { username: string; avatarUrl?: string; content: string },
  ): Promise<string>;
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
  constructor(
    private readonly client: ConcordClient,
    private readonly puppets: PuppetCache,
    private readonly store: MappingStore,
    private readonly webhooks: WebhookSender,
    private readonly profiles: ProfileResolver,
    private readonly self: { applicationId: string; webhookIds: Set<string> },
  ) {}

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

    const { rumor } = await this.client.sendChat(channel, {
      content,
      author: { pk: puppet.pk, signer: localIdentity(puppet.sk).signer },
      tags: [proxyTag(msg.id)],
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
    if (chat.kind !== 9) return []; // MVP: plain messages only
    // Layer 1 + 2: bridge-originated or already-bridged rumors never bounce.
    if (hasProxyTag(chat)) return [];
    if (this.puppets.isPuppetPubkey(chat.author)) return [];
    if ((await this.store.byRumorId(chat.rumorId)).length > 0) return [];
    if (this.client.isBanned(chat.author)) return [];

    const profile = await this.profiles.resolve(chat.author).catch(() => fallbackProfile(chat.author));
    const parts = splitForDiscord(concordToDiscord(chat.content));

    const ids: string[] = [];
    for (const [index, part] of parts.entries()) {
      const discordMessageId = await this.webhooks.send(link, {
        username: profile.name,
        avatarUrl: profile.avatarUrl,
        content: part,
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
}
