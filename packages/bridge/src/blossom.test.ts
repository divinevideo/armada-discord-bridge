import { afterEach, describe, expect, it } from "bun:test";
import { generateSecretKey } from "nostr-tools";

import { BlossomStore, blossomServers } from "./blossom";
import { localIdentity } from "./concord/signer";

type Handler = (req: Request) => Response | Promise<Response>;

const servers: Array<ReturnType<typeof Bun.serve>> = [];

/** A local Blossom stand-in that records what reached it. */
function blossom(handler: Handler): { url: string; hits: Request[] } {
  const hits: Request[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits.push(req);
      return handler(req);
    },
  });
  console.info("OWNED_TEST_SERVER", JSON.stringify({ pid: process.pid, ports: [server.port] }));
  servers.push(server);
  return { url: `http://127.0.0.1:${String(server.port)}`, hits };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const author = localIdentity(generateSecretKey());
const data = new Uint8Array([1, 2, 3]);

describe("blossomServers", () => {
  it("splits a comma-separated preference list", () => {
    expect(blossomServers(" https://a.example/ , ,https://b.example//")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("BlossomStore.upload", () => {
  it("uses the first server when it accepts", async () => {
    const first = blossom(() => Response.json({ url: "https://a.example/abc" }));
    const second = blossom(() => Response.json({ url: "https://b.example/abc" }));
    const store = new BlossomStore(`${first.url},${second.url}`);
    expect((await store.upload(data, "image/png", author)).url).toBe("https://a.example/abc");
    expect(second.hits).toHaveLength(0);
  });

  it("falls through to the next server on an error status", async () => {
    // The failure that motivated this: primal answering 500/401 for days.
    const first = blossom(() => new Response("nope", { status: 500 }));
    const second = blossom(() => Response.json({ url: "https://b.example/abc" }));
    const store = new BlossomStore(`${first.url},${second.url}`);
    expect((await store.upload(data, "image/png", author)).url).toBe("https://b.example/abc");
    expect(first.hits).toHaveLength(1);
  });

  it("falls through when a server is unreachable", async () => {
    const dead = blossom(() => new Response(""));
    const deadUrl = dead.url;
    for (const s of servers.splice(0)) s.stop(true);
    const live = blossom(() => Response.json({}));
    const store = new BlossomStore([deadUrl, live.url]);
    const { url, sha256 } = await store.upload(data, "image/png", author);
    // No descriptor URL: fall back to BUD-01's /<sha256> on the server that took it.
    expect(url).toBe(`${live.url}/${sha256}`);
  });

  it("reports every server when all of them fail", async () => {
    const a = blossom(() => new Response("", { status: 401 }));
    const b = blossom(() => new Response("", { status: 500 }));
    const store = new BlossomStore([a.url, b.url]);
    const upload = store.upload(data, "image/png", author);
    await expect(upload).rejects.toThrow(`${a.url}: HTTP 401`);
    await expect(upload).rejects.toThrow(`${b.url}: HTTP 500`);
  });

  it("refuses to be built with no server", () => {
    expect(() => new BlossomStore(" , ")).toThrow();
  });
});
