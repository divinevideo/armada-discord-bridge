/**
 * One liveness tick: for each community, maybe (probability gated by a
 * circadian curve) perform ONE small action as a persona — share a reddit
 * find, reply to a recent sock message, post fresh chatter, or react — so the
 * seeded communities keep a low pulse without reading as bot spam.
 *
 * Socks only talk to socks: reply/reaction targets are restricted to messages
 * authored by this community's own personas, never a real user.
 *
 *   bun run scripts/liveness/tick.ts [--dry] [--force] [--community=<key>]
 *
 * --dry runs the full read/decide/generate path and prints what would be sent
 * without publishing. --force skips the probability gate (for testing).
 */

import {
  KIND_COMMENT,
  KIND_MESSAGE,
  KIND_REACTION,
  buildV2CommentTags,
  parseInviteLink,
} from "@armada-bridge/concord-core";
import type { ChannelV2, OpenedChat } from "@armada-bridge/concord-core";

import { ConcordClient, resolveInvite } from "../../packages/bridge/src/concord/client";
import { RelayPool } from "../../packages/bridge/src/concord/pool";
import type { LocalIdentity } from "../../packages/bridge/src/concord/signer";
import { seed as discordRefugees } from "../seed/content/discord-refugees";
import { seed as edh } from "../seed/content/edh";
import { seed as gaming } from "../seed/content/gaming";
import { seed as healthFitness } from "../seed/content/health-fitness";
import { seed as neurodivergents } from "../seed/content/neurodivergents";
import { seed as theBasement } from "../seed/content/the-basement";
import { seed as vegans } from "../seed/content/vegans";
import { loadOrCreateMaster } from "../seed/keystore";
import { personasFor } from "../seed/personas";
import { deriveSock } from "../seed/sock";
import type { CommunitySeed, Persona } from "../seed/types";
import { LIVENESS, type CommunityLiveness } from "./config";
import { generate } from "./llm";
import { fetchHot, type RedditPost } from "./reddit";
import { loadState, saveState, type LivenessState } from "./state";

const INVITES: Record<string, CommunitySeed> = {
  "discord-refugees": discordRefugees,
  gaming,
  "the-basement": theBasement,
  edh,
  neurodivergents,
  "health-fitness": healthFitness,
  vegans,
};

const DEFAULT_RELAYS = ["wss://relay.ditto.pub", "wss://relay.dreamith.to"];
const BASE_P = 0.24;
const CONTEXT_HOURS = 72;
const EMOJI = ["😂", "💯", "🔥", "❤️", "👀", "😭", "👍", "🙌", "💀", "🤝"];

const normChan = (s: string): string => s.trim().toLowerCase();
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Local-hour activity weight (LIVENESS_TZ, default America/Chicago). */
export function circadian(now = new Date()): number {
  const tz = process.env.LIVENESS_TZ?.trim() || "America/Chicago";
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now),
  ) % 24;
  if (hour < 8) return 0.15;
  if (hour < 12) return 0.6;
  if (hour < 18) return 0.8;
  return 1.0;
}

const SYSTEM = `You ghost-write single chat messages for fictional personas seeding a Discord-style community app.
Output ONLY the message text: no surrounding quotes, no name prefix, no explanation.
Match the persona's typing style exactly (capitalization, punctuation, emoji habits, typical length). Most messages are one or two short casual sentences.
Never use hashtags, never sound like marketing, never mention AI or being generated.
Never use em dashes; casual chat uses commas, periods, or just runs on.`;

function personaBlock(p: Persona): string {
  return `PERSONA @${p.handle}\nbio: ${p.about}\nvoice: ${p.voice}\ninterests: ${p.interests.join(", ")}`;
}

function contextBlock(chats: OpenedChat[], pkToHandle: Map<string, string>): string {
  const lines = chats
    .slice(-12)
    .map((c) => `@${pkToHandle.get(c.author) ?? "?"}: ${trunc(c.content.replace(/\s+/g, " "), 200)}`);
  return lines.length > 0 ? `RECENT MESSAGES in this channel (newest last):\n${lines.join("\n")}` : "The channel has been quiet lately.";
}

function avoidBlock(state: LivenessState, key: string): string {
  const recent = state.recent[key] ?? [];
  if (recent.length === 0) return "";
  return `\nDo NOT repeat topics from your side's recent posts:\n${recent.slice(-8).map((t) => `- ${trunc(t, 90)}`).join("\n")}`;
}

interface Ctx {
  cfg: CommunityLiveness;
  client: ConcordClient;
  channelsByName: Map<string, ChannelV2>;
  members: Persona[];
  ids: Map<string, LocalIdentity>;
  pkToPersona: Map<string, Persona>;
  /** Recent sock-authored chat (kinds 9/1111), oldest-first. */
  recent: OpenedChat[];
  state: LivenessState;
  dry: boolean;
}

function choosePersona(ctx: Ctx, excludePk?: string): Persona {
  const avoid = ctx.state.lastAuthor[ctx.cfg.key];
  const pool = ctx.members.filter((p) => ctx.ids.get(p.id)!.pk !== excludePk);
  const fresh = pool.filter((p) => p.id !== avoid);
  return pick(fresh.length > 0 ? fresh : pool);
}

function pkToHandleMap(ctx: Ctx): Map<string, string> {
  return new Map([...ctx.pkToPersona].map(([pk, p]) => [pk, p.handle]));
}

async function publish(
  ctx: Ctx,
  channel: ChannelV2,
  persona: Persona,
  kind: number,
  content: string,
  tags: string[][],
): Promise<{ rumorId: string; pk: string } | undefined> {
  const author = ctx.ids.get(persona.id)!;
  if (ctx.dry) {
    console.log(`  [dry] #${channel.name}  @${persona.handle}  kind ${kind}\n        ${content.replace(/\n/g, "\n        ")}`);
    return undefined;
  }
  const { rumor } = await ctx.client.sendChat(channel, { content, author, kind, tags });
  console.log(`  sent  #${channel.name}  @${persona.handle}  kind ${kind}  ${trunc(content.replace(/\n/g, " "), 100)}`);
  return { rumorId: rumor.id, pk: author.pk };
}

function noteSent(ctx: Ctx, channel: ChannelV2, persona: Persona, text: string): void {
  ctx.state.lastPost[`${ctx.cfg.key}|${normChan(channel.name)}`] = Date.now();
  ctx.state.lastAuthor[ctx.cfg.key] = persona.id;
  (ctx.state.recent[ctx.cfg.key] ??= []).push(text);
}

/** Maybe let a second persona react to something just posted. */
async function maybeReactTo(ctx: Ctx, channel: ChannelV2, sent: { rumorId: string; pk: string } | undefined, kind: number): Promise<void> {
  if (!sent || Math.random() > 0.25) return;
  const reactor = choosePersona(ctx, sent.pk);
  await publish(ctx, channel, reactor, KIND_REACTION, pick(EMOJI), [
    ["e", sent.rumorId, "", sent.pk],
    ["k", String(kind)],
  ]);
}

async function actReddit(ctx: Ctx): Promise<boolean> {
  const source = pick(ctx.cfg.sources);
  const channel = ctx.channelsByName.get(normChan(source.channel));
  if (!channel) return false;
  let posts: RedditPost[];
  try {
    posts = await fetchHot(source.sub);
  } catch (e) {
    console.warn(`  reddit r/${source.sub} failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  const unseen = posts.filter((p) => !ctx.state.seenReddit.includes(`${p.sub}/${p.id}`));
  const flavored = source.flavor === "image" ? unseen.filter((p) => p.kind === "image") : unseen;
  const candidates = (flavored.length > 0 ? flavored : unseen).sort((a, b) => b.score - a.score).slice(0, 10);
  if (candidates.length === 0) return false;
  const post = pick(candidates);
  const persona = choosePersona(ctx);
  const inChannel = ctx.recent.filter((c) => c.channelIdHex === channel.idHex);
  // Reddit is the idea source, never the destination: memes and external
  // links are shared directly, discussions become topics raised in the
  // persona's own words. No reddit.com URL and no "saw this on reddit".
  const task =
    post.kind === "image"
      ? `TASK: You want to drop a meme/photo in #${channel.name} (elsewhere it was titled "${post.title}"). Write the short caption you'd post above it. Don't say where you found it, don't include any URL; the image link is appended automatically.`
      : post.kind === "link"
        ? `TASK: Share a link you ran across: "${post.title}". Write a short comment in your own voice on why it's worth a look. Don't say where you found it, don't include any URL; it is appended automatically.`
        : `TASK: People online are talking about this right now: "${post.title}"${post.blurb ? ` (gist: ${post.blurb})` : ""}. Bring it up in #${channel.name} as your OWN thought or question, in your own words. Don't mention reddit or any website, no links.`;
  const text = await generate(
    SYSTEM,
    `${personaBlock(persona)}\n\nCOMMUNITY channel: #${channel.name}\n${contextBlock(inChannel, pkToHandleMap(ctx))}\n\n${task}${avoidBlock(ctx.state, ctx.cfg.key)}`,
  );
  const content = post.shareUrl ? `${trunc(text, 400)}\n${post.shareUrl}` : trunc(text, 400);
  const sent = await publish(ctx, channel, persona, KIND_MESSAGE, content, []);
  ctx.state.seenReddit.push(`${post.sub}/${post.id}`);
  noteSent(ctx, channel, persona, text);
  await maybeReactTo(ctx, channel, sent, KIND_MESSAGE);
  return true;
}

async function actReply(ctx: Ctx): Promise<boolean> {
  const cutoff = Date.now() - 48 * 3600_000;
  const targets = ctx.recent.filter((c) => c.ms > cutoff && c.content.trim().length > 0);
  if (targets.length === 0) return false;
  const target = pick(targets.slice(-15));
  const channel = ctx.client.channel(target.channelIdHex);
  if (!channel) return false;
  const persona = choosePersona(ctx, target.author);
  const targetHandle = ctx.pkToPersona.get(target.author)?.handle ?? "?";
  const thread = Math.random() < 0.3;
  const kind = thread ? KIND_COMMENT : KIND_MESSAGE;
  const tags = thread
    ? buildV2CommentTags({ id: target.rumorId, kind: target.kind, pubkey: target.author, tags: target.tags })
    : [["q", target.rumorId, "", target.author]];
  const inChannel = ctx.recent.filter((c) => c.channelIdHex === channel.idHex);
  const text = await generate(
    SYSTEM,
    `${personaBlock(persona)}\n\nCOMMUNITY channel: #${channel.name}\n${contextBlock(inChannel, pkToHandleMap(ctx))}\n\nTASK: Write a reply to this message from @${targetHandle}: "${trunc(target.content, 300)}". Keep it conversational and in character.${avoidBlock(ctx.state, ctx.cfg.key)}`,
  );
  const sent = await publish(ctx, channel, persona, kind, trunc(text, 400), tags);
  noteSent(ctx, channel, persona, text);
  await maybeReactTo(ctx, channel, sent, kind);
  return true;
}

async function actChatter(ctx: Ctx): Promise<boolean> {
  const options = ctx.cfg.chatterChannels
    .map((name) => ctx.channelsByName.get(normChan(name)))
    .filter((c): c is ChannelV2 => c !== undefined);
  if (options.length === 0) return false;
  // Staleness-weighted: channels we have not touched recently are likelier.
  const weights = options.map((c) => {
    const last = ctx.state.lastPost[`${ctx.cfg.key}|${normChan(c.name)}`] ?? 0;
    return Math.min(48, (Date.now() - last) / 3600_000) + 1;
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let channel = options[0]!;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i]!;
    if (r <= 0) {
      channel = options[i]!;
      break;
    }
  }
  const persona = choosePersona(ctx);
  const inChannel = ctx.recent.filter((c) => c.channelIdHex === channel.idHex);
  const text = await generate(
    SYSTEM,
    `${personaBlock(persona)}\n\nCOMMUNITY channel: #${channel.name}\n${contextBlock(inChannel, pkToHandleMap(ctx))}\n\nTASK: Write a fresh message for #${channel.name} that fits this community and your interests. It can start a small new topic or riff on the current vibe; don't answer any specific message.${avoidBlock(ctx.state, ctx.cfg.key)}`,
  );
  const sent = await publish(ctx, channel, persona, KIND_MESSAGE, trunc(text, 400), []);
  noteSent(ctx, channel, persona, text);
  await maybeReactTo(ctx, channel, sent, KIND_MESSAGE);
  return true;
}

async function actReaction(ctx: Ctx): Promise<boolean> {
  const cutoff = Date.now() - 24 * 3600_000;
  const targets = ctx.recent.filter((c) => c.ms > cutoff);
  if (targets.length === 0) return false;
  const target = pick(targets.slice(-10));
  const channel = ctx.client.channel(target.channelIdHex);
  if (!channel) return false;
  const persona = choosePersona(ctx, target.author);
  await publish(ctx, channel, persona, KIND_REACTION, pick(EMOJI), [
    ["e", target.rumorId, "", target.author],
    ["k", String(target.kind)],
  ]);
  return true;
}

async function actOnce(cfg: CommunityLiveness, master: string, state: LivenessState, dry: boolean): Promise<void> {
  const seed = INVITES[cfg.key]!;
  const members = personasFor(cfg.key);
  const ids = new Map(members.map((p) => [p.id, deriveSock(master, p.id)] as const));
  const pkToPersona = new Map(members.map((p) => [ids.get(p.id)!.pk, p] as const));

  const parsed = parseInviteLink(seed.invite);
  const pool = new RelayPool([...new Set([...(parsed?.relays ?? []), ...DEFAULT_RELAYS])]);
  try {
    const { community } = await resolveInvite(seed.invite, pool);
    const client = new ConcordClient(community, pool, ids.get(members[0]!.id)!);
    await client.syncControl({ signal: AbortSignal.timeout(15_000) });
    const channelsByName = new Map<string, ChannelV2>();
    for (const c of client.channels()) channelsByName.set(normChan(c.name || c.idHex), c);

    // Recent sock-authored discussion across the channels we may act in.
    const sinceSec = Math.floor(Date.now() / 1000) - CONTEXT_HOURS * 3600;
    const recent: OpenedChat[] = [];
    // Sample the watch set: bounds tick duration on channel-heavy communities
    // (a slow relay costs 20s per backfill); ticks are frequent enough that
    // every channel gets looked at over a day.
    const watch = [...new Set([...cfg.chatterChannels, ...cfg.sources.map((s) => s.channel)].map(normChan))]
      .sort(() => Math.random() - 0.5)
      .slice(0, 6);
    for (const name of watch) {
      const channel = channelsByName.get(name);
      if (!channel) continue;
      try {
        const { chats } = await client.backfillChannel(channel, sinceSec, 300, {
          signal: AbortSignal.timeout(20_000),
        });
        for (const c of chats) {
          if ((c.kind === KIND_MESSAGE || c.kind === KIND_COMMENT) && pkToPersona.has(c.author)) recent.push(c);
        }
      } catch {
        // A slow relay must not stall the tick; act on what we have.
      }
    }
    recent.sort((a, b) => a.ms - b.ms);

    const ctx: Ctx = { cfg, client, channelsByName, members, ids, pkToPersona, recent, state, dry };
    const roll = Math.random();
    const forced = { reddit: actReddit, reply: actReply, chatter: actChatter, reaction: actReaction }[
      process.env.LIVENESS_ACTION?.trim() ?? ""
    ];
    const order = forced
      ? [forced, actChatter]
      : roll < 0.3
        ? [actReddit, actChatter]
        : roll < 0.7
          ? [actReply, actChatter]
          : roll < 0.9
            ? [actChatter, actReply]
            : [actReaction, actReply, actChatter];
    for (const act of order) {
      if (await act(ctx)) return;
    }
    console.log("  (no viable action)");
  } finally {
    await pool.close();
  }
}

export interface TickOptions {
  dry: boolean;
  force: boolean;
  only?: string;
}

export async function runTick(opts: TickOptions): Promise<void> {
  const master = loadOrCreateMaster();
  const state = loadState();
  const weight = circadian();
  for (const cfg of LIVENESS) {
    if (opts.only && cfg.key !== opts.only) continue;
    const p = BASE_P * cfg.activity * weight;
    if (!opts.force && Math.random() > p) continue;
    console.log(`\n=== ${cfg.key} (p=${p.toFixed(2)}${opts.dry ? ", dry" : ""}) ===`);
    try {
      await actOnce(cfg, master, state, opts.dry);
    } catch (e) {
      console.error(`  ${cfg.key} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  saveState(state);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--community="))?.slice("--community=".length);
  runTick({ dry: args.includes("--dry"), force: args.includes("--force"), only }).then(
    () => process.exit(0),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
