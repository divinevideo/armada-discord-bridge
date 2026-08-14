import { describe, expect, it } from "bun:test";

import { assertSafeHttpUrl, isPrivateAddress, readCapped } from "./net";

describe("isPrivateAddress", () => {
  it("names the IPv4 ranges we refuse to originate to", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "224.0.0.1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("lets real public addresses through", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it("covers the IPv6 equivalents, including v4-mapped forms", () => {
    for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertSafeHttpUrl", () => {
  // The one that mattered: Bun's fetch resolves file:// and data:, and this
  // process holds the seal key that unseals every per-bridge secret.
  it("refuses non-http schemes", async () => {
    for (const url of [
      "file:///proc/self/environ",
      "file:///etc/passwd",
      "data:text/plain,hello",
      "blob:https://example.com/x",
    ]) {
      await expect(assertSafeHttpUrl(url)).rejects.toThrow(/refusing to fetch/);
    }
  });

  it("refuses loopback and metadata hosts by literal IP", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5:9200/",
      "http://[::1]/x",
    ]) {
      await expect(assertSafeHttpUrl(url)).rejects.toThrow(/non-public host/);
    }
  });

  it("refuses bare intranet names that never name a real media origin", async () => {
    await expect(assertSafeHttpUrl("http://localhost:8787/")).rejects.toThrow(/non-public host/);
    await expect(assertSafeHttpUrl("http://postgres/")).rejects.toThrow(/non-public host/);
  });

  it("refuses malformed input rather than passing it to fetch", async () => {
    await expect(assertSafeHttpUrl("not a url")).rejects.toThrow(/malformed/);
  });
});

describe("readCapped", () => {
  it("stops an endless chunked body that never declares a length", async () => {
    // The shape the old code could not bound: no content-length, so its check
    // compared 0 against the cap and then buffered the lot.
    const endless = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
    );
    expect(endless.headers.get("content-length")).toBeNull();
    await expect(readCapped(endless, 256 * 1024, "endless")).rejects.toThrow(/exceeds cap/);
  });

  it("ignores a content-length that understates the real body", async () => {
    const lying = new Response(new Uint8Array(200 * 1024), {
      headers: { "content-length": "10" },
    });
    await expect(readCapped(lying, 64 * 1024, "lying")).rejects.toThrow(/exceeds cap/);
  });

  it("returns a body that fits, intact", async () => {
    const payload = new Uint8Array(1024).fill(7);
    const body = await readCapped(new Response(payload), 64 * 1024, "small");
    expect(body.length).toBe(1024);
    expect(body[0]).toBe(7);
    expect(body[1023]).toBe(7);
  });
});
