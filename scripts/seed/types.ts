/**
 * The seed content model.
 *
 * A Persona is a GLOBAL person, not a community role: one npub, one profile,
 * a set of interests, and membership in 1..4 communities. The same persona
 * appears wherever they belong, which is what makes the seeded network read as
 * real people rather than per-room extras (and makes the load test span
 * cross-community members).
 *
 * A CommunitySeed is a flat, time-ordered message script for ONE community that
 * references personas by id. The engine (engine.ts) turns personas into kind-0
 * profiles + guestbook joins, and messages into chat rumors (top-level,
 * inline-reply, threaded-reply, reaction), or a printed transcript in dry-run.
 */

/** The 7 sample communities, keyed. Content and membership use these keys. */
export type CommunityKey =
  | "discord-refugees"
  | "gaming"
  | "the-basement"
  | "edh"
  | "neurodivergents"
  | "health-fitness"
  | "vegans";

/**
 * Presentation style, which also picks a default avatar source:
 * - "anon": a handle-first internet person; illustrated avatar.
 * - "real": presents with a real-ish name and a photo.
 */
export type PersonaStyle = "anon" | "real";

/** A sock account: a whole person. */
export interface Persona {
  /** Stable derivation id, NEVER change once content references it. */
  id: string;
  /** kind-0 `name` (the @handle). */
  handle: string;
  /** kind-0 `display_name` (the shown name); omit to show the handle. */
  displayName?: string;
  /** kind-0 `about` / bio. */
  about: string;
  /** Drives the default avatar/banner source. */
  style: PersonaStyle;
  /**
   * Real personas: which gendered portrait set to draw from, so the photo
   * matches the person (name, pronouns, bio). Required when style is "real".
   */
  gender?: "man" | "woman";
  /**
   * Anon personas: the DiceBear style to use, a character/avatar this person
   * would actually pick (e.g. "bottts", "pixel-art", "lorelei", "adventurer"),
   * NOT the abstract blob default. Required when style is "anon".
   */
  avatarStyle?: string;
  /** Override the derived avatar URL. */
  picture?: string;
  /** Override the derived banner URL. */
  banner?: string;
  /** kind-0 `website` (optional flavor). */
  website?: string;
  /** Which communities this person belongs to (1..4). */
  communities: CommunityKey[];
  /** Guides their dialogue voice; NEVER published. */
  interests: string[];
  /** A note on how they type (casing, emoji, length); NEVER published. */
  voice: string;
}

/** How a reply attaches to its parent. */
export type ReplyMode =
  /** kind-9 with a `q` tag: shows inline in the timeline as "replying to …". */
  | "inline"
  /** kind-1111 NIP-22 comment: opens a thread under the parent. */
  | "thread";

/** A shared piece of content that renders richer than plain text. */
export interface SeedEmbed {
  /** "image" (meme/photo, inline <img>), "video" (thumbnail), "link" (card). */
  type: "image" | "video" | "link";
  /** The URL. For live it's appended to the message content so clients embed. */
  url: string;
  /** Optional preview-only title (link/video card heading). */
  title?: string;
}

/** One posted message. */
export interface SeedMessage {
  /**
   * Optional stable id so other messages can reply to this one by name instead
   * of a fragile array index (esp. for necro-replies to much older posts).
   */
  id?: string;
  /** Persona id of the author. */
  from: string;
  /** Target channel by NAME (matched trim + case-insensitive against the fold). */
  channel: string;
  /** Message body (content). */
  text: string;
  /** Minutes after the community's `startedAt` anchor (backdates history). */
  at: number;
  /** The message being replied to: an array index OR another message's `id`. */
  replyTo?: number | string;
  /** Reply style; defaults to "inline" when `replyTo` is set. */
  replyMode?: ReplyMode;
  /** Shared content (meme, video, link, news article) to render + embed. */
  embed?: SeedEmbed;
  /** Emoji reactions from other personas. */
  reactions?: Array<{ from: string; emoji: string }>;
}

/** A full community seed: which invite, when it starts, and the script. */
export interface CommunitySeed {
  key: CommunityKey;
  /** Human label for logs. */
  name: string;
  /** Full invite URL (naddr + secret fragment) from the discover inventory. */
  invite: string;
  /** ISO timestamp the history begins; every `at` is minutes from here. */
  startedAt: string;
  /** The conversation, flat and time-tagged. */
  messages: SeedMessage[];
}
