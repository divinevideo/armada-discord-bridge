/**
 * Read-only: how much history would resuming these bridges replay into
 * Discord? backfillMissed() mirrors every wrap newer than the stored cursor,
 * and these cursors stopped on 2026-08-10, so the answer decides whether a
 * resume is quiet or dumps nine days of backlog into someone's channel.
 *
 *   PORTAL_SEAL_KEY=... DATABASE_URL=... bun run scripts/probe-backlog.ts <id> [id...]
 */

import postgres from "postgres";
import { generateSecretKey } from "nostr-tools/pure";

import { ConcordClient, resolveInvite } from "../packages/bridge/src/concord/client";
import { RelayPool } from "../packages/bridge/src/concord/pool";
import { localIdentity } from "../packages/bridge/src/concord/signer";
import { PostgresMappingStore } from "../packages/bridge/src/db/store";
import { unseal } from "../packages/portal/src/seal";
import { STOCK_RELAYS, parseInviteLink } from "@armada-bridge/concord-core";

const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error("usage: probe-backlog.ts <bridge-id> [...]");
const sealKey = process.env.PORTAL_SEAL_KEY;
if (!sealKey) throw new Error("PORTAL_SEAL_KEY not set");
const sql = postgres(process.env.DATABASE_URL ?? "", { onnotice: () => {} });
const store = new PostgresMappingStore(sql);

interface Row {
  bridge_id: string;
  invite_url_sealed: Uint8Array;
  concord_channel_id: string;
  discord_guild_name: string | null;
  discord_channel_name: string | null;
}

const rows = await sql<Row[]>`
  SELECT bridge_id, invite_url_sealed, concord_channel_id, discord_guild_name, discord_channel_name
  FROM bridges WHERE bridge_id::text = ANY(${ids})`;

let total = 0;
const queue = [...rows];
const lines: string[] = [];

async function worker(): Promise<void> {
  for (let row = queue.shift(); row; row = queue.shift()) {
    const inviteUrl = unseal(sealKey!, row.invite_url_sealed);
    const invite = parseInviteLink(inviteUrl)!;
    const bootstrap = new RelayPool(
      invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS,
    );
    let community;
    try {
      ({ community } = await resolveInvite(inviteUrl, bootstrap));
    } catch {
      continue;
    } finally {
      await bootstrap.close().catch(() => {});
    }
    const pool = new RelayPool(community.relays);
    try {
      const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
      await client.syncControl();
      const channel = client.channel(row.concord_channel_id);
      if (!channel) continue;
      const streamPks = channel.streams.map((s) => s.group.pk);
      const cursor = await store.cursorGet(community.idHex, streamPks);
      if (cursor === undefined) {
        lines.push(`  0  ${row.discord_guild_name} / #${row.discord_channel_name}  (no cursor: live-only)`);
        continue;
      }
      const { chats } = await client.backfillChannel(channel, cursor - 60);
      total += chats.length;
      lines.push(
        `${String(chats.length).padStart(3)}  ${row.discord_guild_name} / #${row.discord_channel_name}` +
          `  (cursor ${new Date(cursor).toISOString().slice(0, 16)})`,
      );
    } catch (error) {
      lines.push(`  ?  ${row.discord_guild_name} / #${row.discord_channel_name}  FAILED ${String(error).slice(0, 50)}`);
    } finally {
      await pool.close().catch(() => {});
    }
  }
}
await Promise.all(Array.from({ length: Math.min(8, queue.length) }, () => worker()));

lines.sort((a, b) => parseInt(b) - parseInt(a));
for (const line of lines) console.log(line);
console.log(`\nTOTAL messages that would replay into Discord: ${total}`);

await sql.end();
process.exit(0);
