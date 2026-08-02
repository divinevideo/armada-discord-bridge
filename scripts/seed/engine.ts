/**
 * Seed engine: turn a CommunitySeed into Concord activity.
 *
 * Dry-run (default): resolve the community, fold its channels, derive every
 * member's npub, and print the full transcript, WITHOUT touching a relay.
 * Nothing is published unless `live` is explicitly set.
 *
 * Live: publish each member's kind-0 profile + a backdated guestbook join, then
 * every message in absolute-time order. Top-level and inline replies are kind 9
 * (the latter with a `q` tag); threaded replies are kind-1111 NIP-22 comments;
 * reactions are kind 7. Rate-limited.
 */

import { KIND_COMMENT, KIND_REACTION, buildV2CommentTags, parseInviteLink } from "@armada-bridge/concord-core";
import type { ChannelV2 } from "@armada-bridge/concord-core";
import { nip19 } from "nostr-tools";

import { ConcordClient, resolveInvite } from "../../packages/bridge/src/concord/client";
import { RelayPool } from "../../packages/bridge/src/concord/pool";
import type { LocalIdentity } from "../../packages/bridge/src/concord/signer";
import { personaById, personasFor, profileMetadata } from "./personas";
import { WINDOW_START, schedule } from "./schedule";
import { deriveSock } from "./sock";
import type { CommunitySeed, Persona } from "./types";

const DEFAULT_RELAYS = ["wss://relay.ditto.pub", "wss://relay.dreamith.to"];
const DEFAULT_RATE_MS = 250;

const normChan = (s: string): string => s.trim().toLowerCase();
const idHex = (id: unknown): string =>
  typeof id === "string"
    ? id
    : id instanceof Uint8Array || Array.isArray(id)
      ? [...(id as Iterable<number>)].map((b) => b.toString(16).padStart(2, "0")).join("")
      : String(id);
const shortNpub = (pk: string): string => `${nip19.npubEncode(pk).slice(0, 12)}…`;
const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RunOptions {
  live: boolean;
  master: string;
  /** Delay between live publishes (ms). Ignored in dry-run. */
  rateMs?: number;
  /** Only post messages for this channel (name, case-insensitive). Profiles + joins still cover all members. */
  channel?: string;
  /** Post everything EXCEPT this channel (for resuming after a partial run). */
  skipChannel?: string;
}

/** What we remember about a published message so replies/reactions can cite it. */
interface Published {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  text: string;
  authorName: string;
}

/** Sign + publish a full kind-0 (display_name, picture, banner, …). */
async function publishFullProfile(
  pool: RelayPool,
  identity: LocalIdentity,
  meta: Record<string, string>,
): Promise<void> {
  const event = await identity.signer.signEvent({
    kind: 0,
    content: JSON.stringify(meta),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });
  await pool.publish(event);
}

/** Map each message's optional `id` to its array index. */
function buildIdIndex(seed: CommunitySeed): Map<string, number> {
  const m = new Map<string, number>();
  seed.messages.forEach((msg, i) => {
    if (msg.id) m.set(msg.id, i);
  });
  return m;
}

/** Resolve a replyTo (numeric index or string id) to an array index. */
function resolveRef(ref: number | string, idToIndex: Map<string, number>, len: number): number | undefined {
  const idx = typeof ref === "string" ? idToIndex.get(ref) : ref;
  return idx !== undefined && idx >= 0 && idx < len ? idx : undefined;
}

/** Final wire content: append a shared embed URL so clients render a preview. */
function contentOf(m: CommunitySeed["messages"][number]): string {
  if (m.embed && !m.text.includes(m.embed.url)) {
    return m.text ? `${m.text}\n${m.embed.url}` : m.embed.url;
  }
  return m.text;
}

function validate(
  seed: CommunitySeed,
  members: Persona[],
  channelsByName: Map<string, ChannelV2>,
  idToIndex: Map<string, number>,
): void {
  const errors: string[] = [];
  const memberIds = new Set(members.map((p) => p.id));
  for (const [i, m] of seed.messages.entries()) {
    if (!personaById(m.from)) errors.push(`message ${i}: unknown persona "${m.from}"`);
    else if (!memberIds.has(m.from)) errors.push(`message ${i}: "${m.from}" is not a member of ${seed.key} (fix their persona's communities)`);
    if (!channelsByName.has(normChan(m.channel))) errors.push(`message ${i}: no channel "${m.channel}"`);
    for (const r of m.reactions ?? []) {
      if (!memberIds.has(r.from)) errors.push(`message ${i}: reaction from non-member "${r.from}"`);
    }
    if (m.replyTo !== undefined && resolveRef(m.replyTo, idToIndex, seed.messages.length) === undefined) {
      errors.push(`message ${i}: replyTo ${JSON.stringify(m.replyTo)} does not resolve`);
    }
  }
  if (errors.length > 0) throw new Error(`seed "${seed.key}" invalid:\n  - ${errors.join("\n  - ")}`);
}

export async function runSeed(seed: CommunitySeed, opts: RunOptions): Promise<void> {
  const anchor = Date.parse(seed.startedAt);
  if (Number.isNaN(anchor)) throw new Error(`bad startedAt: ${seed.startedAt}`);

  const members = personasFor(seed.key);
  if (members.length === 0) throw new Error(`no personas assigned to community "${seed.key}"`);

  // Derive identities for members + anyone who speaks (should be a subset).
  const ids = new Map<string, LocalIdentity>();
  for (const p of members) ids.set(p.id, deriveSock(opts.master, p.id));
  for (const m of seed.messages) if (!ids.has(m.from) && personaById(m.from)) ids.set(m.from, deriveSock(opts.master, m.from));

  const parsed = parseInviteLink(seed.invite);
  const relays = [...new Set([...(parsed?.relays ?? []), ...DEFAULT_RELAYS])];
  const pool = new RelayPool(relays);

  try {
    const { community } = await resolveInvite(seed.invite, pool);
    const primary = ids.get(members[0]!.id)!;
    const client = new ConcordClient(community, pool, primary);
    await client.syncControl({ signal: AbortSignal.timeout(15_000) });

    const channelsByName = new Map<string, ChannelV2>();
    for (const c of client.channels()) channelsByName.set(normChan(c.name || c.idHex), c);

    const idToIndex = buildIdIndex(seed);
    validate(seed, members, channelsByName, idToIndex);

    let scheduled = schedule(seed);
    if (opts.channel) {
      const want = normChan(opts.channel);
      if (!channelsByName.has(want)) throw new Error(`--channel "${opts.channel}" not found in ${seed.key}`);
      scheduled = scheduled.filter(({ m }) => normChan(m.channel) === want);
      console.log(`(channel filter: only #${opts.channel}, ${scheduled.length} message(s))`);
    }
    if (opts.skipChannel) {
      const skip = normChan(opts.skipChannel);
      scheduled = scheduled.filter(({ m }) => normChan(m.channel) !== skip);
      console.log(`(skipping #${opts.skipChannel}, ${scheduled.length} message(s) remain)`);
    }

    console.log(`\n=== ${seed.name} (${seed.key}) ===`);
    console.log(`community: ${idHex(community.id)}`);
    console.log(`mode:      ${opts.live ? "LIVE, PUBLISHING" : "DRY RUN, no relay writes"}`);
    console.log(`members:   ${members.length}   messages: ${seed.messages.length}   channels: ${channelsByName.size}\n`);

    // Members: full profile + backdated join.
    for (const p of members) {
      const identity = ids.get(p.id)!;
      if (opts.live) {
        await publishFullProfile(pool, identity, profileMetadata(p));
        await client.publishJoin(WINDOW_START - 3_600_000, identity);
        await sleep(opts.rateMs ?? DEFAULT_RATE_MS);
      } else {
        const comm = p.communities.length > 1 ? `  [${p.communities.length} communities]` : "";
        console.log(`  join  @${p.handle.padEnd(16)} ${shortNpub(identity.pk)}  ${p.style}${comm}`);
      }
    }
    console.log("");

    const byIndex = new Map<number, Published>();
    let count = 0;

    for (const { m, index, ms } of scheduled) {
      const channel = channelsByName.get(normChan(m.channel))!;
      const author = ids.get(m.from)!;
      const p = personaById(m.from)!;
      const parentIndex = m.replyTo !== undefined ? resolveRef(m.replyTo, idToIndex, seed.messages.length) : undefined;
      const parent = parentIndex !== undefined ? byIndex.get(parentIndex) : undefined;
      const mode = m.replyTo !== undefined ? (m.replyMode ?? "inline") : undefined;

      if (m.replyTo !== undefined && !parent) {
        console.warn(`  ! message ${index} replies to ${JSON.stringify(m.replyTo)} which isn't published yet, sending as top-level`);
      }

      // Build kind + tags for this message.
      let kind = 9;
      const tags: string[][] = [];
      if (parent && mode === "thread") {
        kind = KIND_COMMENT;
        tags.push(...buildV2CommentTags({ id: parent.id, kind: parent.kind, pubkey: parent.pubkey, tags: parent.tags }));
      } else if (parent && mode === "inline") {
        tags.push(["q", parent.id, "", parent.pubkey]);
      }

      if (opts.live) {
        const { rumor } = await client.sendChat(channel, { content: contentOf(m), author, kind, ms, tags });
        byIndex.set(index, { id: rumor.id, pubkey: author.pk, kind: rumor.kind, tags: rumor.tags, text: m.text, authorName: p.handle });
        count++;
        await sleep(opts.rateMs ?? DEFAULT_RATE_MS);
        for (const r of m.reactions ?? []) {
          const reactor = ids.get(r.from)!;
          await client.sendChat(channel, {
            content: r.emoji,
            author: reactor,
            kind: KIND_REACTION,
            ms: ms + 90_000,
            tags: [["e", rumor.id, "", author.pk], ["k", String(kind)]],
          });
          count++;
          await sleep(opts.rateMs ?? DEFAULT_RATE_MS);
        }
      } else {
        byIndex.set(index, { id: `dry:${index}`, pubkey: author.pk, kind, tags, text: m.text, authorName: p.handle });
        const when = new Date(ms).toISOString().replace("T", " ").slice(0, 16);
        let marker = "";
        if (parent && mode === "thread") marker = ` ⤷ thread on @${parent.authorName}: "${trunc(parent.text, 32)}"`;
        else if (parent && mode === "inline") marker = ` ↩ @${parent.authorName}: "${trunc(parent.text, 32)}"`;
        console.log(`  [${when}] #${channel.name}  @${p.handle}${marker}`);
        console.log(`      ${m.text}`);
        for (const r of m.reactions ?? []) {
          console.log(`        ${r.emoji}  @${personaById(r.from)?.handle ?? r.from}`);
        }
      }
    }

    if (opts.live) console.log(`\nPublished ${count} event(s).`);
    else console.log(`\nDry run complete. Would publish full profiles + joins for ${members.length} member(s), plus the transcript above. Nothing was sent.`);
  } finally {
    await pool.close();
  }
}
