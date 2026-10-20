import postgres from "postgres";
import type { NostrEvent } from "nostr-tools/pure";
import type { AdmissionResult } from "./contracts";
import { loadPublicCapacity } from "./publicCapacity";
import { PolicyStore } from "./policyStore";
import { HEX_ID, MAX_EVENT_BYTES } from "./relayPolicy";

/** Bounded input; process/SQL deadlines complement strfry's hard plugin timeout. */
export async function runPlugin(
  input: AsyncIterable<Uint8Array>,
  output: (line: string) => void | Promise<void>,
  admit: (event: NostrEvent, signal: AbortSignal) => Promise<AdmissionResult>,
  options: { timeoutMs?: number; burst?: number } = {},
): Promise<void> {
  const limit = MAX_EVENT_BYTES + 4096;
  const burst = options.burst ?? 100;
  let tokens = burst, refilledAt = performance.now();
  let buffer = Buffer.alloc(0), discarding = false;
  const reject = (id = "0".repeat(64)): AdmissionResult => ({ id, action: "reject", msg: "blocked: room policy unavailable or event not permitted" });
  const handle = async (line: Buffer) => {
    let id = "0".repeat(64);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: AdmissionResult;
    try {
      const request = JSON.parse(line.toString("utf8"));
      if (typeof request?.event?.id === "string" && HEX_ID.test(request.event.id)) id = request.event.id;
      if (request?.type !== "new" || !request.event) throw new Error();
      const now = performance.now();
      tokens = Math.min(burst, tokens + (now - refilledAt) * burst / 1000);
      refilledAt = now;
      if (tokens < 1) throw new Error();
      tokens--;
      const abort = new AbortController();
      const admission = Promise.resolve().then(() => admit(request.event, abort.signal)).catch(() => reject(id));
      const completed = await Promise.race([
        admission,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(undefined); }, options.timeoutMs ?? 2000); }),
      ]);
      // A timeout is a cancellation request, not proof of rollback. Do not
      // report rejection (or process the next event) while effects can commit.
      // The real store checks the signal inside its bounded transaction. If a
      // callback cannot settle, strfry's external timeout stops this process.
      result = completed ?? await admission;
      if (result.id !== id || !["accept", "reject"].includes(result.action)) result = reject(id);
      // Only fixed public reasons cross the process boundary.
      result = result.action === "accept" ? { id, action: "accept" } : reject(id);
    } catch { result = reject(id); }
    finally { if (timer) clearTimeout(timer); }
    await output(JSON.stringify(result) + "\n");
  };
  for await (const raw of input) {
    const chunk = Buffer.from(raw);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (!discarding && buffer.length + end - offset <= limit) buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
      else { buffer = Buffer.alloc(0); discarding = true; }
      if (newline >= 0) {
        if (discarding) await output(JSON.stringify(reject()) + "\n");
        else await handle(buffer);
        buffer = Buffer.alloc(0); discarding = false;
      }
      offset = end + 1;
    }
  }
  if (buffer.length || discarding) await output(JSON.stringify(reject()) + "\n");
}

if (import.meta.main) {
  const url = process.env.MODERATION_DATABASE_URL;
  if (!url) { process.stderr.write("Moderation database is not configured\n"); process.exit(1); }
  const sql = postgres(url, { max: 1, connect_timeout: 1, idle_timeout: 10, onnotice: () => {} });
  const store = new PolicyStore(sql, { capacity: loadPublicCapacity(), ...(process.env.MODERATION_CAPACITY_TIMING === "1" ? { onAdmissionTiming: (sample: { innerAdmissionMs: number; action: "accept" | "reject" }) => { process.stderr.write(JSON.stringify({ type: "moderation_admission_timing", ...sample }) + "\n"); } } : {}) });
  try {
    await runPlugin(process.stdin, (line) => new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => error ? reject(error) : resolve());
    }), (event, signal) => store.admit(event, signal));
  } catch {
    process.stderr.write("Moderation validator stopped\n");
    process.exitCode = 1;
  } finally { await sql.end({ timeout: 1 }); }
}
