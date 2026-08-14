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
 * Known bound: a name that resolves to a public address for our check and a
 * private one for the socket (DNS rebinding) is not covered — that needs
 * connect-time pinning, which `fetch` gives no hook for. Literal-IP and
 * static-DNS attacks, which is what an `imeta` tag realistically carries, are.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Redirect hops honored before a fetch is abandoned. */
const MAX_REDIRECTS = 3;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Whether an IP literal is one we refuse to originate requests to: loopback,
 * link-local (including the cloud metadata service on 169.254.169.254),
 * private/CGNAT ranges, and their IPv6 equivalents.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
    if (ip6 === "::" || ip6 === "::1") return true;
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms defer to the v4 rules.
    const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip6);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (ip6.startsWith("fe8") || ip6.startsWith("fe9") || ip6.startsWith("fea") || ip6.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    if (ip6.startsWith("fc") || ip6.startsWith("fd")) return true; // fc00::/7 ULA
    if (ip6.startsWith("ff")) return true; // multicast
    return false;
  }
  return false;
}

/**
 * Resolve `hostname` and report whether every address it names is public.
 *
 * Exported because relay URLs need the same host test with a different scheme
 * allow-list (ws/wss rather than http/https) — see the portal's relayGuard.
 *
 * A name that FAILS to resolve is treated as public, which looks like the
 * wrong default until you follow it through: the point of this check is to
 * stop us reaching an internal service, and a name the resolver cannot answer
 * for reaches nothing at all — the connect that follows fails on the same
 * resolver. Refusing here would buy no security and would make a relay
 * unconfigurable whenever DNS hiccuped, so the failure is left to the socket.
 * A name that resolves TO a private address is still refused, which is the
 * case that actually carries an attack.
 *
 * Dotless names are the exception and are refused outright: "localhost",
 * "postgres", "redis" and friends resolve per-host, are exactly the container
 * -network shape this guards, and never legitimately name a media origin or a
 * public relay.
 */
export async function hostIsPublic(hostname: string): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return !isPrivateAddress(bare);
  if (!hostname.includes(".")) return false;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return true;
  }
  if (addresses.length === 0) return true;
  return addresses.every((a) => !isPrivateAddress(a.address));
}

/**
 * Parse and vet a URL that came from untrusted input. Throws with a reason
 * rather than returning a flag: every caller here treats a rejected URL as a
 * hard skip, and a silent falsy return is how one of these gets forgotten.
 */
export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`refusing to fetch malformed URL`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`refusing to fetch ${url.protocol} URL`);
  }
  if (!(await hostIsPublic(url.hostname))) {
    throw new Error(`refusing to fetch non-public host ${url.hostname}`);
  }
  return url;
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
  let target = await assertSafeHttpUrl(raw);

  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error(`download ${raw}: too many redirects`);
      // Resolve relative Locations against the hop we are on, then re-vet:
      // an unchecked Location is how a public URL reaches a private host.
      target = await assertSafeHttpUrl(new URL(res.headers.get("location")!, target).toString());
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
