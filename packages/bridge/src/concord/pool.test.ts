import { expect, test } from "bun:test";
import { RelayPool } from "./pool";
test("strict moderation reads reject an unavailable relay instead of treating it as empty state", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response("no"); }, websocket: { message(ws, value) { const frame = JSON.parse(String(value)); if (frame[0] === "REQ") ws.send(JSON.stringify(["EOSE", frame[1]])); } } });
  const pool = new RelayPool([`ws://127.0.0.1:${server.port}`, "ws://127.0.0.1:1"]);
  try { await expect(pool.queryStrict([{ kinds: [1059] }], { signal: AbortSignal.timeout(100) })).rejects.toThrow(); }
  finally { await pool.close(); server.stop(true); }
});
test("an aborted publish cannot escape a delayed connection after authority is lost", async () => {
  const { finalizeEvent, generateSecretKey } = await import("nostr-tools/pure");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const received: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) { await gate; if (server.upgrade(request)) return; return new Response("no"); }, websocket: { message(_ws, value) { received.push(JSON.parse(String(value))); } } });
  const pool = new RelayPool([`ws://127.0.0.1:${server.port}`]);
  try {
    const event = finalizeEvent({ kind: 1, content: "synthetic", tags: [], created_at: Math.floor(Date.now()/1000) }, generateSecretKey());
    await expect(pool.publish(event, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
    release();
    // A protocol query is a deterministic barrier: reconnect has flushed its buffer.
    server.reload({ fetch(request, server) { if (server.upgrade(request)) return; return new Response("no"); }, websocket: { message(ws, value) { const frame = JSON.parse(String(value)); received.push(frame); if (frame[0] === "REQ") ws.send(JSON.stringify(["EOSE", frame[1]])); } } });
    await pool.queryStrict([{ kinds: [1] }], { signal: AbortSignal.timeout(1000) });
    expect(received.filter((frame: any) => frame[0] === "EVENT")).toHaveLength(0);
  } finally { release(); await pool.close(); server.stop(true); }
});
test("live publications acknowledge once and never replay automatically after AUTH", async () => {
  const { finalizeEvent, generateSecretKey } = await import("nostr-tools/pure");
  const events: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response("no"); }, websocket: { message(ws, value) {
    const frame = JSON.parse(String(value));
    if (frame[0] === "REQ") ws.send(JSON.stringify(["EOSE", frame[1]]));
    if (frame[0] === "EVENT") { events.push(frame[1].id); ws.send(JSON.stringify(["OK", frame[1].id, frame[1].content === "accepted", "auth-required: synthetic"])); }
    if (frame[0] === "AUTH") ws.send(JSON.stringify(["OK", frame[1].id, true, ""]));
  } } });
  const pool = new RelayPool([`ws://127.0.0.1:${server.port}`]);
  try {
    await pool.queryStrict([{ kinds: [1] }]);
    const event = (content: string) => finalizeEvent({ kind: 1, content, tags: [], created_at: Math.floor(Date.now()/1000) }, generateSecretKey());
    await pool.publish(event("accepted"));
    const rejected = event("requires-auth");
    await expect(pool.publish(rejected)).rejects.toThrow();
    await pool.queryStrict([{ kinds: [1] }]);
    expect(events.filter((id) => id === rejected.id)).toHaveLength(1);
  } finally { await pool.close(); server.stop(true); }
});
