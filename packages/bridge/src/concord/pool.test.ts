import { expect, test } from "bun:test";
import { RelayPool } from "./pool";
test("strict moderation reads reject an unavailable relay instead of treating it as empty state", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response("no"); }, websocket: { message(ws, value) { const frame = JSON.parse(String(value)); if (frame[0] === "REQ") ws.send(JSON.stringify(["EOSE", frame[1]])); } } });
  const pool = new RelayPool([`ws://127.0.0.1:${server.port}`, "ws://127.0.0.1:1"]);
  try { await expect(pool.queryStrict([{ kinds: [1059] }], { signal: AbortSignal.timeout(100) })).rejects.toThrow(); }
  finally { await pool.close(); server.stop(true); }
});
