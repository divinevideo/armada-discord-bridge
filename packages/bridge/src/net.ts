/**
 * Outbound-fetch guard for URLs that arrive from outside the trust boundary.
 *
 * Everything here exists because the bridge fetches URLs it did not choose:
 * NIP-92 `imeta` tags on inbound rumors, media URLs off Discord embeds (which
 * are OpenGraph values from whatever page was linked), and relay lists inside
 * a pasted invite. Bun's `fetch` resolves `file:` and `data:` as readily as
 * `https:`, and the bridge runs in the same process as the portal — which
 * holds PORTAL_SEAL_KEY, the key that unseals every per-bridge secret in the
 * database. An unguarded `fetch(url)` there is a read primitive over the
 * process's own filesystem and environment, with the result posted into a
 * Discord channel.
 *
 * Three separate things have to hold, and each was missing on its own:
 *   - the scheme must be http(s), so `file:`/`data:`/`blob:` never resolve;
 *   - the host must not be loopback, link-local, or RFC1918/ULA, checked
 *     against the RESOLVED addresses rather than the spelling, so a public
 *     name pointing at 127.0.0.1 is caught too;
 *   - the check must be re-run on every redirect hop, or the first Location
 *     header undoes it.
 *
 * The address that is CHECKED is also the address that is CONNECTED to: the
 * guard resolves once and pins the result, because `fetch(name)` would resolve
 * a second, independent time and a 0-TTL record that alternates public ->
 * 127.0.0.1 (DNS rebinding) passes a check it never has to honor.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

/** Redirect hops honored before a fetch is abandoned. */
const MAX_REDIRECTS = 3;

/**
 * Whole-operation budget for a guarded fetch: DNS, every redirect hop, and the
 * body read share it. Without one, a server that dribbles a byte a minute holds
 * the socket until the process dies — `readCapped` bounds bytes, not time.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The eight 16-bit groups of an IPv6 literal, or undefined if it does not
 * parse.
 *
 * Spelling is the whole point of this function. `new URL()` re-serializes an
 * IPv6 host into the WHATWG canonical form, which is all-hex: the literal
 * `[::ffff:127.0.0.1]` arrives at the guard as `::ffff:7f00:1`. A check written
 * against the dotted-quad spelling therefore matches the one form that never
 * actually shows up, which is how loopback and the cloud metadata service were
 * both reachable through a tag any channel member could publish. Classify by
 * VALUE and the spelling stops mattering.
 */
function ipv6Groups(raw: string): number[] | undefined {
  let text = raw;
  // A trailing dotted quad is two groups written in v4 form (::ffff:1.2.3.4).
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return undefined;
    const hi = (octets[0] << 8) | octets[1];
    const lo = (octets[2] << 8) | octets[3];
    text = `${text.slice(0, dotted.index)}:${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return undefined;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/**
 * The IPv4 address embedded in an IPv6 one, for every form that routes to a v4
 * destination. Each of these is a way to spell "connect to 127.0.0.1" without
 * writing an IPv4 address, so each has to defer to the v4 rules.
 */
function embeddedIpv4(g: number[]): string | undefined {
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroThrough(5) && g[5] === 0xffff) return quad(g[6], g[7]); // ::ffff:0:0/96, v4-mapped
  // ::a.b.c.d (v4-compatible, deprecated but still routed). `::` and `::1` are
  // not v4 addresses and are handled as themselves below.
  if (zeroThrough(6) && !(g[6] === 0 && g[7] <= 1)) return quad(g[6], g[7]);
  if (g[0] === 0x0064 && g[1] === 0xff9b) return quad(g[6], g[7]); // 64:ff9b::/96, NAT64
  if (g[0] === 0x2002) return quad(g[1], g[2]); // 2002::/16, 6to4
  return undefined;
}

/**
 * Whether an IP literal is one we refuse to originate requests to: loopback,
 * link-local (including the cloud metadata service on 169.254.169.254),
 * private/CGNAT ranges, and their IPv6 equivalents.
 */
export function isPrivateAddress(ip: string): boolean {
  // Normalize before classifying, not after: `isIP` rejects both a bracketed
  // literal and a zone id, so anything that reached the checks below still
  // wearing them was silently answered "not private".
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v = isIP(bare);
  if (v === 4) {
    const [a, b, c] = bare.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // 192.0.0.0/16, which is broader than the two reserved /24s inside it
    // (protocol assignments, and TEST-NET-1 at 192.0.2.0/24) but is not space
    // a media origin or relay is ever reachable on.
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (v === 6) {
    const g = ipv6Groups(bare);
    if (!g) return true; // `isIP` said v6 and we disagree: refuse rather than guess
    const embedded = embeddedIpv4(g);
    if (embedded) return isPrivateAddress(embedded);
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return false;
}

/**
 * Resolve `hostname`, vet every address it names, and return the one to
 * connect to — or undefined if any of them is private.
 *
 * Returning the address rather than a flag is what closes DNS rebinding:
 * {@link safeFetch} connects to this exact IP instead of handing the name back
 * to `fetch` for a second, independent resolution that the attacker's
 * nameserver is free to answer differently.
 *
 * A name that FAILS to resolve is refused. The previous default was to allow
 * it, reasoning that a name the resolver cannot answer reaches nothing anyway
 * — but that only holds if there is one resolution, and there were two. An
 * authoritative server that SERVFAILs the guard's query and answers 127.0.0.1
 * to the socket's got a bypass without needing rebinding at all. An
 * unresolvable media URL is not worth that; the relay path filters rather than
 * throws and has a fallback list, so a DNS hiccup degrades instead of breaking.
 *
 * Dotless names are refused outright: "localhost", "postgres", "redis" and
 * friends resolve per-host, are exactly the container-network shape this
 * guards, and never legitimately name a media origin or a public relay.
 */
export async function resolvePublicHost(hostname: string): Promise<string | undefined> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return isPrivateAddress(bare) ? undefined : bare;
  if (!hostname.includes(".")) return undefined;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return undefined;
  }
  if (addresses.length === 0) return undefined;
  if (addresses.some((a) => isPrivateAddress(a.address))) return undefined;
  return addresses[0].address;
}

/**
 * Whether every address `hostname` names is public.
 *
 * Exported because relay URLs need the same host test with a different scheme
 * allow-list (ws/wss rather than http/https) — see the portal's relayGuard.
 * The relay pool takes a URL and does its own connecting, so that caller gets
 * the verdict rather than the pinned address.
 */
export async function hostIsPublic(hostname: string): Promise<boolean> {
  return (await resolvePublicHost(hostname)) !== undefined;
}

/**
 * Parse and vet a URL that came from untrusted input. Throws with a reason
 * rather than returning a flag: every caller here treats a rejected URL as a
 * hard skip, and a silent falsy return is how one of these gets forgotten.
 */
export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  return (await vetHttpUrl(raw)).url;
}

/** {@link assertSafeHttpUrl}, keeping the address the verdict was made about. */
async function vetHttpUrl(raw: string): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`refusing to fetch malformed URL`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`refusing to fetch ${url.protocol} URL`);
  }
  const address = await resolvePublicHost(url.hostname);
  if (!address) {
    throw new Error(`refusing to fetch non-public host ${url.hostname}`);
  }
  return { url, address };
}

/**
 * The same request aimed at a literal address instead of a name, so the socket
 * cannot land somewhere the guard never saw.
 *
 * `Host` carries the original authority so virtual hosts still route, and TLS
 * keeps the NAME as its server identity — SNI and certificate validation are
 * about who we meant to talk to, and pinning the address must not become a way
 * to accept the wrong certificate. Pure and exported for the test: everything
 * interesting here is in the URL rewrite.
 */
export function pinnedTarget(url: URL, address: string): { url: string; host: string } {
  const pinned = new URL(url.toString());
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return { url: pinned.toString(), host: url.host };
}

export interface SafeFetchResult {
  body: Uint8Array;
  mime: string;
}

/**
 * Fetch an untrusted URL with the guard applied at every hop, and read the
 * body through a running byte counter.
 *
 * The counter is the point: `content-length` is supplied by the remote server
 * and is absent entirely for chunked responses, so checking it and then
 * calling `arrayBuffer()` buffers the whole body before the cap is ever
 * consulted — the cap only bound servers that volunteered their size.
 */
export async function safeFetch(
  raw: string,
  maxBytes: number,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<SafeFetchResult> {
  // One budget for the whole operation, not one per hop: three redirects that
  // each get the full timeout is three times the stall a caller asked for.
  const signal = init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  let { url: target, address } = await vetHttpUrl(raw);

  for (let hop = 0; ; hop++) {
    const pinned = pinnedTarget(target, address);
    const serverName = target.hostname.replace(/^\[|\]$/g, "");
    const res = await fetch(pinned.url, {
      ...init,
      signal,
      redirect: "manual",
      headers: { ...init?.headers, host: pinned.host },
      tls: {
        serverName,
        checkServerIdentity: (_connectedTo: string, cert: PeerCertificate) =>
          checkServerIdentity(serverName, cert),
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error(`download ${raw}: too many redirects`);
      // Resolve relative Locations against the hop we are on, then re-vet:
      // an unchecked Location is how a public URL reaches a private host.
      ({ url: target, address } = await vetHttpUrl(new URL(res.headers.get("location")!, target).toString()));
      continue;
    }
    if (!res.ok) throw new Error(`download ${raw}: HTTP ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`download ${raw}: ${declared} bytes exceeds cap`);
    }

    const mime = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    return { body: await readCapped(res, maxBytes, raw), mime };
  }
}

/**
 * Read a response body through a running byte counter, aborting the stream the
 * moment it goes over.
 *
 * Separate from {@link safeFetch} because this is the half that has to hold
 * even for a host we already trust, and because it is the half worth testing
 * on its own: the previous implementation checked `content-length` and then
 * called `arrayBuffer()`, which buffers everything before any check runs, so
 * the cap bound only servers that truthfully declared their size.
 */
export async function readCapped(res: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error(`download ${label}: body exceeds cap`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
