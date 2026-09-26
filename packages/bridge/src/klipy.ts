/**
 * KLIPY lookups for Discord's GIF picker.
 *
 * A Klipy send reaches the bridge as a page URL (`https://klipy.com/gifs/<slug>`)
 * whose Discord embed exposes only an mp4. Nothing keyless gets from there to
 * the real GIF:
 *
 *  - Rendition filenames are random per format (`…/5iZlPUTw.mp4` sits next to
 *    `…/NVSeglDC.gif`), so no URL rewrite finds the GIF.
 *  - Worse, static.klipy.com answers ANY missing rendition with the same
 *    placeholder image, 200 and `image/gif`. The `.mp4` -> `.gif` swap
 *    therefore "succeeded" for every Klipy send and Armada was handed the
 *    placeholder in place of the GIF.
 *  - klipy.com itself serves the bridge host a Cloudflare challenge, so the
 *    page's og:image is out of reach too.
 *
 * The Items API resolves a slug to its real renditions, and api.klipy.com is
 * not behind the challenge. The key is optional: without it the bridge falls
 * back to transcoding the mp4.
 */

const KLIPY_API = "https://api.klipy.com/api/v1";

/** Klipy uses this for per-user "recent" lists; one bridge-wide id is enough. */
const CUSTOMER_ID = "armada-discord-bridge";

const LOOKUP_TIMEOUT_MS = 10_000;

/** Largest to smallest: the first one under the byte budget wins. */
const SIZES = ["hd", "md", "sm", "xs"] as const;

interface KlipyFile {
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}

type KlipyItem = {
  slug?: string;
  file?: Partial<Record<(typeof SIZES)[number], { gif?: KlipyFile }>>;
};

interface KlipyItemsResponse {
  result?: boolean;
  data?: { data?: KlipyItem[] } | KlipyItem[];
}

/** One real GIF rendition, as the Items API describes it. */
export interface KlipyGif {
  url: string;
  width?: number;
  height?: number;
  /** Bytes, as Klipy reports them. Advisory: the download still enforces its own cap. */
  size?: number;
}

/** Whether a URL is on Klipy's media CDN, where a missing file still answers 200. */
export function isKlipyMediaHost(url: string): boolean {
  try {
    return /(^|\.)klipy\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The item a Klipy page URL names, or undefined for anything else.
 *
 * GIFs and stickers share the Items response shape; clips and memes do not,
 * and are left to the generic embed path.
 */
export function klipyItem(pageUrl: string): { kind: "gifs" | "stickers"; slug: string } | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !/^(www\.)?klipy\.com$/i.test(url.hostname)) return undefined;
  const match = /^\/(gifs|stickers)\/([A-Za-z0-9_-]{1,200})\/?$/.exec(url.pathname);
  if (!match) return undefined;
  return { kind: match[1] as "gifs" | "stickers", slug: match[2] };
}

/** The largest GIF rendition that fits `maxBytes`, falling back to the smallest listed. */
export function pickGif(item: KlipyItem, maxBytes: number): KlipyGif | undefined {
  const gifs = SIZES.map((size) => item.file?.[size]?.gif).filter(
    (file): file is KlipyFile & { url: string } => typeof file?.url === "string" && file.url.startsWith("https://"),
  );
  // An absent `size` is not disqualifying; the download cap is the real bound.
  const fit = gifs.find((file) => file.size === undefined || file.size <= maxBytes) ?? gifs[gifs.length - 1];
  if (!fit) return undefined;
  return { url: fit.url, width: fit.width, height: fit.height, size: fit.size };
}

export class KlipyClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * The real GIF behind a Klipy page URL, or undefined when the URL is not a
   * Klipy item or the lookup fails. Never throws: this is an upgrade, and the
   * message still bridges without it.
   */
  async resolveGif(pageUrl: string, maxBytes: number): Promise<KlipyGif | undefined> {
    const item = klipyItem(pageUrl);
    if (!item) return undefined;
    const endpoint = new URL(`${KLIPY_API}/${encodeURIComponent(this.apiKey)}/${item.kind}/items`);
    endpoint.searchParams.set("slugs", item.slug);
    endpoint.searchParams.set("customer_id", CUSTOMER_ID);
    try {
      const res = await this.fetchImpl(endpoint, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      // The key is in the path, so log the slug and never the URL.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as KlipyItemsResponse;
      const items = Array.isArray(body.data) ? body.data : (body.data?.data ?? []);
      const match = items.find((i) => i.slug === item.slug) ?? items[0];
      return match ? pickGif(match, maxBytes) : undefined;
    } catch (error) {
      console.warn(`bridge: klipy lookup failed for ${item.kind}/${item.slug}:`, error instanceof Error ? error.message : error);
      return undefined;
    }
  }
}
