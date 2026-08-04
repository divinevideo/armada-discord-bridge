/**
 * Liveness config: which subreddits feed which channel of each community, and
 * how chatty each community is relative to the base rate.
 *
 * A RedditSource maps ONE subreddit to ONE channel (by fold name, matched the
 * same trim+case-insensitive way the seed engine matches). `flavor` hints the
 * post types worth sharing there ("image" prefers direct-image posts, "any"
 * takes links/self posts too, shared as reddit permalinks).
 */

import type { CommunityKey } from "../seed/types";

export interface RedditSource {
  sub: string;
  channel: string;
  flavor: "image" | "any";
  /**
   * Repost lane, deciding how a post is vetted and captioned (repostOnly
   * communities only; see tick.ts):
   *   "meme"   - image only, meme vision-vet, posted BARE (no caption).
   *   "curate" - links and content images, vetted for quality and relevance,
   *              posted with the source post's own title. Self-posts skipped.
   * Defaults to "curate".
   */
  mode?: "meme" | "curate";
  /**
   * What the vet judges relevance against, e.g. "Magic: The Gathering". Falls
   * back to the community `topic`. Set per-source when one community pulls
   * several distinct subjects into different channels.
   */
  subject?: string;
  /**
   * For "meme" sources: keep the source post's title as a caption instead of
   * posting the image bare. Use where memes often need context to land (in-
   * jokes, references). Ignored by "curate" (which always keeps the title).
   */
  caption?: boolean;
}

export interface CommunityLiveness {
  key: CommunityKey;
  /** Multiplier on the base per-tick action probability. */
  activity: number;
  /** Default subject the vet judges posts against, for all of this
   * community's sources that don't set their own. */
  topic?: string;
  /**
   * Hard exclusion for the vet: a post is SKIPped if this clause is true of
   * it. Phrased to complete "answer SKIP if ...". Used to keep Armada from
   * amplifying its own competitors.
   */
  avoid?: string;
  sources: RedditSource[];
  /** Channels chatter/replies may target (skip intro/banned-style channels). */
  chatterChannels: string[];
  /**
   * Repost-only: no LLM-authored text at all (no chatter, replies, or
   * reactions). Every post is a vetted reddit repost - memes go up bare, all
   * other media and links carry the source post's own title. Reddit
   * self-posts (no external link) are skipped. Every managed community runs
   * this way.
   */
  repostOnly?: boolean;
}

// Every community is repost-only: bots post nothing but vetted reddit memes,
// media, and links. "meme" sources post bare; "curate" sources post with the
// source title. The vet judges each post against the community `topic` (or a
// source's own `subject`).
export const LIVENESS: CommunityLiveness[] = [
  {
    key: "discord-refugees",
    activity: 1.2,
    topic: "online privacy, self-hosting, and alternatives to Discord and big-tech platforms",
    // Armada is a Discord alternative; never amplify a rival platform.
    avoid:
      "the post promotes, recommends, reviews, or is primarily about a chat / " +
      "community platform that competes with Armada (for example Discord itself, " +
      "Matrix, Element, Revolt, Guilded, Slack, Telegram, Mattermost, or Rocket.Chat)",
    sources: [
      { sub: "selfhosted", channel: "alternatives", flavor: "any", mode: "curate" },
      { sub: "privacy", channel: "privacy tips", flavor: "any", mode: "curate" },
      { sub: "technology", channel: "off topic", flavor: "any", mode: "curate" },
    ],
    chatterChannels: ["general", "migration help", "privacy tips", "alternatives", "off topic", "snark", "armada"],
    repostOnly: true,
  },
  {
    key: "gaming",
    activity: 1.0,
    topic: "video games and gaming culture",
    sources: [
      { sub: "gamememes", channel: "general", flavor: "image", mode: "meme" },
      { sub: "pcgaming", channel: "general", flavor: "any", mode: "curate" },
      { sub: "patientgamers", channel: "now playing", flavor: "any", mode: "curate" },
      { sub: "retrogaming", channel: "retro gaming", flavor: "image", mode: "curate" },
      { sub: "AnimalCrossing", channel: "animal crossing", flavor: "image", mode: "curate", subject: "the game Animal Crossing" },
    ],
    chatterChannels: ["general", "lfg", "now playing", "retro gaming", "animal crossing", "off topic"],
    repostOnly: true,
  },
  {
    key: "the-basement",
    activity: 1.0,
    topic: "music, including metal, hip-hop, electronic, and new releases",
    sources: [
      { sub: "listentothis", channel: "new releases", flavor: "any", mode: "curate", subject: "noteworthy music and new releases" },
      { sub: "Metal", channel: "metal", flavor: "any", mode: "curate", subject: "metal music" },
      { sub: "hiphopheads", channel: "rap", flavor: "any", mode: "curate", subject: "hip-hop and rap music" },
      { sub: "electronicmusic", channel: "electronic", flavor: "any", mode: "curate", subject: "electronic music" },
    ],
    chatterChannels: ["general", "new releases", "now playing", "electronic", "rock", "metal", "rap", "alt", "country", "off topic"],
    repostOnly: true,
  },
  {
    key: "edh",
    activity: 0.8,
    topic: "Magic: The Gathering, especially Commander (EDH)",
    sources: [
      { sub: "MTGmemes", channel: "general", flavor: "image", mode: "meme", caption: true },
      { sub: "magicthecirclejerking", channel: "general", flavor: "image", mode: "meme", caption: true },
      { sub: "EDH", channel: "general", flavor: "any", mode: "curate" },
      { sub: "BudgetBrews", channel: "deck help", flavor: "any", mode: "curate" },
      { sub: "magicTCG", channel: "general", flavor: "any", mode: "curate" },
    ],
    chatterChannels: ["general", "deck help", "deck showcase"],
    repostOnly: true,
  },
  {
    key: "neurodivergents",
    activity: 1.1,
    topic: "neurodivergence, including ADHD and autism",
    sources: [
      { sub: "adhdmeme", channel: "hyperfixations", flavor: "image", mode: "meme", subject: "ADHD and neurodivergence" },
      { sub: "aspiememes", channel: "autism", flavor: "image", mode: "meme", subject: "autism and neurodivergence" },
      { sub: "ADHD", channel: "ADHD", flavor: "any", mode: "curate", subject: "ADHD" },
      { sub: "autism", channel: "autism", flavor: "any", mode: "curate", subject: "autism" },
    ],
    chatterChannels: ["general", "body-doubling", "hyperfixations", "autism", "ADHD", "audhd women", "questions and advice", "vent"],
    repostOnly: true,
  },
  {
    key: "health-fitness",
    activity: 0.9,
    topic: "health, fitness, nutrition, and mental health",
    sources: [
      { sub: "Fitness", channel: "workouts", flavor: "any", mode: "curate", subject: "fitness and working out" },
      { sub: "nutrition", channel: "nutrition", flavor: "any", mode: "curate", subject: "nutrition" },
      { sub: "mentalhealth", channel: "mental health", flavor: "any", mode: "curate", subject: "mental health" },
    ],
    chatterChannels: ["general", "workouts", "nutrition", "mental health"],
    repostOnly: true,
  },
  {
    key: "vegans",
    activity: 1.0,
    topic: "veganism and animal rights",
    // Memes go bare to #memes; food photos to #food, activism to #activism, and
    // animal-ag / animal-rights resources to #education, each with its title.
    sources: [
      { sub: "veganmemes", channel: "memes", flavor: "image", mode: "meme" },
      { sub: "vegancirclejerk", channel: "memes", flavor: "image", mode: "meme" },
      { sub: "VeganActivism", channel: "activism", flavor: "any", mode: "curate", subject: "vegan activism, campaigns, and animal-rights news" },
      { sub: "vegan", channel: "education", flavor: "any", mode: "curate", subject: "animal agriculture, animal rights, and animal welfare" },
      { sub: "AnimalRights", channel: "education", flavor: "any", mode: "curate", subject: "animal rights and animal welfare" },
      { sub: "VeganFoodPorn", channel: "food", flavor: "image", mode: "curate", subject: "appetizing vegan food, dishes, and drinks" },
    ],
    chatterChannels: ["memes", "activism", "education", "food"],
    repostOnly: true,
  },
];
