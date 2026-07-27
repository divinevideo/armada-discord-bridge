/**
 * Content transforms between Discord and Concord message text (MVP cut:
 * plain text fidelity; attachments ride as URLs, custom emoji flatten to
 * shortcodes). Richer mapping (imeta uploads, NIP-30 emoji tags, real
 * mention p-tags) layers on top later without changing these seams.
 */

export interface DiscordAttachmentIn {
  url: string;
  filename?: string;
}

export interface DiscordMentionIn {
  id: string;
  /** Server display name if known, else the username. */
  display: string;
}

export interface DiscordMessageContent {
  content: string;
  attachments?: DiscordAttachmentIn[];
  mentions?: DiscordMentionIn[];
  channelNames?: Record<string, string>;
  /** Unfurled embeds; GIF-picker messages hide the real media URL here. */
  embeds?: Array<{ url?: string; mediaUrl?: string }>;
}

/** Keep well under the 65,535-byte NIP-44 plaintext cap (multi-layer overhead). */
export const CONCORD_MAX_CHARS = 60_000;

/** Discord hard limit for webhook/bot message content. */
export const DISCORD_MAX_CHARS = 2_000;

/** Discord markup -> Concord plain text. */
export function discordToConcord(msg: DiscordMessageContent): string {
  let text = msg.content;

  // GIF-picker sends (Tenor, Klipy): the content is a provider PAGE url that
  // Discord renders via its embed. Armada only inlines direct media, so swap
  // in the embed's actual media URL when the message is just that page link.
  const bare = text.trim();
  if (/^https?:\/\/\S+$/.test(bare)) {
    const embed = msg.embeds?.find((e) => e.url === bare && e.mediaUrl);
    if (embed?.mediaUrl) text = embed.mediaUrl;
  }

  // <@id> and <@!id> user mentions -> @display
  text = text.replace(/<@!?(\d+)>/g, (raw, id: string) => {
    const mention = msg.mentions?.find((m) => m.id === id);
    return mention ? `@${mention.display}` : raw;
  });

  // <#id> channel mentions -> #name
  text = text.replace(/<#(\d+)>/g, (raw, id: string) => {
    const name = msg.channelNames?.[id];
    return name ? `#${name}` : raw;
  });

  // <:name:id> and <a:name:id> custom emoji -> :name:
  text = text.replace(/<a?:(\w+):\d+>/g, ":$1:");

  // Attachments append as bare URLs, one per line.
  const urls = (msg.attachments ?? []).map((a) => a.url).filter(Boolean);
  if (urls.length > 0) {
    text = [text.trimEnd(), ...urls].filter((s) => s.length > 0).join("\n");
  }

  if (text.length > CONCORD_MAX_CHARS) {
    text = `${text.slice(0, CONCORD_MAX_CHARS - 1)}…`;
  }
  return text;
}

/**
 * Concord plain text -> Discord: shorten bare nostr: identity URIs (Discord
 * renders them as dead links otherwise). Event/address URIs stay verbatim so
 * they remain copyable.
 */
export function concordToDiscord(content: string): string {
  return content.replace(/nostr:(npub1|nprofile1)([02-9ac-hj-np-z]+)/g, (_raw, prefix: string, body: string) => {
    return `@${prefix}${body.slice(0, 8)}…`;
  });
}

/**
 * Split for Discord's 2,000-char limit, preferring newline then space
 * boundaries so words and code fences survive where possible.
 */
export function splitForDiscord(content: string, max = DISCORD_MAX_CHARS): string[] {
  if (content.length <= max) return [content];
  const parts: string[] = [];
  let rest = content;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
