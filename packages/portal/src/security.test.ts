/**
 * The CSP is only as good as its assumptions about the SPA, and those live in
 * another package. These tests fail when the two drift apart, instead of
 * letting the browser discover it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { CSP, SPA_RELAYS } from "./security";

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
