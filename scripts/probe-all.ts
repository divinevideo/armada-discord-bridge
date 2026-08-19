/**
 * Read-only triage of severed bridges: which ones would start today?
 *
 * For each severed row whose Discord channel is not already held by a live
 * bridge, resolve its sealed invite and fold the control plane exactly as
 * start() would, and report whether the bridged channel comes back. A row
 * that resolves was severed by a transient relay failure, not by anything
 * having actually gone away.
 *
 *   PORTAL_SEAL_KEY=... DATABASE_URL=... bun run scripts/probe-all.ts
 */

import postgres from "postgres";
import { generateSecretKey } from "nostr-tools/pure";

import { ConcordClient, resolveInvite } from "../packages/bridge/src/concord/client";
import { RelayPool } from "../packages/bridge/src/concord/pool";
import { localIdentity } from "../packages/bridge/src/concord/signer";
import { unseal } from "../packages/portal/src/seal";
import { STOCK_RELAYS, parseInviteLink } from "@armada-bridge/concord-core";

const sealKey = process.env.PORTAL_SEAL_KEY;
if (!sealKey) throw new Error("PORTAL_SEAL_KEY not set");
const sql = postgres(process.env.DATABASE_URL ?? "", { onnotice: () => {} });

interface Row {
  bridge_id: string;
  invite_url_sealed: Uint8Array;
  concord_channel_id: string;
  discord_channel_id: string;
  discord_guild_name: string | null;
  discord_channel_name: string | null;
  status_detail: string | null;
  created_at: string;
}

const rows = await sql<Row[]>`
  SELECT b.bridge_id, b.invite_url_sealed, b.concord_channel_id, b.discord_channel_id,
         b.discord_guild_name, b.discord_channel_name, b.status_detail, b.created_at
  FROM bridges b
  WHERE b.status = 'severed'
    AND b.invite_url_sealed IS NOT NULL
    AND b.primary_sk_sealed IS NOT NULL
    AND b.concord_channel_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM bridges o
      WHERE o.discord_channel_id = b.discord_channel_id
        AND o.status IN ('active', 'pending_confirm')
    )
  ORDER BY b.discord_guild_name, b.discord_channel_name, b.created_at DESC`;

console.log(`candidates: ${rows.length}`);

async function probe(row: Row): Promise<string> {
  let inviteUrl: string;
  try {
    inviteUrl = unseal(sealKey!, row.invite_url_sealed);
  } catch {
    return "UNSEAL_FAILED";
  }
  const invite = parseInviteLink(inviteUrl);
  if (!invite) return "BAD_LINK";

  const bootstrap = new RelayPool(
    invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS,
  );
  let community;
  try {
    ({ community } = await resolveInvite(inviteUrl, bootstrap));
  } catch (error) {
    return `NO_BUNDLE (${String(error).slice(0, 60)})`;
  } finally {
    await bootstrap.close().catch(() => {});
  }

  const pool = new RelayPool(community.relays);
  try {
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    await client.syncControl();
    return client.channel(row.concord_channel_id) ? "RESOLVES" : "NO_CHANNEL";
  } catch (error) {
    return `FOLD_FAILED (${String(error).slice(0, 60)})`;
  } finally {
    await pool.close().catch(() => {});
  }
}

const results: Array<{ row: Row; verdict: string }> = [];
const queue = [...rows];
async function worker(): Promise<void> {
  for (let row = queue.shift(); row; row = queue.shift()) {
    const verdict = await probe(row);
    results.push({ row, verdict });
    console.log(
      `${verdict.padEnd(24)} ${row.bridge_id.slice(0, 8)}  ${row.discord_guild_name ?? "?"} / #${row.discord_channel_name ?? "?"}`,
    );
  }
}
await Promise.all(Array.from({ length: Math.min(8, queue.length) }, () => worker()));

// One live bridge per Discord channel is enforced by a partial unique index,
// so duplicates that both probe clean must not both be resumed: keep the
// newest and leave the older row severed.
const clean = results.filter((r) => r.verdict === "RESOLVES");
const byChannel = new Map<string, Row>();
for (const { row } of clean) {
  const held = byChannel.get(row.discord_channel_id);
  if (!held || row.created_at > held.created_at) byChannel.set(row.discord_channel_id, row);
}

console.log(`\n=== summary ===`);
const tally = new Map<string, number>();
for (const { verdict } of results) {
  const key = verdict.split(" (")[0];
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
for (const [verdict, count] of tally) console.log(`${verdict}: ${count}`);
console.log(`recoverable (deduped by discord channel): ${byChannel.size}`);
console.log(`\n=== RECOVERABLE_IDS ===`);
console.log([...byChannel.values()].map((r) => r.bridge_id).join("\n"));

await sql.end();
process.exit(0);
