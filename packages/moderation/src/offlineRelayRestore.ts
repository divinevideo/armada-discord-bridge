import postgres from "postgres";
import type { NostrEvent } from "nostr-tools/pure";
import { PolicyStore } from "./policyStore";
import { LocalRelayDriver } from "./localRelayDriver";
import { reconcileRestore } from "./relayRestore";
import { MAX_EVENT_BYTES } from "./relayPolicy";
export class OfflineRestoreDriver extends LocalRelayDriver {
  async *scan(): AsyncIterable<NostrEvent> {
    const child = Bun.spawn(["strfry", "--config=/data/strfry.conf", "scan", "{}"], { stdout: "pipe", stderr: "ignore" });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error("Restored carrier exceeds limit");
          yield JSON.parse(line) as NostrEvent;
        }
        if (Buffer.byteLength(pending) > MAX_EVENT_BYTES) throw new Error("Restored carrier exceeds limit");
      }
      if (pending.length || await child.exited !== 0) throw new Error("Restore scan incomplete");
    } finally { child.kill(); await child.exited; reader.releaseLock(); }
  }
}
if (import.meta.main) {
  let sql: postgres.Sql | undefined;
  try {
    if (!process.env.MODERATION_DATABASE_URL || !process.env.MODERATION_RESTORE_REVISIONS) throw new Error("Recovery configuration required");
    sql = postgres(process.env.MODERATION_DATABASE_URL, { max: 2, onnotice: () => {} });
    const result = await reconcileRestore(new PolicyStore(sql), new OfflineRestoreDriver("ws://127.0.0.1:7777"), JSON.parse(process.env.MODERATION_RESTORE_REVISIONS));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch { process.stderr.write("Relay restore reconciliation failed; keep public listener stopped\n"); process.exitCode = 1; }
  finally { if (sql) await sql.end(); }
}
