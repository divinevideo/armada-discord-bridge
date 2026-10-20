import { HEX_ID } from "./relayPolicy";
import type { PurgeDriver } from "./relayPurge";

/** Fixed local commands only. Callers supply validated event IDs, never filters. */
export class LocalRelayDriver implements PurgeDriver {
  constructor(private readonly relayUrl: string) {
    const url = new URL(relayUrl);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Purge verification must use the local relay");
  }
  async barrier<T>(work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    const holder = Bun.spawn(["flock", "--exclusive", "--wait", "30", "/data/admission.lock", "/bin/sh", "-c", "printf 'locked\\n'; read -r release"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const reader = holder.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Relay barrier unavailable")), 31_000); })]);
      clearTimeout(timer);
      if (first.done || new TextDecoder().decode(first.value) !== "locked\n") throw new Error("Relay barrier unavailable");
      const controller = new AbortController();
      void holder.exited.then(() => controller.abort());
      // Cancellation must settle the callback before cleanup releases resources;
      // racing it lets database updates continue after the barrier has returned.
      const result = await work(controller.signal);
      if (controller.signal.aborted) throw new Error("Relay barrier lost");
      return result;
    } finally {
      clearTimeout(timer);
      try { holder.stdin.write("release\n"); holder.stdin.end(); } catch { holder.kill(); }
      await holder.exited;
      reader.releaseLock();
    }
  }
  async delete(ids: string[]): Promise<void> {
    if (!ids.every((id) => HEX_ID.test(id))) throw new Error("Invalid carrier IDs");
    for (let offset = 0; offset < ids.length; offset += 128) {
      const child = Bun.spawn(["strfry", "--config=/data/strfry.conf", "delete", `--filter=${JSON.stringify({ ids: ids.slice(offset, offset + 128) })}`], { stdout: "ignore", stderr: "ignore" });
      const deadline = setTimeout(() => child.kill(), 30_000);
      try { if (await child.exited !== 0) throw new Error("Relay purge failed"); }
      finally { clearTimeout(deadline); }
    }
  }
  async remaining(ids: string[]): Promise<string[]> {
    if (!ids.every((id) => HEX_ID.test(id))) throw new Error("Invalid carrier IDs");
    const found: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 128) {
      const batch = new Set(ids.slice(offset, offset + 128));
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(this.relayUrl);
        const subscription = crypto.randomUUID();
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          error ? reject(error) : resolve();
          ws.close();
        };
        const timer = setTimeout(() => finish(new Error("Relay verification unavailable")), 5000);
        ws.onopen = () => ws.send(JSON.stringify(["REQ", subscription, { ids: [...batch] }]));
        ws.onerror = () => finish(new Error("Relay verification unavailable"));
        ws.onclose = () => finish(new Error("Relay verification interrupted"));
        ws.onmessage = (message) => {
          try {
            const frame = JSON.parse(String(message.data));
            if (frame[1] !== subscription) return;
            if (frame[0] === "EVENT" && batch.has(frame[2]?.id)) found.push(frame[2].id);
            if (frame[0] === "EOSE") finish();
            if (frame[0] === "CLOSED") finish(new Error("Relay verification rejected"));
          } catch { finish(new Error("Relay verification malformed")); }
        };
      });
    }
    return found;
  }
}
