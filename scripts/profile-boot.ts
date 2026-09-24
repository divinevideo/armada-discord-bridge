/**
 * Read-only reproduction of the portal's boot, for profiling.
 *
 * Replays the relay half of BridgeManager.start() — resolve the invite, open
 * the pool, fold the control plane, intake private-channel keys, and hold the
 * chat + control subscriptions open — for the first LIMIT active bridges in
 * boot order. No Discord, no publishes, no writes: it can run beside the live
 * portal. Reports wall time, CPU time and RSS through boot and a steady-state
 * hold, and under `bun --cpu-prof-md` leaves a profile behind on exit.
 *
 *   PORTAL_SEAL_KEY=... DATABASE_URL=... LIMIT=150 HOLD_S=120 \
 *     bun --cpu-prof-md --cpu-prof-dir=/tmp run scripts/profile-boot.ts
 */

import { heapStats } from "bun:jsc";
import postgres from "postgres";

import { Permissions, STOCK_RELAYS, inviteDeliveryRelays, isAuthorized, parseInviteLink } from "@armada-bridge/concord-core";
import { ConcordClient, resolveInvite } from "../packages/bridge/src/concord/client";
import { intakeDirectInviteKeys } from "../packages/bridge/src/concord/keyIntake";
import { RelayPool } from "../packages/bridge/src/concord/pool";
import { localIdentity } from "../packages/bridge/src/concord/signer";
import { filterPublicRelays } from "../packages/portal/src/relayGuard";
import { unseal } from "../packages/portal/src/seal";

const sealKey = process.env.PORTAL_SEAL_KEY;
if (!sealKey) throw new Error("PORTAL_SEAL_KEY not set");
const LIMIT = Number(process.env.LIMIT ?? 150);
const HOLD_S = Number(process.env.HOLD_S ?? 120);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 12);

const sql = postgres(process.env.DATABASE_URL ?? "", { onnotice: () => {}, max: 2 });

interface Row {
  bridge_id: string;
  invite_url_sealed: Uint8Array;
  primary_sk_sealed: Uint8Array;
  concord_channel_id: string | null;
}

// Same query as BridgeManager.init() (no ORDER BY: heap order is boot order).
const rows = (
  await sql<Row[]>`
    SELECT bridge_id, invite_url_sealed, primary_sk_sealed, concord_channel_id
    FROM bridges WHERE status IN ('pending_confirm', 'active')`
).filter((r) => r.invite_url_sealed && r.primary_sk_sealed).slice(0, LIMIT);
await sql.end();

const t0 = performance.now();
const cpu0 = process.cpuUsage();

// This shares a container with the live portal: bail out long before the two
// of them together can run it out of memory.
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB ?? 900);
setInterval(() => {
  if (process.memoryUsage().rss / 2 ** 20 > MAX_RSS_MB) {
    report(`RSS GUARD (${MAX_RSS_MB}MB) — exiting after ${done} bridges`);
    printHeap();
    process.exit(2);
  }
}, 1_000).unref();
function printHeap(): void {
  Bun.gc(true);
  const { objectTypeCounts, heapSize } = heapStats();
  const top = Object.entries(objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`heap ${(heapSize / 2 ** 20).toFixed(0)}MB; top object types:`, Object.fromEntries(top));
}

function report(label: string): void {
  const cpu = process.cpuUsage(cpu0);
  const wall = (performance.now() - t0) / 1000;
  const cpuS = (cpu.user + cpu.system) / 1e6;
  const rss = process.memoryUsage().rss / 2 ** 20;
  console.log(
    `${label}: wall=${wall.toFixed(1)}s cpu=${cpuS.toFixed(1)}s (${((cpuS / wall) * 100).toFixed(0)}%) rss=${rss.toFixed(0)}MB`,
  );
}

const pools: RelayPool[] = [];
const unsubs: Array<() => void> = [];
const outcome = new Map<string, number>();
const tally = (k: string) => outcome.set(k, (outcome.get(k) ?? 0) + 1);

async function startOne(row: Row): Promise<void> {
  const inviteUrl = unseal(sealKey!, row.invite_url_sealed);
  const invite = parseInviteLink(inviteUrl);
  if (!invite) return tally("bad-link");
  const bootstrap = new RelayPool(
    await filterPublicRelays(invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS, STOCK_RELAYS),
  );
  let community;
  try {
    ({ community } = await resolveInvite(inviteUrl, bootstrap));
  } catch {
    return tally("no-bundle");
  } finally {
    void bootstrap.close();
  }
  const pool = new RelayPool(await filterPublicRelays(community.relays, STOCK_RELAYS));
  pools.push(pool);
  const primary = localIdentity(Uint8Array.from(Buffer.from(unseal(sealKey!, row.primary_sk_sealed), "hex")));
  const preflight = new ConcordClient(community, pool, primary);
  const folded = await preflight.syncControl();
  const floor = new RelayPool(inviteDeliveryRelays([]));
  const intake = await intakeDirectInviteKeys([pool, floor], primary, community, {
    isAuthorizedSender: (pk) => isAuthorized(folded.roster, pk, community.owner, Permissions.MANAGE_CHANNELS),
  }).finally(() => void floor.close());
  const client = intake.learned.length > 0 ? new ConcordClient(intake.community, pool, primary) : preflight;
  if (intake.learned.length > 0) await client.syncControl();
  const channel = row.concord_channel_id ? client.channel(row.concord_channel_id) : undefined;
  if (!channel) return tally("no-channel");
  unsubs.push(client.subscribeChannel(channel, () => {}));
  unsubs.push(client.subscribeControl(() => void client.channel(channel.idHex)));
  tally("live");
}

console.log(`profiling boot of ${rows.length} bridges, concurrency ${CONCURRENCY}`);
const queue = [...rows];
let done = 0;
const ticker = setInterval(() => report(`  boot ${done}/${rows.length}`), 15_000);
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      await startOne(row).catch(() => tally("error"));
      done++;
    }
  }),
);
clearInterval(ticker);
report("BOOT DONE");
console.log(Object.fromEntries(outcome));
printHeap();

const holdCpu0 = process.cpuUsage();
const holdT0 = performance.now();
await new Promise((resolve) => setTimeout(resolve, HOLD_S * 1000));
const holdCpu = process.cpuUsage(holdCpu0);
console.log(
  `STEADY STATE: ${(((holdCpu.user + holdCpu.system) / 1e3 / (performance.now() - holdT0)) * 100).toFixed(0)}% cpu over ${HOLD_S}s`,
);
report("END");

for (const u of unsubs) u();
await Promise.allSettled(pools.map((p) => p.close()));
process.exit(0);
