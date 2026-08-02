/**
 * Liveness daemon: run a tick roughly every 25 minutes (jittered) until
 * LIVENESS_UNTIL (ISO timestamp; default 3 days from start), then exit 0.
 * Pair with a systemd unit using Restart=on-failure so the clean end-of-run
 * exit actually stops the service.
 *
 *   bun run scripts/liveness/daemon.ts
 */

import { runTick } from "./tick";

const TICK_MS = 25 * 60_000;

const until = process.env.LIVENESS_UNTIL?.trim()
  ? Date.parse(process.env.LIVENESS_UNTIL.trim())
  : Date.now() + 3 * 24 * 3600_000;
if (Number.isNaN(until)) throw new Error(`bad LIVENESS_UNTIL: ${process.env.LIVENESS_UNTIL}`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`liveness daemon up; running until ${new Date(until).toISOString()}`);
  while (Date.now() < until) {
    try {
      await runTick({ dry: false, force: false });
    } catch (e) {
      console.error(`tick failed: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(TICK_MS * (0.7 + Math.random() * 0.6));
  }
  console.log("liveness window over; exiting.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`fatal: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
