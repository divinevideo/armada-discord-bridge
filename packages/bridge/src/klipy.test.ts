import { describe, expect, it } from "bun:test";

import { KlipyClient, isKlipyMediaHost, klipyItem, pickGif } from "./klipy";

/** The Items API response for one slug, trimmed to the fields the bridge reads. */
function itemsResponse(slug: string, sizes: Record<string, number | undefined>) {
  const file: Record<string, { gif: { url: string; width: number; height: number; size?: number } }> = {};
  for (const [name, size] of Object.entries(sizes)) {
    file[name] = { gif: { url: `https://static.klipy.com/ii/x/${name}.gif`, width: 300, height: 300, size } };
  }
  return { result: true, data: { data: [{ slug, file }] } };
}

describe("klipyItem", () => {
  it("reads the kind and slug off a picker page URL", () => {
    expect(klipyItem("https://klipy.com/gifs/monday-already-monday-again-1")).toEqual({
      kind: "gifs",
      slug: "monday-already-monday-again-1",
    });
    expect(klipyItem("https://www.klipy.com/stickers/wave/")).toEqual({ kind: "stickers", slug: "wave" });
  });

  it("refuses anything else", () => {
    for (const url of [
      "https://klipy.com/clips/x",
      "https://klipy.com/gifs/x/y",
      "https://klipy.com.evil.example/gifs/x",
      "http://klipy.com/gifs/x",
      "https://static.klipy.com/gifs/x",
      "https://klipy.com/gifs/../api",
      "not a url",
    ]) {
      expect(klipyItem(url)).toBeUndefined();
    }
  });
});

describe("isKlipyMediaHost", () => {
  it("matches klipy.com and its subdomains only", () => {
    expect(isKlipyMediaHost("https://static.klipy.com/a.mp4")).toBe(true);
    expect(isKlipyMediaHost("https://static2.klipy.com/a.mp4")).toBe(true);
    expect(isKlipyMediaHost("https://notklipy.com/a.mp4")).toBe(false);
    expect(isKlipyMediaHost("https://klipy.com.evil.example/a.mp4")).toBe(false);
  });
});

describe("pickGif", () => {
  it("takes the largest rendition under the budget", () => {
    const item = itemsResponse("x", { hd: 900, md: 500, sm: 200 }).data.data[0];
    expect(pickGif(item, 600)?.url).toBe("https://static.klipy.com/ii/x/md.gif");
  });

  it("falls back to the smallest when none fits, and lets the download cap decide", () => {
    const item = itemsResponse("x", { hd: 900, md: 800 }).data.data[0];
    expect(pickGif(item, 100)?.url).toBe("https://static.klipy.com/ii/x/md.gif");
  });

  it("ignores renditions that are not https", () => {
    const item = { file: { hd: { gif: { url: "http://static.klipy.com/a.gif" } } } };
    expect(pickGif(item, 1000)).toBeUndefined();
  });
});

describe("KlipyClient.resolveGif", () => {
  it("looks the slug up and returns the chosen rendition", async () => {
    let asked: URL | undefined;
    const fetchImpl = (async (input: URL) => {
      asked = input;
      return Response.json(itemsResponse("monday-1", { hd: 100 }));
    }) as unknown as typeof fetch;
    const gif = await new KlipyClient("KEY", fetchImpl).resolveGif("https://klipy.com/gifs/monday-1", 1000);
    expect(gif).toEqual({ url: "https://static.klipy.com/ii/x/hd.gif", width: 300, height: 300, size: 100 });
    expect(asked?.pathname).toBe("/api/v1/KEY/gifs/items");
    expect(asked?.searchParams.get("slugs")).toBe("monday-1");
    expect(asked?.searchParams.get("customer_id")).toBeTruthy();
  });

  it("returns undefined on an API error without putting the key in the log", async () => {
    const logged: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => logged.push(...args);
    try {
      const fetchImpl = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
      expect(await new KlipyClient("SECRETKEY", fetchImpl).resolveGif("https://klipy.com/gifs/x", 1000)).toBeUndefined();
    } finally {
      console.warn = warn;
    }
    expect(JSON.stringify(logged)).not.toContain("SECRETKEY");
  });

  it("never calls out for a URL that is not a Klipy item", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    expect(await new KlipyClient("KEY", fetchImpl).resolveGif("https://tenor.com/view/x", 1000)).toBeUndefined();
    expect(called).toBe(false);
  });
});
