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

import { KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_MESSAGE, KIND_REACTION, KIND_TYPING } from "@armada-bridge/concord-core";
import type { OpenedChat } from "@armada-bridge/concord-core";

import type { ConcordClient } from "./concord/client";
import { hasProxyTag, proxyTag } from "./concord/client";
import { localIdentity } from "./concord/signer";
import type { LocalIdentity } from "./concord/signer";
import { CONCORD_EFFECT_METHODS, guardEffects } from "./effectGuard";
import { ffmpegAvailable, mp4ToGif } from "./gif";
import {
  attachmentFilename,
  decryptBlob,
  imetaFields,
  isSupportedEncryption,
  mimeFromUrl,
  parseImetaEncryption,
  withExtension,
} from "./imeta";
import { isKlipyMediaHost, klipyItem } from "./klipy";
import type { KlipyClient } from "./klipy";
import { safeProbe } from "./net";

type LocalIdentitySigner = LocalIdentity["signer"];
import type { PuppetCache } from "./puppets";
import { DISCORD_MAX_CHARS, concordToDiscord, discordToConcord, splitForDiscord, substitutedEmbedMedia } from "./transform";
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
  /**
   * Original send time (epoch ms). Live gateway traffic omits it (now);
   * history backfill sets it so the rumor carries the historical timestamp.
   */
  timestampMs?: number;
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
  emoji: { name: string | null; id: string | null; animated?: boolean };
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
  /** Show the bot's typing indicator in the channel (lasts ~10s on Discord). */
  sendTyping(link: ChannelLink): Promise<void>;
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
  /** Required at runtime: fresh public-channel permissions and current worker ownership. */
  beforeSideEffect?: () => Promise<void>;
  /** Kind 3302 is not frozen in the CORDs yet; off by default. */
  bridgeEdits?: boolean;
  /** When set, attachments rehost through Blossom instead of rotting CDN links. */
  blobs?: BlobPort;
  /** Resolves Klipy GIF-picker sends to their real GIF (KLIPY_API_KEY). */
  klipy?: Pick<KlipyClient, "resolveGif">;
}

/** Attachment ceiling both ways (webhook upload limit for standard guilds). */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

/**
 * Download ATTEMPTS per inbound rumor. Discord accepts 10 attachments per
 * message, so anything past this could never be sent anyway — but the tag
 * count is attacker-chosen and the downloads used to run before the send was
 * attempted, which made one rumor with a few hundred `imeta` tags into a few
 * gigabytes of buffering and a few hundred outbound requests.
 *
 * Counting attempts rather than successes is the whole point: a cap on
 * successes is no cap at all against URLs chosen to fail.
 */
const MAX_IMETA_DOWNLOADS = 10;

/**
 * Total attachment bytes held in memory while assembling ONE inbound rumor.
 *
 * The per-file cap and the attempt cap multiply: ten files at MAX_BLOB_BYTES
 * is 100 MB retained at once, and nothing serialises rumors against each
 * other, so N concurrent ones are N times that. The process this happens in
 * also holds PORTAL_SEAL_KEY, so "it eventually OOMs" is not a survivable
 * outcome. Set above Discord's own per-message ceiling: a rumor that exceeds
 * this could not have been delivered whole in any case.
 */
const MAX_IMETA_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * Discord messages one inbound rumor may fan out into.
 *
 * Each part is a webhook send AND a mapping row, so the split is the cheapest
 * amplifier in the bridge. Ten parts is 20,000 characters — far past any real
 * chat message, and a tenth of the worst case.
 */
const MAX_DISCORD_PARTS = 10;

/**
 * Inbound rumors allowed to queue for one bridged channel before new ones are
 * dropped. Deep enough that a legitimate burst or a catch-up backfill never
 * touches it; shallow enough that a flood cannot grow the heap without bound.
 */
const MAX_QUEUED_CHATS = 200;

/**
 * Longest emoji we will hand to Discord's reaction API, in code points. Real
 * ZWJ sequences top out around ten ("👨‍👩‍👧‍👦" is seven, plus variation
 * selectors); this leaves headroom without letting a whole message through.
 */
const MAX_REACTION_CODEPOINTS = 16;

/**
 * NIP-25 reaction content -> a Discord-reactable unicode emoji, or undefined
 * for content Discord would reject ("+"/"" mean like, "-" dislike; NIP-30
 * `:shortcode:` custom emoji have no Discord equivalent).
 *
 * The test used to be "contains a pictograph" while the RETURN was the entire
 * trimmed content, so a kind 7 whose content was "👍" followed by 60KB of text
 * put all 60KB into an API path. Containing an emoji is not being one: the
 * whole string now has to be emoji scaffolding — pictographs, components
 * (skin tones, regional indicators), ZWJ and variation selectors — and short.
 */
export function reactionEmoji(content: string): string | undefined {
  const c = content.trim();
  if (c === "" || c === "+") return "👍";
  if (c === "-") return "👎";
  if (/^:.+:$/.test(c)) return undefined;
  // A pictograph must be PRESENT — Emoji_Component alone admits bare digits,
  // which are keycap parts — and must be all there IS.
  if (!/\p{Extended_Pictographic}/u.test(c)) return undefined;
  if ([...c].length > MAX_REACTION_CODEPOINTS) return undefined;
  // \u200D = ZWJ (joins sequences), \uFE0F = VS16 (emoji presentation); both
  // are invisible in source, so they are written as escapes.
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200D|\uFE0F)+$/u.test(c)) return undefined;
  return c;
}

/**
 * Longest display name we will place in an embed. Discord's description cap is
 * 4096; a name is not what should be allowed to approach it.
 */
const MAX_EMBED_NAME_CHARS = 80;

/**
 * Neutralise Discord markdown in text somebody else wrote, for the one place
 * bridged text lands in bridge-authored chrome rather than in a puppet's own
 * message: the reply embed.
 *
 * Backslash-escaping is what Discord itself honours. `[`/`]`/`(`/`)` are the
 * pair that matters (link syntax); the emphasis and spoiler marks are included
 * so a name cannot restyle the sentence around it, and `\` first so the
 * escapes we add are not themselves escaped away.
 */
export function escapeMarkdown(text: string): string {
  const clipped = text.length > MAX_EMBED_NAME_CHARS ? `${text.slice(0, MAX_EMBED_NAME_CHARS)}…` : text;
  return clipped.replace(/[\\`*_~|[\]()>#-]/g, (ch) => `\\${ch}`);
}

/** Stable, public CDN URL for a Discord custom emoji. */
export function discordEmojiUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`;
}

/**
 * Discord's own rule for a custom-emoji name. Both directions validate against
 * it, because on the way back to Discord the shortcode goes into an API PATH:
 * a kind 7 whose emoji tag named itself with 60KB of text put all 60KB into
 * `PUT /channels/…/reactions/{emoji}/@me`. This is the same bound the unicode
 * path already had — the `??` fallback beside it simply never got one.
 */
const EMOJI_NAME_RE = /^\w{2,32}$/;

/**
 * The emoji id in a Discord CDN URL, or undefined if the URL is not one.
 *
 * Parsed rather than substring-matched: the old test looked for
 * `cdn.discordapp.com/emojis/<digits>.` ANYWHERE in the string, so
 * `https://evil.example/?x=cdn.discordapp.com/emojis/1.` passed and a foreign
 * host got to name the emoji Discord would be asked about.
 */
function discordEmoji(raw: string): { id: string; animated: boolean } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com") return undefined;
  const match = /^\/emojis\/(\d{1,25})\.(\w+)$/.exec(url.pathname);
  return match ? { id: match[1], animated: match[2] === "gif" } : undefined;
}

/**
 * Custom emoji in raw Discord content (`<:name:id>` / `<a:name:id>`) ->
 * NIP-30 `["emoji", shortcode, url]` tags, one per distinct shortcode. The
 * transform flattens the markup to `:name:`; these tags let Armada render
 * the image (the client reads a message's own emoji tags first).
 */
export function customEmojiTags(content: string): string[][] {
  const tags: string[][] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/<(a?):(\w+):(\d+)>/g)) {
    const [, animated, name, id] = match;
    if (seen.has(name)) continue;
    seen.add(name);
    tags.push(["emoji", name, discordEmojiUrl(id, animated === "a")]);
  }
  return tags;
}

/**
 * The reverse of customEmojiTags: an Armada message's NIP-30 `:shortcode:`
 * whose emoji tag points at Discord's emoji CDN becomes native Discord
 * markup (`<:name:id>` / `<a:name:id>`), so mirrors render the image
 * instead of a bare shortcode. Foreign emoji URLs stay as text.
 */
export function applyCustomEmoji(content: string, tags: string[][]): string {
  let out = content;
  for (const tag of tags) {
    if (tag[0] !== "emoji" || !tag[1] || !tag[2]) continue;
    if (!EMOJI_NAME_RE.test(tag[1])) continue;
    const emoji = discordEmoji(tag[2]);
    if (!emoji) continue;
    out = out.split(`:${tag[1]}:`).join(`<${emoji.animated ? "a" : ""}:${tag[1]}:${emoji.id}>`);
  }
  return out;
}

/**
 * An Armada custom-emoji reaction whose image lives on Discord's emoji CDN
 * maps back to the native emoji (`name:id`, reactable by the bot). Foreign
 * custom emoji have no Discord equivalent and stay Armada-side.
 */
export function concordCustomEmojiToDiscord(tags: string[][]): string | undefined {
  const tag = tags.find((t) => t[0] === "emoji" && t[1] && t[2]);
  if (!tag) return undefined;
  const emoji = discordEmoji(tag[2]);
  return emoji && EMOJI_NAME_RE.test(tag[1]) ? `${tag[1]}:${emoji.id}` : undefined;
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
  probe: typeof safeProbe = safeProbe,
): Promise<string> {
  if (/\.gif(\?|$)/i.test(mediaUrl)) return mediaUrl;
  // Klipy answers every missing rendition with one placeholder image — 200,
  // `image/gif` — so the swap below "verifies" for every Klipy send and the
  // placeholder crosses instead of the GIF. Its page URL is behind a
  // Cloudflare challenge besides. Only the Items API (see klipy.ts) knows the
  // real .gif; without it the mp4 goes to the transcode fallback.
  if (isKlipyMediaHost(mediaUrl) || isKlipyMediaHost(pageUrl)) return mediaUrl;
  const candidates = [
    mediaUrl.replace(/\.mp4(\?|$)/i, ".gif$1"),
    `${pageUrl.replace(/\/+$/, "")}.gif`,
  ].filter((url) => url !== mediaUrl);
  for (const url of candidates) {
    // Guarded, not a bare fetch: `mediaUrl` is an OpenGraph value read off
    // whatever page the message linked, so the author picks the host this
    // probe is aimed at. A dead or refused candidate is undefined either way.
    const res = await probe(url);
    if (res?.ok && res.mime.startsWith("image/")) return url;
  }
  return mediaUrl;
}

/** When the message is only a GIF-picker page link, upgrade its embed media to a true .gif. */
export async function upgradeGifEmbed(
  msg: DiscordInboundMessage,
  probe: typeof safeProbe = safeProbe,
): Promise<DiscordInboundMessage> {
  const bare = msg.content.trim();
  if (!/^https?:\/\/\S+$/.test(bare)) return msg;
  const embed = msg.embeds?.find((e) => e.url === bare && e.mediaUrl);
  if (!embed?.mediaUrl) return msg;
  const mediaUrl = await resolveGifVariant(bare, embed.mediaUrl, probe);
  return { ...msg, embeds: [{ url: embed.url, mediaUrl }] };
}

/** Minimum gap between forwarded typing signals, per direction key. */
const TYPING_THROTTLE_MS = 4_000;

export class BridgeRouter {
  /** discord user id -> last published "name|avatar" (skip republishing). */
  private readonly publishedProfiles = new Map<string, string>();
  /** discord user ids whose puppet published a Guestbook join this run. */
  private readonly joinedPuppets = new Set<string>();
  /** throttle state: direction key -> last forwarded typing signal (ms). */
  private readonly lastTyping = new Map<string, number>();

  constructor(
    private readonly client: ConcordClient,
    private readonly puppets: PuppetCache,
    private readonly store: MappingStore,
    private readonly webhooks: WebhookSender,
    private readonly profiles: ProfileResolver,
    private readonly self: { applicationId: string; webhookIds: Set<string> },
    private readonly options: RouterOptions = {},
  ) {
    const before = options.beforeSideEffect ?? (() => this.assertMayForward());
    this.client = guardEffects(client, before, CONCORD_EFFECT_METHODS);
    this.webhooks = guardEffects(webhooks, before, new Set(["send", "edit", "delete", "react", "unreact", "sendTyping"]));
    this.options = {
      ...options,
      blobs: options.blobs && guardEffects(options.blobs, before, new Set(["download", "upload"])),
      klipy: options.klipy && guardEffects(options.klipy, before, new Set(["resolveGif"])),
    };
  }

  private async assertMayForward(): Promise<void> {
    if (!this.options.beforeSideEffect) throw new Error("Public channel policy is not configured");
    await this.options.beforeSideEffect();
  }

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

  /**
   * Guestbook join (kind 3306) the first time a puppet speaks, so bridged
   * users show in the Armada member list. Backdated to the message for
   * history imports. Failure tolerated: retried on the puppet's next message.
   */
  private async publishPuppetJoin(
    discordUserId: string,
    identity: LocalIdentity,
    ms?: number,
  ): Promise<void> {
    if (this.joinedPuppets.has(discordUserId)) return;
    try {
      await this.client.publishJoin(ms ?? Date.now(), identity);
      this.joinedPuppets.add(discordUserId);
    } catch (error) {
      console.warn(`bridge: guestbook join failed for ${discordUserId}`, error);
    }
  }

  /**
   * Discord TYPING_START -> ephemeral kind 23311 from the user's puppet.
   * Throttled per user+channel to Armada's own publisher cadence.
   */
  async onDiscordTyping(userId: string, link: ChannelLink): Promise<void> {
    await this.assertMayForward();
    if (!link.enabled) return;
    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return;
    const key = `d:${link.discordChannelId}:${userId}`;
    const now = Date.now();
    if (now - (this.lastTyping.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
    this.lastTyping.set(key, now);
    const puppet = this.puppets.get(userId);
    if (this.client.isBanned(puppet.pk)) return;
    await this.client.sendTyping(channel, { pk: puppet.pk, signer: localIdentity(puppet.sk).signer });
  }

  /** Discord -> Concord. Returns the rumor id, or undefined when skipped. */
  async onDiscordMessage(msg: DiscordInboundMessage, link: ChannelLink): Promise<string | undefined> {
    if (!link.enabled) return undefined;
    // Layer 1: our own webhook posts and application messages never bounce back.
    if (msg.webhookId && this.self.webhookIds.has(msg.webhookId)) return undefined;
    if (msg.applicationId && msg.applicationId === this.self.applicationId) return undefined;
    // Other bots are configurable later; skipped by default to avoid bot loops.
    if (msg.author.bot) return undefined;
    await this.assertMayForward();

    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return undefined; // deleted or key not held; nothing to do

    const puppet = this.puppets.get(msg.author.id);
    const identity = { pk: puppet.pk, signer: localIdentity(puppet.sk).signer };

    const tags = [proxyTag(msg.guildId, msg.channelId, msg.id), ...customEmojiTags(msg.content)];
    let source =
      (await this.klipyGif(msg, identity, tags)) ??
      (await this.transcodedGifFallback(await upgradeGifEmbed(msg), identity, tags));
    this.tagEmbedMedia(source, tags);
    const attachments = await this.rehostAttachments(source, identity, tags);
    const content = discordToConcord({ ...source, attachments });
    if (content.length === 0) return undefined;

    await this.publishPuppetJoin(msg.author.id, identity, msg.timestampMs);
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
      ms: msg.timestampMs,
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
  /**
   * Mirror an inbound rumor, one at a time per bridged channel.
   *
   * Both entry points dispatch these fire-and-forget (`void
   * router.onConcordChat(...)`), so before this they ran fully concurrently
   * and a burst held every rumor's attachments at once — the per-rumor byte
   * budget bounds one rumor, not N of them. Serialising also gives the mirror
   * the ordering a channel is expected to have, which concurrent dispatch
   * never guaranteed.
   *
   * Awaiting callers (backfill) keep working: the returned promise settles
   * when this rumor's turn finishes.
   */
  async onConcordChat(chat: OpenedChat, link: ChannelLink): Promise<string[]> {
    await this.assertMayForward();
    if (this.queued >= MAX_QUEUED_CHATS) {
      // Shedding load beats unbounded growth: past this the sender is flooding
      // and the relay copy is still the record. Loud, because it is data loss.
      console.warn(
        `bridge: dropping inbound rumor ${chat.rumorId.slice(0, 8)}… — ${this.queued} already queued for ${link.discordChannelId}`,
      );
      return [];
    }
    this.queued++;
    const run = this.chatQueue.then(() => this.dispatchConcordChat(chat, link));
    // The chain must survive a failed rumor, or one throw stops the channel.
    this.chatQueue = run.then(
      () => {},
      () => {},
    );
    try {
      return await run;
    } finally {
      this.queued--;
    }
  }

  private chatQueue: Promise<void> = Promise.resolve();
  private queued = 0;

  private async dispatchConcordChat(chat: OpenedChat, link: ChannelLink): Promise<string[]> {
    if (!link.enabled) return [];
    // Layer 1 + 2: bridge-originated or already-bridged rumors never bounce.
    // The primary's own posts (confirm requests, announcements) stay
    // Armada-side; mirroring them trips Discord's webhook username filter
    // ("Discord <-> Armada Bridge Bot") and is noise regardless.
    if (chat.author === this.client.primaryPk) return [];
    if (hasProxyTag(chat)) return [];
    if (this.puppets.isPuppetPubkey(chat.author)) return [];
    if (this.client.isBanned(chat.author)) return [];

    if (chat.kind === KIND_TYPING) {
      // Ephemeral: forward as the bot's typing indicator, throttled per
      // channel (Discord's indicator lasts ~10s; Armada publishes every 4s).
      const key = `c:${link.discordChannelId}`;
      const now = Date.now();
      if (now - (this.lastTyping.get(key) ?? 0) >= TYPING_THROTTLE_MS) {
        this.lastTyping.set(key, now);
        await this.webhooks.sendTyping(link).catch(() => {});
      }
      return [];
    }
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
    const all = splitForDiscord(
      applyCustomEmoji(concordToDiscord(stripAttachedUrls(chat.content, media?.urls)), chat.tags),
    );
    // Cap the fan-out. Inbound length is bounded only by what NIP-44 can carry
    // (~64 KB), and CONCORD_MAX_CHARS is enforced on the way OUT, so without
    // this one publish by one member becomes ~33 webhook sends and 33 mapping
    // rows in the mirrored channel — a flood amplifier available to anyone who
    // can post in the Concord channel.
    const parts = all.slice(0, MAX_DISCORD_PARTS);
    const dropped = all.length - parts.length;
    if (dropped > 0) {
      // Say so in-channel rather than silently losing the tail; replace the
      // end of the last part instead of appending, which would overrun 2000.
      const notice = `\n… ${dropped} more part${dropped === 1 ? "" : "s"} not mirrored`;
      const kept = parts[parts.length - 1].slice(0, Math.max(0, DISCORD_MAX_CHARS - notice.length));
      parts[parts.length - 1] = `${kept}${notice}`;
    }
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
    await this.assertMayForward();
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
    await this.assertMayForward();
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

  /**
   * Discord MESSAGE_REACTION_ADD -> kind 7 from the reactor's puppet.
   * Custom guild emoji carry NIP-30: content `:name:` + an `emoji` tag with
   * the stable CDN image, self-contained for any Armada reader.
   */
  async onDiscordReaction(reaction: DiscordReactionAdd, link: ChannelLink): Promise<string | undefined> {
    if (!link.enabled) return undefined;
    if (reaction.user.bot) return undefined;
    await this.assertMayForward();
    if (!reaction.emoji.name) return undefined;
    const custom = reaction.emoji.id !== null;
    const content = custom ? `:${reaction.emoji.name}:` : reaction.emoji.name;
    // Mapping key: unicode as-is; custom as name:id (what the bot reacts with).
    const emojiKey = custom ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name;

    const [row] = await this.store.byDiscordId(reaction.messageId);
    if (!row) return undefined;
    const channel = this.client.channel(link.concordChannelIdHex);
    if (!channel) return undefined;

    const puppet = this.puppets.get(reaction.user.id);
    const identity = { pk: puppet.pk, signer: localIdentity(puppet.sk).signer };
    await this.publishPuppetJoin(reaction.user.id, identity, Date.now());
    await this.syncPuppetProfile(reaction.user, identity).catch((error) =>
      console.warn(`bridge: puppet profile publish failed for ${reaction.user.id}`, error),
    );

    const tags = [
      ["e", row.concordRumorId],
      ["k", String(KIND_MESSAGE)],
      proxyTag(reaction.guildId, reaction.channelId, reaction.messageId),
    ];
    if (custom) {
      tags.push(["emoji", reaction.emoji.name, discordEmojiUrl(reaction.emoji.id!, reaction.emoji.animated === true)]);
    }
    const { rumor } = await this.client.sendChat(channel, {
      kind: KIND_REACTION,
      content,
      author: identity,
      tags,
    });
    await this.store.insertReaction({
      rumorId: rumor.id,
      discordMessageId: reaction.messageId,
      emoji: emojiKey,
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
    await this.assertMayForward();
    if (!reaction.emoji.name) return undefined;
    const emojiKey = reaction.emoji.id ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name;

    const row = await this.store.reactionByDiscord(reaction.messageId, reaction.user.id, emojiKey);
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
    // Unicode maps directly; an Armada custom emoji maps back only when its
    // image is a Discord CDN emoji (i.e. originally bridged from Discord).
    const emoji = reactionEmoji(chat.content) ?? concordCustomEmojiToDiscord(chat.tags);
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
      // The name is a kind 0 field, so its author chooses it, and Discord
      // renders markdown in an embed description. Unescaped, a display_name of
      // `[#general](https://phishing.example)` produced an arbitrary link
      // inside an embed the BRIDGE authored, borrowing its apparent authority.
      return { description: `Replying to ${escapeMarkdown(profile.name)} ([view message](${url}))` };
    }
    return { description: `Replying to [this message](${url})` };
  }

  /**
   * Last resort for gifv embeds with no real .gif anywhere (Klipy): download
   * the short mp4, transcode with ffmpeg, rehost on Blossom. Skipped without
   * ffmpeg or a Blossom server; any failure keeps the mp4 URL.
   *
   * The transcode used to succeed and still arrive as a link, because a
   * Blossom URL is content-addressed (`/<sha256>`) and the bytes never got an
   * `imeta` tag — this function only ever rewrote the embed, and only
   * `rehostAttachments` emitted tags, for `msg.attachments`, which a GIF-picker
   * send does not have. Both halves are fixed: the extension goes back on the
   * URL, and {@link tagEmbedMedia} tags what lands in the content.
   */
  private async transcodedGifFallback(
    msg: DiscordInboundMessage,
    identity: LocalIdentity,
    tags: string[][],
  ): Promise<DiscordInboundMessage> {
    const blobs = this.options.blobs;
    const embed = msg.embeds?.[0];
    if (!blobs || !embed?.mediaUrl || !/\.mp4(\?|$)/i.test(embed.mediaUrl)) return msg;
    if (embed.url !== msg.content.trim() || !ffmpegAvailable()) return msg;
    try {
      const { data } = await blobs.download(embed.mediaUrl, MAX_BLOB_BYTES);
      const gif = await mp4ToGif(data);
      if (gif.length > MAX_BLOB_BYTES) return msg;
      const uploaded = await blobs.upload(gif, "image/gif", identity);
      const url = withExtension(uploaded.url, "image/gif");
      tags.push(["imeta", `url ${url}`, "m image/gif", `x ${uploaded.sha256}`, `size ${String(gif.length)}`]);
      return { ...msg, embeds: [{ url: embed.url, mediaUrl: url }] };
    } catch (error) {
      console.warn(`gif transcode fallback failed for ${embed.mediaUrl}:`, error);
      return msg;
    }
  }

  /**
   * A Klipy GIF-picker send, resolved to its real GIF through the Items API
   * and rehosted on Blossom; undefined leaves the message to the generic
   * embed path.
   *
   * Keyed on the content alone, not on Discord's embed: the embed can arrive
   * in a later MESSAGE_UPDATE, and the slug in the page URL is all the lookup
   * needs. If Blossom is absent or refuses the upload, the Klipy URL itself is
   * still the real GIF, so it crosses tagged rather than falling back to the
   * mp4.
   */
  private async klipyGif(
    msg: DiscordInboundMessage,
    identity: LocalIdentity,
    tags: string[][],
  ): Promise<DiscordInboundMessage | undefined> {
    const klipy = this.options.klipy;
    const page = msg.content.trim();
    if (!klipy || !klipyItem(page)) return undefined;
    const gif = await klipy.resolveGif(page, MAX_BLOB_BYTES);
    if (!gif) return undefined;
    const dim = gif.width && gif.height ? [`dim ${String(gif.width)}x${String(gif.height)}`] : [];

    const blobs = this.options.blobs;
    if (blobs) {
      try {
        const { data } = await blobs.download(gif.url, MAX_BLOB_BYTES);
        // "GIF8": the Items API named this file, but the CDN is the one that
        // serves a placeholder for anything it cannot find.
        if (data.length < 4 || String.fromCharCode(...data.subarray(0, 4)) !== "GIF8") {
          throw new Error("klipy served something that is not a GIF");
        }
        const uploaded = await blobs.upload(data, "image/gif", identity);
        const url = withExtension(uploaded.url, "image/gif");
        tags.push(["imeta", `url ${url}`, "m image/gif", `x ${uploaded.sha256}`, `size ${String(data.length)}`, ...dim]);
        return { ...msg, embeds: [{ url: page, mediaUrl: url }] };
      } catch (error) {
        console.warn(`bridge: klipy rehost failed for ${gif.url}:`, error);
      }
    }
    tags.push(["imeta", `url ${gif.url}`, "m image/gif", ...dim]);
    return { ...msg, embeds: [{ url: page, mediaUrl: gif.url }] };
  }

  /**
   * Tag the media URL that replaces a GIF-picker page link in the content.
   *
   * Without this a picker send crosses as a bare URL and nothing else: no `m`,
   * no `x`, no `size`. Armada does inline a bare `…/x.gif` by extension, which
   * is why some of these worked — but a Klipy embed is an mp4 or a webp, a
   * transcoded rehost is an extension-less Blossom hash, and a URL with an
   * imeta entry is also the only one Armada exempts from tracking-param
   * stripping, which is what breaks a signed provider URL.
   *
   * Only the fields we actually know: the bytes here belong to a third-party
   * provider and are not downloaded, so there is no honest `x` or `size` to
   * publish. This is the same shape Armada's own GIF picker emits.
   */
  private tagEmbedMedia(msg: DiscordInboundMessage, tags: string[][]): void {
    const url = substitutedEmbedMedia(msg);
    if (!url) return;
    // The transcode path already published a fuller tag for this exact URL.
    if (tags.some((t) => t[0] === "imeta" && t.includes(`url ${url}`))) return;
    const mime = mimeFromUrl(url);
    if (!mime) return;
    tags.push(["imeta", `url ${url}`, `m ${mime}`]);
  }

  /**
   * Rehost Discord CDN attachments (signed URLs expire in ~24h) on Blossom,
   * signed by the puppet, and record NIP-92 imeta tags. Any failure falls back
   * to the CDN link so the message still bridges.
   */
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
        // A served `application/octet-stream` tells us nothing, and it is what
        // decides whether the far side renders the image or a download card.
        // The Discord CDN filename is the better witness in exactly that case.
        const type =
          mime === "application/octet-stream" ? (mimeFromUrl(attachment.url) ?? mime) : mime;
        const uploaded = await blobs.upload(data, type, identity);
        // Content-addressed URLs arrive extension-less unless the server chose
        // to add one; BUD-01 serves the same blob either way, and the extension
        // is what Discord's unfurl and Armada's sniffing read.
        const url = withExtension(uploaded.url, type);
        const imeta = ["imeta", `url ${url}`, `m ${type}`, `x ${uploaded.sha256}`, `size ${String(data.length)}`];
        // The original filename, so the far side can name a download and, if
        // the blob ever comes back through the bridge, so can we.
        if (attachment.filename) imeta.push(`name ${attachment.filename}`);
        tags.push(imeta);
        out.push({ url, filename: attachment.filename });
      } catch (error) {
        console.warn(`bridge: blossom rehost failed for ${attachment.url}`, error);
        out.push(attachment);
      }
    }
    return out;
  }

  /**
   * NIP-92 imeta tags -> downloaded webhook file uploads (URL fallback).
   *
   * Every attachment sent from a Concord community is client-encrypted, and
   * this read only ever looked at `url` and `size` — so the bytes handed to
   * Discord were AES-GCM ciphertext, uploaded under a filename taken from a
   * content-addressed URL that carries no extension either. Both halves of
   * that are fixed here: `imeta.ts` supplies the key material the tag was
   * already carrying, and the name comes from the `m` field, which is the only
   * thing that knows the plaintext type.
   */
  private async filesFromImeta(
    chat: OpenedChat,
  ): Promise<{ files: Array<{ name: string; data: Uint8Array }>; urls: string[] } | undefined> {
    const blobs = this.options.blobs;
    if (!blobs) return undefined;
    const files: Array<{ name: string; data: Uint8Array }> = [];
    const urls: string[] = [];
    // ATTEMPTS, not successes. Bounding `files.length` bounded only the happy
    // path: every download that 404s, refuses the connection or simply never
    // answers leaves the count untouched, so a rumor carrying a few thousand
    // dead imeta tags still made a few thousand sequential outbound requests.
    let attempted = 0;
    // Bytes actually held. MAX_BLOB_BYTES bounds ONE file; ten of them bounded
    // nothing that matters, because every download is retained in `files`
    // until the whole rumor is sent — 100 MB resident per rumor, and rumors
    // are dispatched concurrently (index.ts). This is the bound that keeps the
    // process alive, and it sits above what Discord accepts in one message, so
    // it costs no traffic that would have been delivered anyway.
    let held = 0;
    for (const tag of chat.tags) {
      if (tag[0] !== "imeta") continue;
      if (attempted >= MAX_IMETA_DOWNLOADS) break;
      const remaining = MAX_IMETA_TOTAL_BYTES - held;
      if (remaining <= 0) break;
      const fields = imetaFields(tag);
      const url = fields.get("url");
      if (!url) continue;
      const encryption = parseImetaEncryption(fields);
      // Encrypted with something we cannot apply. Fail closed the way Armada
      // does: leave the URL in the text rather than downloading. Uploading the
      // blob anyway is exactly the bug — Discord would attach ciphertext under
      // the sender's name, and nothing downstream would ever say why.
      if (encryption && !isSupportedEncryption(encryption)) {
        console.warn(`bridge: imeta ${url} uses unsupported encryption ${encryption.algorithm}`);
        continue;
      }
      // Advisory only: `size` is whatever the sender wrote, and is absent (so
      // 0) on a tag built to evade this. The real bound is the byte counter in
      // safeFetch; this just avoids starting a download that admits it is
      // oversized.
      const cap = Math.min(MAX_BLOB_BYTES, remaining);
      const size = Number(fields.get("size") ?? 0);
      if (size > cap) continue; // stays a link in the content
      attempted++;
      try {
        const { data, mime } = await blobs.download(url, cap);
        const plaintext = encryption ? decryptBlob(data, encryption) : data;
        // The `m` field wins over the served content-type. On an encrypted
        // attachment the response describes the CIPHERTEXT (Armada uploads it
        // under the plaintext type, but a Blossom server is free to serve
        // `application/octet-stream`), and the filename derived from it is the
        // only thing that tells Discord what it is holding.
        const type = fields.get("m") || mimeFromUrl(url) || mime;
        files.push({ name: attachmentFilename(url, type, fields.get("name")), data: plaintext });
        held += plaintext.length;
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
