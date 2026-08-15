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
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type TextChannel,
  type User,
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
    embeds: message.embeds.map((e) => {
      const urls = [e.video?.url, e.image?.url, e.thumbnail?.url].filter((u): u is string => !!u);
      // Prefer an actual .gif so Armada inlines motion; mp4 renders as video
      // or falls back to a direct-media link either way.
      const mediaUrl = urls.find((u) => /\.gif(\?|$)/i.test(u)) ?? urls[0];
      return { url: e.url ?? undefined, mediaUrl };
    }),
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
  /** Return true when the message was handled (consumed). */
  onBotCommand?(message: Message): boolean | Promise<boolean>;
  onMessageUpdate?(msg: DiscordInboundMessage): Promise<void>;
  onMessageDelete?(del: DiscordMessageDelete): Promise<void>;
  onReactionAdd?(reaction: DiscordReactionAdd): Promise<void>;
  onReactionRemove?(reaction: DiscordReactionAdd): Promise<void>;
  onTyping?(typing: { channelId: string; guildId: string; userId: string; bot: boolean }): Promise<void>;
}

/** Commands a plain `/command` message maps to; "/" alone is not one. */
export function parseBotCommand(content: string): string | undefined {
  const match = /^\/([a-z][a-z0-9-]*)\b/i.exec(content.trim());
  return match?.[1].toLowerCase();
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
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.MessageContent,
      ],
      // Deletes and reactions arrive for uncached (pre-boot) messages too.
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
    this.client.on("messageCreate", (message) => {
      // Guild-scoped bot commands the host intercepts BEFORE any router
      // (/help, /bridge); returning true consumes the message.
      if (this.handlers.onBotCommand?.(message)) return;
      void this.handlers.onMessage(toInbound(message)).catch((error) => {
        console.error("bridge: onMessage failed", error);
      });
    });
    this.client.on("messageUpdate", (_old, message) => {
      void (async () => {
        const full = message.partial ? await message.fetch() : message;
        await this.handlers.onMessageUpdate?.(toInbound(full));
      })().catch((error) => console.error("bridge: onMessageUpdate failed", error));
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
    const bridgeReaction = (
      handler: ((reaction: DiscordReactionAdd) => Promise<void>) | undefined,
      label: string,
    ) =>
      (
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
      ) => {
        void (async () => {
          if (user.id === this.client.user?.id) return; // our own bot reactions
          const full = reaction.partial ? await reaction.fetch() : reaction;
          const fullUser = user.partial ? await user.fetch() : user;
          await handler?.({
            messageId: full.message.id,
            channelId: full.message.channelId,
            guildId: full.message.guildId ?? "",
            emoji: { name: full.emoji.name, id: full.emoji.id, animated: full.emoji.animated ?? false },
            user: {
              id: fullUser.id,
              display: fullUser.displayName ?? fullUser.username,
              avatarUrl: fullUser.displayAvatarURL?.(),
              bot: fullUser.bot,
            },
          });
        })().catch((error) => console.error(`bridge: ${label} failed`, error));
      };
    this.client.on("messageReactionAdd", bridgeReaction((r) => this.handlers.onReactionAdd?.(r) ?? Promise.resolve(), "onReactionAdd"));
    this.client.on("messageReactionRemove", bridgeReaction((r) => this.handlers.onReactionRemove?.(r) ?? Promise.resolve(), "onReactionRemove"));
    this.client.on("typingStart", (typing) => {
      void this.handlers
        .onTyping?.({
          channelId: typing.channel.id,
          guildId: typing.guild?.id ?? "",
          userId: typing.user.id,
          bot: typing.user.bot ?? false,
        })
        .catch((error) => console.error("bridge: onTyping failed", error));
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
      files?: Array<{ name: string; data: Uint8Array }>;
    },
  ): Promise<string> {
    const webhook = await this.webhookFor(link.discordChannelId);
    const payload = (username: string) => ({
      content: message.content,
      username,
      avatarURL: message.avatarUrl,
      embeds: message.embeds,
      files: message.files?.map((f) => ({ attachment: Buffer.from(f.data), name: f.name })),
      allowedMentions: { parse: [] as [] },
    });
    try {
      const created = await webhook.send(payload(sanitizeUsername(message.username)));
      return created.id;
    } catch (error) {
      // Discord's username filter normalizes lookalike characters, so it can
      // reject names our sanitizer passed. Never drop the message over a
      // display name: retry once under a neutral one.
      if (!isUsernameRejection(error)) throw error;
      console.warn(`discord rejected webhook username ${JSON.stringify(message.username)}; retrying as "bridged member"`);
      const created = await webhook.send(payload("bridged member"));
      return created.id;
    }
  }

  /** WebhookSender: edit a webhook-authored mirror in place. */
  async edit(link: ChannelLink, discordMessageId: string, content: string): Promise<void> {
    const webhook = await this.webhookFor(link.discordChannelId);
    await webhook.editMessage(discordMessageId, { content, allowedMentions: { parse: [] } });
  }

  /**
   * Post a plain bot message (not a webhook) into a channel. Used for the
   * missing-permission notice: it needs only Send Messages, so it can still
   * land in the very channel where Manage Webhooks — and thus persona
   * mirroring — is what's missing.
   */
  async notice(channelId: string, content: string): Promise<void> {
    const channel = await this.textChannel(channelId);
    await channel.send({ content, allowedMentions: { parse: [] } });
  }

  /** Display name of a guild text channel (dashboard labels). */
  async channelName(channelId: string): Promise<string> {
    return (await this.textChannel(channelId)).name;
  }

  /** Display name of a guild (dashboard labels). */
  async guildName(guildId: string): Promise<string> {
    return (await this.client.guilds.fetch(guildId)).name;
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

  /** WebhookSender: show the bot's typing indicator (lasts ~10s or until a send). */
  async sendTyping(link: ChannelLink): Promise<void> {
    const channel = await this.textChannel(link.discordChannelId);
    await channel.sendTyping();
  }

  /** WebhookSender: react as the bot account (webhooks cannot react). */
  async react(link: ChannelLink, discordMessageId: string, emoji: string): Promise<void> {
    const channel = await this.textChannel(link.discordChannelId);
    const message = await channel.messages.fetch(discordMessageId);
    await message.react(emoji);
  }

  /**
   * WebhookSender: remove the bot's own reaction (custom emoji resolve by id).
   *
   * The name half is bounded even though it is discarded: this value is read
   * back out of the mapping row, and rows written before the sender validated
   * emoji names can hold anything. `.+` against a 60KB string is a quadratic
   * backtrack for a capture we do not use.
   */
  async unreact(link: ChannelLink, discordMessageId: string, emoji: string): Promise<void> {
    const custom = /^\w{2,32}:(\d{1,25})$/.exec(emoji);
    if (custom) emoji = custom[1];
    const channel = await this.textChannel(link.discordChannelId);
    const message = await channel.messages.fetch(discordMessageId);
    const botId = this.client.user?.id;
    if (!botId) return;
    await message.reactions.resolve(emoji)?.users.remove(botId);
  }
}

/**
 * Discord rejects webhook usernames <2 or >80 chars or containing "discord"
 * or "clyde", and its filter normalizes lookalikes (leetspeak substitutions
 * still match), so a letter is dropped rather than swapped.
 */
export function sanitizeUsername(name: string): string {
  const cleaned = name
    .replace(/discord/gi, "disc-rd")
    .replace(/clyde/gi, "cly-e")
    .trim();
  if (cleaned.length < 2) return `nostr ${cleaned}`.trim().padEnd(2, "_");
  return cleaned.slice(0, 80);
}

/** Error code 50035 with a USERNAME_INVALID flavored field error. */
function isUsernameRejection(error: unknown): boolean {
  const e = error as { code?: number; rawError?: unknown };
  return e?.code === 50035 && JSON.stringify(e.rawError ?? "").includes("USERNAME_INVALID");
}

/**
 * Discord's "Missing Permissions" (50013): the bot lacks a permission the
 * operation needed — for the bridge, almost always Manage Webhooks on the
 * mirrored channel. Surfaced so the manager can tell the owner instead of
 * silently retrying a send that will never land.
 */
export function isMissingPermissions(error: unknown): boolean {
  return (error as { code?: number })?.code === 50013;
}
