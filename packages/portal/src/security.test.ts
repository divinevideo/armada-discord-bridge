/**
 * The CSP is only as good as its assumptions about the SPA, and those live in
 * another package. These tests fail when the two drift apart, instead of
 * letting the browser discover it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { Hono } from "hono";

import { CSP, SPA_RELAYS, originGuard } from "./security";

const web = join(import.meta.dir, "..", "web");
const distIndex = join(web, "dist", "index.html");

const directive = (name: string): string =>
  CSP.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("content security policy", () => {
  it("allows no inline or eval'd script", () => {
    expect(directive("script-src")).not.toContain("unsafe-inline");
    expect(CSP).not.toContain("unsafe-eval");
    expect(CSP).toContain("default-src 'none'");
  });

  it("pins where the browser may talk", () => {
    const connect = directive("connect-src");
    expect(connect).toContain("'self'");
    // No blanket schemes: an injected script must have nowhere to exfiltrate.
    expect(connect).not.toMatch(/\shttps:|\swss:(?!\/)/);
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("base-uri 'none'");
  });

  it("lists exactly the relays the SPA dials", () => {
    const source = readFileSync(join(web, "src", "nostrProfile.ts"), "utf8");
    const declared = [...source.matchAll(/"(wss:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(SPA_RELAYS)).toEqual(new Set(declared));
    for (const relay of declared) expect(directive("connect-src")).toContain(relay);
  });
});

/** Skipped when the SPA hasn't been built; CI and deploys build it. */
describe.skipIf(!existsSync(distIndex))("built SPA", () => {
  const html = existsSync(distIndex) ? readFileSync(distIndex, "utf8") : "";

  it("carries no inline script, which is what script-src 'self' assumes", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0); // the bundle is linked, not absent
    for (const tag of scripts) expect(tag).toContain(" src=");
  });

  it("carries no inline stylesheet or event-handler attribute", () => {
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son(click|load|error)=/i);
  });
});

/**
 * The server-side half of CSRF defence. `SameSite=Lax` blocks the same shape
 * in the browser, but that is one control enforced by the client; these are
 * the cases that must not depend on it.
 */
describe("originGuard", () => {
  const guard = originGuard("https://bridge.armada.buzz", ["https://armada.buzz"]);
  const app = new Hono();
  app.use("/api/*", guard);
  app.all("/api/x", (c) => c.json({ ok: true }));

  const post = (headers: Record<string, string> = {}) =>
    app.request("/api/x", { method: "POST", headers });

  it("allows same-origin and allow-listed origins", async () => {
    expect((await post({ Origin: "https://bridge.armada.buzz" })).status).toBe(200);
    expect((await post({ Origin: "https://armada.buzz" })).status).toBe(200);
  });

  it("refuses a state-changing request from anywhere else", async () => {
    for (const origin of [
      "https://evil.example",
      // Neighbours of the real origins: substring matching would pass these.
      "https://armada.buzz.evil.example",
      "https://bridge.armada.buzz.evil.example",
      "http://bridge.armada.buzz",
      "null",
    ]) {
      expect((await post({ Origin: origin })).status).toBe(403);
    }
  });

  it("allows a caller that sends no Origin at all", async () => {
    // Browsers always send Origin on POST, so this is a non-browser client —
    // which never had a victim's cookies to ride in the first place.
    expect((await post()).status).toBe(200);
  });

  it("leaves reads alone", async () => {
    const res = await app.request("/api/x", { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });
});
