/**
 * Diagnostic probe: resolve a bridge's community fresh from its sealed
 * invite, fold the control plane, list the channels it can see, then read the
 * bridged channel's stream from each relay SEPARATELY.
 *
 * That last part is the point. The pool merges relays, so a relay that has
 * stopped delivering — or was never authenticated — looks identical to one
 * that is keeping up. Querying them one at a time is what makes a per-relay
 * delivery gap visible.
 *
 *   PORTAL_SEAL_KEY=... DATABASE_URL=... \
 *     bun run scripts/probe-channel.ts <bridge-id-prefix>
 */

import postgres from "postgres";
import { generateSecretKey } from "nostr-tools/pure";

import { ConcordClient, resolveInvite } from "../packages/bridge/src/concord/client";
import { RelayPool } from "../packages/bridge/src/concord/pool";
import { localIdentity } from "../packages/bridge/src/concord/signer";
import { unseal } from "../packages/portal/src/seal";
import { KIND_WRAP, STOCK_RELAYS, parseInviteLink } from "@armada-bridge/concord-core";

const prefix = process.argv[2];
if (!prefix) throw new Error("usage: bun run scripts/probe-channel.ts <bridge-id-prefix>");
const sealKey = process.env.PORTAL_SEAL_KEY;
if (!sealKey) throw new Error("PORTAL_SEAL_KEY not set");
const sql = postgres(process.env.DATABASE_URL ?? "postgres://bridge:bridge@localhost:5432/bridge", {
  onnotice: () => {},
});

const [row] = await sql`
  SELECT bridge_id, invite_url_sealed, concord_channel_id, status
  FROM bridges WHERE bridge_id::text LIKE ${prefix + "%"}`;
if (!row) throw new Error(`no bridge matching ${prefix}`);
console.log(`bridge ${row.bridge_id} status=${row.status} concord_channel=${row.concord_channel_id}`);

const inviteUrl = unseal(sealKey, row.invite_url_sealed);
const invite = parseInviteLink(inviteUrl);
const bootstrap = new RelayPool(invite?.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS);
const { community } = await resolveInvite(inviteUrl, bootstrap).finally(() => void bootstrap.close());
console.log(`community ${community.name} rootEpoch=${community.rootEpoch} heldRoots=${community.heldRoots.length} relays=${community.relays.join(" ")}`);

const pool = new RelayPool(community.relays);
const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
await client.syncControl();

for (const ch of client.channels()) {
  const marker = ch.idHex === row.concord_channel_id ? "  <-- bridged" : "";
  console.log(`channel ${ch.idHex.slice(0, 12)}… "${ch.name}" epoch=${ch.current.epoch} streams=${ch.streams.length}${marker}`);
}

const channel = client.channel(row.concord_channel_id);
if (!channel) {
  console.log("BRIDGED CHANNEL NOT IN FOLD (deleted or key not held)");
} else {
  const authors = channel.streams.map((s) => s.group.pk);
  console.log(`channel "${channel.name}" stream pks: ${authors.map((a) => a.slice(0, 8)).join(",")}`);
  // Query each relay separately: a per-relay delivery gap is invisible in
  // the merged pool view.
  const { openChatBatch } = await import("../packages/concord-core/src/chat");
  for (const url of community.relays) {
    const solo = new RelayPool([url]);
    try {
      const wraps = await solo.query([{ kinds: [KIND_WRAP], authors }]);
      const chats = await openChatBatch(wraps, channel);
      console.log(`${url}: ${wraps.length} wraps, ${chats.length} decode`);
      const newest = [...chats].sort((a, b) => b.ms - a.ms);
      for (const chat of newest.slice(0, 8)) {
        const when = new Date(chat.ms).toISOString();
        console.log(`  kind=${chat.kind} at=${when} author=${chat.author.slice(0, 8)}… ${JSON.stringify(chat.content.slice(0, 50))}`);
      }
    } catch (error) {
      console.log(`${url}: QUERY FAILED ${String(error)}`);
    } finally {
      await solo.close();
    }
  }
}

await pool.close();
await sql.end();
process.exit(0);
