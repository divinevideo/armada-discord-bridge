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
