/**
 * Security headers for every response the portal serves.
 *
 * The Content Security Policy is written against what the SPA build actually
 * emits — external modules and one stylesheet, no inline script — so scripts
 * need no inline allowance at all. The single inline script in this codebase
 * is the OAuth popup's, which overrides this policy with a per-response nonce.
 *
 * Deliberately NOT set: Cross-Origin-Opener-Policy. `same-origin` would sever
 * `window.opener` on the callback page and break the popup token handoff --
 * that exact COOP behaviour on Discord's own pages is why the nonce poller
 * exists in the first place.
 */

import type { Context, Next } from "hono";

/**
 * Relays the SPA opens sockets to itself, for kind 0 profile lookups. Must
 * match PROFILE_RELAYS in web/src/nostrProfile.ts: connect-src pins the list,
 * so a relay added there and not here fails silently in the browser. There is
 * a test for exactly that.
 */
export const SPA_RELAYS = ["wss://purplepag.es", "wss://relay.damus.io", "wss://relay.ditto.pub"];

export const CSP = [
  "default-src 'none'",
  // The extension schemes keep NIP-07 signers working: some inject their
  // provider as a script element into the page rather than the main world.
  "script-src 'self' chrome-extension: moz-extension:",
  // React writes style attributes; nothing injects stylesheets.
  "style-src 'self' 'unsafe-inline'",
  // Avatars: Discord's CDN, and whatever host a kind 0 profile names.
  "img-src 'self' data: https:",
  "font-src 'self'",
  // The interesting line: script injected into the portal has nowhere to send
  // what it steals.
  `connect-src 'self' ${SPA_RELAYS.join(" ")}`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Set before the handler runs, so the headers reach streamed responses (the
 * confirm screen's event stream) too. Handlers may override: the OAuth popup
 * page swaps in a nonce policy of its own.
 */
export function securityHeaders(overHttps: boolean) {
  return async (c: Context, next: Next) => {
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    if (overHttps) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    return next();
  };
}

/**
 * Refuse state-changing requests from an origin we do not recognise, so CSRF
 * defence does not rest on `SameSite=Lax` alone.
 *
 * Lax is a real control and does block cross-site POST in current browsers.
 * But it is one layer, enforced entirely by the client, and it stops covering
 * anything that later becomes reachable by a top-level GET or a form post.
 * This is the server-side half of the same claim.
 *
 * A request with NO `Origin` header passes. Browsers always send it on these
 * methods, so its absence means a non-browser caller — curl, or the popup
 * handoff's server-side poller — which could never have ridden a victim's
 * cookies to begin with. Refusing those would break real callers to defend
 * against a shape that cannot occur. `Origin` present but unrecognised is the
 * attack, and that is what this turns away.
 */
export function originGuard(baseUrl: string, allowedOrigins: readonly string[]) {
  const self = new URL(baseUrl).origin;
  return async (c: Context, next: Next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
    const origin = c.req.header("Origin");
    if (origin && origin !== self && !allowedOrigins.includes(origin)) {
      console.warn(`portal: refused ${c.req.method} ${c.req.path} from origin ${JSON.stringify(origin)}`);
      return c.json({ error: "origin not allowed" }, 403);
    }
    return next();
  };
}
