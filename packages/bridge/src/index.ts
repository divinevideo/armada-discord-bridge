/**
 * Bridge service entry point: env-provisioned single-link MVP
 * (armada-discord-bridge-PLAN.md section 7).
 *
 * Required env beyond config.ts: BRIDGE_INVITE_URL, DISCORD_TOKEN,
 * DISCORD_GUILD_ID, DISCORD_CHANNEL_ID; optional CONCORD_CHANNEL_ID
 * (defaults to the first channel in the control fold).
 *
 * Keys are re-resolved from the invite on every boot (the bundle lives on
 * relays); sealed at-rest key storage arrives with the portal control plane.
 */

import { STOCK_RELAYS, inviteDeliveryRelays, parseInviteLink } from "@armada-bridge/concord-core";
import type { OpenedChat } from "@armada-bridge/concord-core";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decode as nip19decode } from "nostr-tools/nip19";
import postgres from "postgres";

import { BlossomStore } from "./blossom";
import { ConcordClient, resolveInvite } from "./concord/client";
import { intakeDirectInviteKeys } from "./concord/keyIntake";
import { RelayPool } from "./concord/pool";
import { localIdentity } from "./concord/signer";
import { loadConfig } from "./config";
import { migrate } from "./db/migrate";
import { PostgresMappingStore, ensureLink } from "./db/store";
import { DiscordAdapter } from "./discord/adapter";
import { Kind0ProfileResolver } from "./profiles";
import { PuppetCache } from "./puppets";
import { BridgeRouter } from "./router";
import type { ChannelLink } from "./router";

function primarySk(value: string): Uint8Array {
  if (value.startsWith("nsec1")) {
    const decoded = nip19decode(value);
    if (decoded.type !== "nsec") throw new Error("BRIDGE_PRIMARY_KEY: not an nsec");
    return decoded.data;
  }
  return hexToBytes(value);
}

const config = loadConfig();
const applied = await migrate(config.databaseUrl);
if (applied.length) console.log(`bridge: migrations applied: ${applied.join(", ")}`);

const inviteUrl = process.env.BRIDGE_INVITE_URL?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();
const channelId = process.env.DISCORD_CHANNEL_ID?.trim();
if (!inviteUrl || !guildId || !channelId || !config.discordToken) {
  console.log("bridge: config OK; set BRIDGE_INVITE_URL, DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID to go live");
  process.exit(0);
}

// ── Concord side ─────────────────────────────────────────────────────────────
const invite = parseInviteLink(inviteUrl);
if (!invite) throw new Error("BRIDGE_INVITE_URL is not a valid Armada invite");
const bootstrap = new RelayPool(invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS);
const { community } = await resolveInvite(inviteUrl, bootstrap);
await bootstrap.close();
console.log(`bridge: joined material for community ${community.name} (${community.idHex.slice(0, 8)}…)`);

const pool = new RelayPool(community.relays);
const primary = localIdentity(primarySk(config.primarySecretKey));

// Private-channel keys addressed to us since the last boot. The join bundle
// only ever carried what the inviter vended at the time, so a channel we were
// granted afterwards is readable only once its Direct Invite is opened — and
// this has to run BEFORE the client folds, or the grant is invisible until the
// next restart. The stock floor is scanned alongside the community relays
// because that is where a sender delivers to an npub with no published inbox
// (which we were, until the 10050 below).
const floor = new RelayPool(inviteDeliveryRelays([]));
const intake = await intakeDirectInviteKeys([pool, floor], primary, community).finally(
  () => void floor.close(),
);
if (intake.learned.length > 0) {
  console.log(`bridge: learned ${intake.learned.length} private-channel key(s) from direct invites`);
}

const client = new ConcordClient(intake.community, pool, primary);
await client.syncControl();

const concordChannelId =
  process.env.CONCORD_CHANNEL_ID?.trim() || client.channels()[0]?.idHex;
const channel = concordChannelId ? client.channel(concordChannelId) : undefined;
if (!channel) throw new Error(`concord channel not found (have: ${client.channels().map((c) => c.idHex.slice(0, 8)).join(", ")})`);
console.log(`bridge: target channel #${channel.name}`);

await client.publishJoin().catch((error) => console.warn("bridge: guestbook join failed", error));
await client
  .publishProfile(primary, {
    name: "Discord <-> Armada Bridge Bot",
    about: "Automated bridge account: mirrors this channel with a Discord server.",
    bot: true,
  })
  .catch((error) => console.warn("bridge: profile publish failed", error));
// Point our giftwrap inbox at the community relays (NIP-17 kind 10050), the
// list Armada resolves before sending a Direct Invite. Without it every key
// handoff goes to the stock interop floor and stays there.
await client
  .publishDmRelays(primary, community.relays)
  .catch((error) => console.warn("bridge: DM relay list publish failed", error));

// ── Storage, Discord, router ────────────────────────────────────────────────
const sql = postgres(config.databaseUrl, { onnotice: () => {} });
const store = new PostgresMappingStore(sql);

const link: ChannelLink = {
  discordGuildId: guildId,
  discordChannelId: channelId,
  communityId: community.idHex,
  concordChannelIdHex: channel.idHex,
  enabled: true,
};
await ensureLink(sql, link, { idHex: community.idHex, relays: community.relays, name: community.name });

const puppets = new PuppetCache(config.masterSecretHex);
const profiles = new Kind0ProfileResolver(pool);

let router: BridgeRouter;
const adapter = new DiscordAdapter(config.discordToken, {
  async onMessage(msg) {
    if (msg.channelId !== link.discordChannelId) return;
    await router.onDiscordMessage(msg, link);
  },
  async onMessageUpdate(msg) {
    if (msg.channelId !== link.discordChannelId) return;
    await router.onDiscordEdit(msg, link);
  },
  async onMessageDelete(del) {
    if (del.channelId !== link.discordChannelId) return;
    await router.onDiscordDelete(del, link);
  },
  async onReactionAdd(reaction) {
    if (reaction.channelId !== link.discordChannelId) return;
    await router.onDiscordReaction(reaction, link);
  },
  async onReactionRemove(reaction) {
    if (reaction.channelId !== link.discordChannelId) return;
    await router.onDiscordReactionRemove(reaction, link);
  },
  async onTyping(typing) {
    if (typing.bot || typing.channelId !== link.discordChannelId) return;
    await router.onDiscordTyping(typing.userId, link);
  },
});
await adapter.start();
router = new BridgeRouter(
  client,
  puppets,
  store,
  adapter,
  profiles,
  { applicationId: adapter.applicationId, webhookIds: adapter.ownWebhookIds },
  {
    bridgeEdits: config.bridgeEdits,
    blobs: config.blossomServer ? new BlossomStore(config.blossomServer) : undefined,
  },
);
console.log("bridge: discord gateway up");

const onChat = (chat: OpenedChat): void => {
  void router.onConcordChat(chat, link).catch((error) => console.error("bridge: concord->discord failed", error));
};
const onSubError = (relayUrl: string, error: unknown): void =>
  console.error(`bridge: chat subscription ${relayUrl}:`, error);
const onCursor = (streamPk: string, wrapAt: number): void => {
  void store.cursorSet(community.idHex, streamPk, wrapAt).catch(() => {});
};
let currentChannel = channel;

// Bounded catch-up for messages missed while down (no cursor = fresh link,
// live-only on purpose). The mapping table dedupes anything already mirrored.
{
  const streamPks = channel.streams.map((s) => s.group.pk);
  const cursor = await store.cursorGet(community.idHex, streamPks);
  if (cursor !== undefined) {
    const { chats, newestWrapAt } = await client.backfillChannel(channel, cursor - 60);
    for (const chat of chats) {
      await router.onConcordChat(chat, link).catch((error) =>
        console.warn(`bridge: backfill mirror failed for ${chat.rumorId}:`, error),
      );
    }
    if (newestWrapAt !== undefined) {
      for (const pk of streamPks) await store.cursorSet(community.idHex, pk, newestWrapAt).catch(() => {});
    }
    if (chats.length > 0) console.log(`bridge: backfilled ${chats.length} wraps missed while down`);
  }
}

let unsubscribe = client.subscribeChannel(currentChannel, onChat, onSubError, onCursor);
// A rekey (epoch bump) mints new stream keys; a REQ pinned to the old ones
// goes silent while publishes (fresh channel lookup) keep working.
const unsubControl = client.subscribeControl(() => {
  const fresh = client.channel(link.concordChannelIdHex);
  if (!fresh) return;
  const keys = (c: typeof channel) => c.streams.map((s) => s.group.pk).join(",");
  if (keys(fresh) === keys(currentChannel)) return;
  unsubscribe();
  currentChannel = fresh;
  unsubscribe = client.subscribeChannel(fresh, onChat, onSubError, onCursor);
  console.log("bridge: stream keys rotated; chat subscription refreshed");
});
console.log("bridge: live in both directions");

async function shutdown(): Promise<void> {
  console.log("bridge: shutting down");
  unsubscribe();
  unsubControl();
  await adapter.stop().catch(() => {});
  await pool.close().catch(() => {});
  await sql.end().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
