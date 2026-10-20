import { expect, test } from "bun:test";
import { LocalRelayDriver } from "./localRelayDriver";
test("fresh verification query completes on EOSE and returns only requested IDs", async () => {
  const id = "a".repeat(64);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("no", { status: 400 }); },
    websocket: { message(ws, value) { const [, subscription] = JSON.parse(String(value)); ws.send(JSON.stringify(["EVENT", subscription, { id }])); ws.send(JSON.stringify(["EOSE", subscription])); } },
  });
  console.info("OWNED_TEST_SERVER", JSON.stringify({ pid: process.pid, ports: [server.port] }));
  try { expect(await new LocalRelayDriver(`ws://127.0.0.1:${server.port}`).remaining([id])).toEqual([id]); }
  finally { server.stop(true); }
});
