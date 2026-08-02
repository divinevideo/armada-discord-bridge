/**
 * Reddit puller. The public JSON endpoints 403 non-browser TLS fingerprints,
 * but the Atom feeds (`/r/<sub>/hot.rss`) are served; parse those instead. No
 * score in a feed, so `score` is the inverse feed position (hot rank is the
 * quality proxy). Each post is classified as a direct image, an external link,
 * or a self post (shared as its reddit permalink).
 */

export interface RedditPost {
  id: string;
  title: string;
  /** What actually gets appended to the message for clients to embed. */
  shareUrl: string;
  kind: "image" | "link" | "self";
  /** Inverse hot-rank (higher = hotter); feeds carry no vote counts. */
  score: number;
  sub: string;
}

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";
const IMAGE_HOSTS = ["i.redd.it", "i.imgur.com"];

/** Reddit 429s bursts hard; feeds change slowly, so cache per sub for 2h
 *  (stale cache also serves as the fallback when a refresh is throttled). */
const CACHE_MS = 2 * 3600_000;
const cache = new Map<string, { at: number; posts: RedditPost[] }>();

/** Global floor between network hits; reddit 429s bursts across subs too. */
const MIN_FETCH_GAP_MS = 90_000;
let lastFetchAt = 0;

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

export async function fetchHot(sub: string, limit = 25): Promise<RedditPost[]> {
  const hit = cache.get(sub);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.posts;
  if (Date.now() - lastFetchAt < MIN_FETCH_GAP_MS) {
    if (hit) return hit.posts;
    throw new Error(`reddit r/${sub}: throttled (fetch gap)`);
  }
  lastFetchAt = Date.now();
  const res = await fetch(`https://www.reddit.com/r/${sub}/hot.rss?limit=${limit}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    if (hit) return hit.posts;
    throw new Error(`reddit r/${sub}: HTTP ${res.status}`);
  }
  const xml = await res.text();
  const posts: RedditPost[] = [];
  // Slice 3, not 1: hot feeds lead with pinned mod/daily threads (unmarked).
  const entries = xml.split("<entry>").slice(3);
  for (const [i, entry] of entries.entries()) {
    const id = /<id>t3_([a-z0-9]+)<\/id>/.exec(entry)?.[1];
    const rawTitle = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1];
    const permalink = /<link href="([^"]+)"/.exec(entry)?.[1];
    // The escaped content HTML carries `<a href="...">[link]</a>` → the real URL.
    const target = /href="([^"]+)"&gt;\[link\]/.exec(entry)?.[1];
    if (!id || !rawTitle || !permalink) continue;
    const title = unescapeXml(rawTitle).trim();
    if (!title || title.length > 300) continue;
    const url = target ? unescapeXml(target) : permalink;
    let kind: RedditPost["kind"];
    let shareUrl: string;
    if (IMAGE_HOSTS.some((h) => url.includes(`://${h}/`))) {
      kind = "image";
      shareUrl = url;
    } else if (url.includes("www.reddit.com/r/")) {
      kind = "self";
      shareUrl = permalink;
    } else if (url.startsWith("http") && !url.includes("v.redd.it")) {
      kind = "link";
      shareUrl = url;
    } else {
      continue;
    }
    posts.push({ id, title, shareUrl, kind, score: entries.length - i, sub });
  }
  return posts;
}
