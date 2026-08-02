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
}

export interface CommunityLiveness {
  key: CommunityKey;
  /** Multiplier on the base per-tick action probability. */
  activity: number;
  sources: RedditSource[];
  /** Channels chatter/replies may target (skip intro/banned-style channels). */
  chatterChannels: string[];
}

export const LIVENESS: CommunityLiveness[] = [
  {
    key: "discord-refugees",
    activity: 1.2,
    sources: [
      { sub: "selfhosted", channel: "alternatives", flavor: "any" },
      { sub: "privacy", channel: "privacy tips", flavor: "any" },
      { sub: "technology", channel: "off topic", flavor: "any" },
    ],
    chatterChannels: ["general", "migration help", "privacy tips", "alternatives", "off topic", "snark", "armada"],
  },
  {
    key: "gaming",
    activity: 1.0,
    sources: [
      { sub: "pcgaming", channel: "general", flavor: "any" },
      { sub: "patientgamers", channel: "now playing", flavor: "any" },
      { sub: "retrogaming", channel: "retro gaming", flavor: "image" },
      { sub: "AnimalCrossing", channel: "animal crossing", flavor: "image" },
    ],
    chatterChannels: ["general", "lfg", "now playing", "retro gaming", "animal crossing", "off topic"],
  },
  {
    key: "the-basement",
    activity: 1.0,
    sources: [
      { sub: "listentothis", channel: "new releases", flavor: "any" },
      { sub: "Metal", channel: "metal", flavor: "any" },
      { sub: "hiphopheads", channel: "rap", flavor: "any" },
      { sub: "electronicmusic", channel: "electronic", flavor: "any" },
    ],
    chatterChannels: ["general", "new releases", "now playing", "electronic", "rock", "metal", "rap", "alt", "country", "off topic"],
  },
  {
    key: "edh",
    activity: 0.8,
    sources: [
      { sub: "EDH", channel: "general", flavor: "any" },
      { sub: "BudgetBrews", channel: "deck help", flavor: "any" },
      { sub: "magicTCG", channel: "general", flavor: "any" },
    ],
    chatterChannels: ["general", "deck help", "deck showcase"],
  },
  {
    key: "neurodivergents",
    activity: 1.1,
    sources: [
      { sub: "ADHD", channel: "ADHD", flavor: "any" },
      { sub: "autism", channel: "autism", flavor: "any" },
      { sub: "adhdmeme", channel: "hyperfixations", flavor: "image" },
    ],
    chatterChannels: ["general", "body-doubling", "hyperfixations", "autism", "ADHD", "audhd women", "questions and advice", "vent"],
  },
  {
    key: "health-fitness",
    activity: 0.9,
    sources: [
      { sub: "Fitness", channel: "workouts", flavor: "any" },
      { sub: "nutrition", channel: "nutrition", flavor: "any" },
      { sub: "mentalhealth", channel: "mental health", flavor: "any" },
    ],
    chatterChannels: ["general", "workouts", "nutrition", "mental health"],
  },
  {
    key: "vegans",
    activity: 1.0,
    sources: [
      { sub: "vegan", channel: "general", flavor: "any" },
      { sub: "veganrecipes", channel: "recipes", flavor: "any" },
      { sub: "VeganFoodPorn", channel: "food", flavor: "image" },
    ],
    chatterChannels: ["general", "recipes", "food", "nutrition", "restaurants", "activism", "memes"],
  },
];
