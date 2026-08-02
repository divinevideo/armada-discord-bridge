/**
 * discover-communities.ts — READ ONLY inventory of the public communities
 * listed on Armada's Discover page.
 *
 * Discover lists kind-3314 community announcements: a regular event whose
 * content is a full shareable invite link (secret fragment included). This
 * script pulls those announcements, honors NIP-09 un-publishes by their own
 * author, resolves each invite bundle, folds the control plane, and prints
 * name / owner / community id / relays / existing channels / invite URL.
 *
 * It NEVER joins, publishes, or writes anything. Pure read.
 *
 * Usage:
 *   bun run scripts/discover-communities.ts [npubOrHexAuthor] [--json]
 *
 * With no author it pulls ALL kind-3314 on the discover relays (then you pick
 * out the samples). Pass your npub to filter to just your announcements.
 */

import { RelayPool } from "../packages/bridge/src/concord/pool";
import { resolveInvite, ConcordClient } from "../packages/bridge/src/concord/client";
import { localIdentity } from "../packages/bridge/src/concord/signer";
import { parseInviteLink } from "@armada-bridge/concord-core";
import { generateSecretKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "nostr-tools/pure";

const DISCOVER_RELAYS = ["wss://relay.ditto.pub", "wss://relay.dreamith.to"];
const KIND_ANNOUNCEMENT = 3314;

// Same matcher the client uses (inviteDiscovery.ts): a full invite URL or a
// bare naddr1…#fragment embedded in free text.
const INVITE_URL_RE =
  /(?:https?:\/\/[^\s]+?\/invite\/naddr1[0-9a-z]+#[A-Za-z0-9_-]+)|(?:naddr1[0-9a-z]+#[A-Za-z0-9_-]+)/i;

function toHexAuthor(arg: string | undefined): string | undefined {
  if (!arg || arg.startsWith("--")) return undefined;
  if (/^[0-9a-f]{64}$/i.test(arg)) return arg.toLowerCase();
  try {
    const d = nip19.decode(arg);
    if (d.type === "npub") return d.data as string;
  } catch {
    /* fall through */
  }
  throw new Error(`not an npub or hex pubkey: ${arg}`);
}

function firstInviteUrl(content: string): string | undefined {
  return content.match(INVITE_URL_RE)?.[0];
}

/** community.id may be a Uint8Array/number[]; render 32 bytes as lowercase hex. */
function idHex(id: unknown): string {
  if (typeof id === "string") return id;
  const bytes = id instanceof Uint8Array ? id : Array.isArray(id) ? Uint8Array.from(id as number[]) : null;
  if (!bytes) return String(id);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const author = toHexAuthor(args.find((a) => !a.startsWith("--")));

  // 1. Pull kind-3314 announcements from the discover relays.
  const discoverPool = new RelayPool(DISCOVER_RELAYS);
  const filter: { kinds: number[]; limit: number; authors?: string[] } = {
    kinds: [KIND_ANNOUNCEMENT],
    limit: 200,
  };
  if (author) filter.authors = [author];
  const announcements = await discoverPool.query([filter]);

  // 2. Honor NIP-09 un-publishes: a delete by the announcement's OWN author.
  const deleted = new Set<string>();
  if (announcements.length > 0) {
    const dels = await discoverPool
      .query([
        {
          kinds: [5],
          authors: [...new Set(announcements.map((e) => e.pubkey))],
          "#e": announcements.map((e) => e.id),
        },
      ])
      .catch(() => [] as NostrEvent[]);
    const byId = new Map(announcements.map((e) => [e.id, e.pubkey]));
    for (const del of dels) {
      for (const [n, id] of del.tags) {
        if (n === "e" && byId.get(id) === del.pubkey) deleted.add(id);
      }
    }
  }
  await discoverPool.close();

  // 3. Newest announcement per link-signer wins (mirrors the Discover fold).
  announcements.sort((a, b) => b.created_at - a.created_at);
  const byLinkSigner = new Map<string, { url: string; event: NostrEvent }>();
  const relays = new Set<string>(DISCOVER_RELAYS);
  for (const event of announcements) {
    if (deleted.has(event.id)) continue;
    const url = firstInviteUrl(event.content);
    if (!url) continue;
    const parsed = parseInviteLink(url);
    if (!parsed) continue;
    for (const r of parsed.relays ?? []) relays.add(r);
    if (!byLinkSigner.has(parsed.linkSigner)) byLinkSigner.set(parsed.linkSigner, { url, event });
  }

  console.error(
    `Found ${byLinkSigner.size} distinct listing(s) from ${announcements.length} announcement(s)` +
      `${author ? ` by ${nip19.npubEncode(author)}` : ""}.\n`,
  );

  // 4. Resolve each bundle + fold the control plane. Broad pool so a bundle on
  //    a community-only relay is still reachable.
  const pool = new RelayPool([...relays]);
  const reader = localIdentity(generateSecretKey()); // throwaway; reads only
  const results: Array<Record<string, unknown>> = [];

  for (const { url, event } of byLinkSigner.values()) {
    try {
      const { community, bundle } = await resolveInvite(url, pool);
      const client = new ConcordClient(community, pool, reader);
      let channels: string[] = [];
      try {
        await client.syncControl({ signal: AbortSignal.timeout(12_000) });
        channels = client.channels().map((c) => c.name || c.idHex.slice(0, 8));
      } catch (e) {
        channels = [`<control fold failed: ${(e as Error).message}>`];
      }
      results.push({
        name: bundle.name || "(unnamed)",
        communityId: idHex(community.id),
        owner: nip19.npubEncode(community.owner),
        announcedBy: nip19.npubEncode(event.pubkey),
        relays: community.relays,
        channels,
        inviteUrl: url,
      });
    } catch (e) {
      results.push({ error: (e as Error).message, inviteUrl: url, announcedBy: nip19.npubEncode(event.pubkey) });
    }
  }
  await pool.close();

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      if (r.error) {
        console.log(`✗ ${r.inviteUrl}\n    error: ${r.error}\n    announced by: ${r.announcedBy}\n`);
        continue;
      }
      console.log(`● ${r.name}`);
      console.log(`    community: ${r.communityId}`);
      console.log(`    owner:     ${r.owner}`);
      console.log(`    announced: ${r.announcedBy}`);
      console.log(`    relays:    ${(r.relays as string[]).join(", ")}`);
      console.log(`    channels:  ${(r.channels as string[]).join(", ") || "(none read)"}`);
      console.log(`    invite:    ${r.inviteUrl}\n`);
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
