/**
 * Discord adapter: gateway ingestion and webhook impersonation.
 *
 * Gateway: GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT (privileged; toggle in
 * the developer portal). Messages map to the router's transport-agnostic
 * DiscordInboundMessage; discord.js types never cross the router boundary.
 *
 * Webhooks: one `armada-bridge` webhook per bridged channel, created on
 * demand and cached; per-message username/avatar overrides render Concord
 * members. Mentions are never forwarded as pings (allowedMentions: none).
 */

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type Webhook,
} from "discord.js";

import type {
  ChannelLink,
  DiscordInboundMessage,
  DiscordMessageDelete,
  DiscordReactionAdd,
  WebhookSender,
} from "../router";

export const BRIDGE_WEBHOOK_NAME = "armada-bridge";

export function toInbound(message: Message): DiscordInboundMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? "",
    author: {
      id: message.author.id,
      display: message.member?.displayName ?? message.author.displayName ?? message.author.username,
      avatarUrl: message.author.displayAvatarURL?.(),
      bot: message.author.bot,
    },
    content: message.content,
    attachments: [...message.attachments.values()].map((a) => ({ url: a.url, filename: a.name })),
    mentions: [...message.mentions.users.values()].map((u) => ({
      id: u.id,
      display: message.mentions.members?.get(u.id)?.displayName ?? u.displayName ?? u.username,
    })),
    webhookId: message.webhookId ?? undefined,
    applicationId: message.applicationId ?? undefined,
    referencedMessageId: message.reference?.messageId ?? undefined,
  };
}

export interface DiscordAdapterHandlers {
  onMessage(msg: DiscordInboundMessage): Promise<void>;
  onMessageDelete?(del: DiscordMessageDelete): Promise<void>;
  onReactionAdd?(reaction: DiscordReactionAdd): Promise<void>;
}

export class DiscordAdapter implements WebhookSender {
  readonly client: Client;
  /** Webhook ids we created; the router uses this set for echo suppression. */
  readonly ownWebhookIds = new Set<string>();
  private readonly webhookCache = new Map<string, Webhook>();

  constructor(
    private readonly token: string,
    private readonly handlers: DiscordAdapterHandlers,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      // Deletes and reactions arrive for uncached (pre-boot) messages too.
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
    this.client.on("messageCreate", (message) => {
      void this.handlers.onMessage(toInbound(message)).catch((error) => {
        console.error("bridge: onMessage failed", error);
      });
    });
    this.client.on("messageDelete", (message) => {
      void this.handlers
        .onMessageDelete?.({
          id: message.id,
          channelId: message.channelId,
          guildId: message.guildId ?? "",
        })
        .catch((error) => console.error("bridge: onMessageDelete failed", error));
    });
    this.client.on("messageReactionAdd", (reaction, user) => {
      void (async () => {
        if (user.id === this.client.user?.id) return; // our own bot reactions
        const full = reaction.partial ? await reaction.fetch() : reaction;
        const fullUser = user.partial ? await user.fetch() : user;
        await this.handlers.onReactionAdd?.({
          messageId: full.message.id,
          channelId: full.message.channelId,
          guildId: full.message.guildId ?? "",
          emoji: { name: full.emoji.name, id: full.emoji.id },
          user: {
            id: fullUser.id,
            display: fullUser.displayName ?? fullUser.username,
            avatarUrl: fullUser.displayAvatarURL?.(),
            bot: fullUser.bot,
          },
        });
      })().catch((error) => console.error("bridge: onReactionAdd failed", error));
    });
  }

  get applicationId(): string {
    return this.client.application?.id ?? "";
  }

  /** The bot account's own avatar, for the bridge's Concord kind 0. */
  get botAvatarUrl(): string | undefined {
    return this.client.user?.displayAvatarURL?.({ size: 256 });
  }

  async start(): Promise<void> {
    await this.client.login(this.token);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) return resolve();
      this.client.once("clientReady", () => resolve());
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async webhookFor(channelId: string): Promise<Webhook> {
    const cached = this.webhookCache.get(channelId);
    if (cached) return cached;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`channel ${channelId} is not a guild text channel`);
    }
    const text = channel as TextChannel;
    const existing = (await text.fetchWebhooks()).find(
      (wh) => wh.name === BRIDGE_WEBHOOK_NAME && wh.token,
    );
    const webhook =
      existing ??
      (await text.createWebhook({ name: BRIDGE_WEBHOOK_NAME, reason: "Armada bridge persona posts" }));
    this.webhookCache.set(channelId, webhook);
    this.ownWebhookIds.add(webhook.id);
    return webhook;
  }

  /** WebhookSender: post as a Concord member persona; returns message id. */
  async send(
    link: ChannelLink,
    message: {
      username: string;
      avatarUrl?: string;
      content: string;
      embeds?: Array<{ description: string }>;
    },
  ): Promise<string> {
    const webhook = await this.webhookFor(link.discordChannelId);
    const created = await webhook.send({
      content: message.content,
      username: sanitizeUsername(message.username),
      avatarURL: message.avatarUrl,
      embeds: message.embeds,
      allowedMentions: { parse: [] },
    });
    return created.id;
  }

  private async textChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`channel ${channelId} is not a guild text channel`);
    }
    return channel as TextChannel;
  }

  /**
   * WebhookSender: remove a bridged message. Webhook delete covers our own
   * mirrors; user-authored posts (moderator delete from the Armada side)
   * need the bot's Manage Messages permission.
   */
  async delete(link: ChannelLink, discordMessageId: string): Promise<void> {
    const webhook = await this.webhookFor(link.discordChannelId);
    try {
      await webhook.deleteMessage(discordMessageId);
    } catch {
      const channel = await this.textChannel(link.discordChannelId);
      await channel.messages.delete(discordMessageId);
    }
  }

  /** WebhookSender: react as the bot account (webhooks cannot react). */
  async react(link: ChannelLink, discordMessageId: string, emoji: string): Promise<void> {
    const channel = await this.textChannel(link.discordChannelId);
    const message = await channel.messages.fetch(discordMessageId);
    await message.react(emoji);
  }
}

/** Discord rejects usernames <2 or >80 chars or containing "discord". */
export function sanitizeUsername(name: string): string {
  const cleaned = name.replace(/discord/gi, "d1scord").trim();
  if (cleaned.length < 2) return `nostr ${cleaned}`.trim().padEnd(2, "_");
  return cleaned.slice(0, 80);
}
