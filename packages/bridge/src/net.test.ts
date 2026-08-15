import { describe, expect, it } from "bun:test";

import { assertSafeHttpUrl, isPrivateAddress, pinnedTarget, readCapped } from "./net";

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

  it("names the reserved IPv4 blocks that are not RFC1918", () => {
    for (const ip of ["192.0.0.1", "192.0.2.5", "198.18.0.1", "198.19.255.1", "198.51.100.7", "203.0.113.9", "192.88.99.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("covers the IPv6 equivalents, including v4-mapped forms", () => {
    for (const ip of ["::1", "::", "fe80::1", "febf::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  // The regression that mattered: `new URL()` re-serializes an IPv6 host into
  // the canonical all-hex form, so `[::ffff:127.0.0.1]` reaches the guard
  // spelled `::ffff:7f00:1`. The old check demanded a dotted quad and matched
  // none of these, which made every one of them "public".
  it("classifies embedded IPv4 by value, in the spelling a URL actually yields", () => {
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:a9fe:a9fe", // 169.254.169.254, the metadata service
      "::ffff:a00:1", // 10.0.0.1
      "0:0:0:0:0:ffff:7f00:1", // uncompressed spelling of the same
      "::7f00:1", // v4-compatible
      "64:ff9b::7f00:1", // NAT64
      "2002:7f00:1::", // 6to4
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    // The same forms naming a public address stay usable.
    expect(isPrivateAddress("::ffff:808:808")).toBe(false);
    expect(isPrivateAddress("2002:808:808::")).toBe(false);
  });

  // `isIP` rejects both spellings, so before normalization moved ahead of it
  // these fell through every check and were answered "public".
  it("classifies a bracketed or zone-suffixed literal", () => {
    expect(isPrivateAddress("[::1]")).toBe(true);
    expect(isPrivateAddress("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
  });
});

describe("pinnedTarget", () => {
  it("aims the request at the address, keeping the authority for Host", () => {
    const pinned = pinnedTarget(new URL("https://cdn.example.com/a/b.png?x=1"), "93.184.216.34");
    expect(pinned.url).toBe("https://93.184.216.34/a/b.png?x=1");
    expect(pinned.host).toBe("cdn.example.com");
  });

  it("brackets IPv6 and preserves a non-default port", () => {
    const pinned = pinnedTarget(new URL("https://cdn.example.com:8443/a"), "2606:4700::1111");
    expect(pinned.url).toBe("https://[2606:4700::1111]:8443/a");
    expect(pinned.host).toBe("cdn.example.com:8443");
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

  it("refuses loopback and metadata spelled as an IPv6 literal", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[64:ff9b::7f00:1]/x",
      "http://[::ffff:10.0.0.5]:9200/",
    ]) {
      await expect(assertSafeHttpUrl(url)).rejects.toThrow(/non-public host/);
    }
  });

  // Fail closed. Two resolutions happen (ours, then the socket's), so a name
  // our resolver cannot answer is not a name the socket cannot reach.
  it("refuses a name that does not resolve", async () => {
    await expect(assertSafeHttpUrl("http://nothing.here.invalid/x")).rejects.toThrow(/non-public host/);
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
