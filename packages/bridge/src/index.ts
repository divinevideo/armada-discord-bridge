/**
 * Bridge service entry point: env-provisioned single-link MVP.
 *
 * Required env beyond config.ts: BRIDGE_INVITE_URL, DISCORD_TOKEN,
 * DISCORD_GUILD_ID, DISCORD_CHANNEL_ID; optional CONCORD_CHANNEL_ID
 * (defaults to the first channel in the control fold).
 *
 * Keys are re-resolved from the invite on every boot (the bundle lives on
 * relays); sealed at-rest key storage arrives with the portal control plane.
 */

import {
  STOCK_RELAYS,
  Permissions,
  inviteDeliveryRelays,
  isAuthorized,
  parseInviteLink,
} from "@armada-bridge/concord-core";
import type { OpenedChat } from "@armada-bridge/concord-core";
import { randomUUID } from "node:crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decode as nip19decode } from "nostr-tools/nip19";
import postgres from "postgres";

import { PublicCapacityGuard } from "../../moderation/src/publicCapacity";
import { CONCORD_EFFECT_METHODS, guardEffects } from "./effectGuard";
import { BridgeLeases, bridgeResource } from "./db/leases";
import { discordPublicChannelPolicy } from "./discord/publicChannelPolicy";
import { BlossomStore } from "./blossom";
import { KlipyClient } from "./klipy";
import { Shutdown } from "./shutdown";
import { LinkDelivery } from "./concord/linkDelivery";
import { ActionableDeletionCapacityError, PromotionDeletionIntakeError } from "./deletionPolicy";
import { startConcordDelivery } from "./concord/startup";
import { deliverConcordChat, observeDeletionEffects } from "./concord/delivery";
import { ConcordClient, resolveInvite } from "./concord/client";
import { intakeDirectInviteKeys } from "./concord/keyIntake";
import { identityRelayPool } from "./concord/identityPool";
import { RelayPool } from "./concord/pool";
import { localIdentity } from "./concord/signer";
import { loadConfig } from "./config";
import { migrate } from "./db/migrate";
import { PostgresMappingStore, provisionStandalone, standaloneDeliveryOwner } from "./db/store";
import { DiscordAdapter } from "./discord/adapter";
import { Kind0ProfileResolver } from "./profiles";
import { PuppetCache } from "./puppets";
import { DELETION_RETRY_MS, BridgeRouter } from "./router";
import type { ChannelLink } from "./router";

function primarySk(value: string): Uint8Array {
  if (value.startsWith("nsec1")) {
    const decoded = nip19decode(value);
    if (decoded.type !== "nsec") throw new Error("BRIDGE_PRIMARY_KEY: not an nsec");
    return decoded.data;
  }
  return hexToBytes(value);
}

// Install signal handling before migration or any resource acquisition.
const shutdownState = new Shutdown(5_000);
let exitCode = 0;
async function shutdown(code = 0): Promise<void> {
  exitCode = Math.max(exitCode, code);
  await shutdownState.begin();
  process.exit(exitCode);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function main(): Promise<void> {
const config = loadConfig();
const applied = await migrate(config.databaseUrl);
shutdownState.signal.throwIfAborted();
if (applied.length) console.log(`bridge: migrations applied: ${applied.join(", ")}`);

const inviteUrl = process.env.BRIDGE_INVITE_URL?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();
const channelId = process.env.DISCORD_CHANNEL_ID?.trim();
if (!inviteUrl || !guildId || !channelId || !config.discordToken) {
  console.log("bridge: config OK; set BRIDGE_INVITE_URL, DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID to go live");
  return;
}

const publicPolicy = config.mode === "public" ? discordPublicChannelPolicy(config.publicChannels!, config.discordToken) : undefined;
await publicPolicy?.assertPublicChannel(guildId, channelId);
shutdownState.signal.throwIfAborted();
const sql = postgres(config.databaseUrl, { onnotice: () => {}, connect_timeout: 5, connection: { statement_timeout: 15_000, lock_timeout: 5_000 } });
shutdownState.register(() => sql.end({ timeout: 2 }));
const capacity = new PublicCapacityGuard(sql);
const lease = await new BridgeLeases(sql).acquire(bridgeResource(guildId, channelId), () => {
  console.error("bridge: terminal lease loss; restart required");
  void shutdown(1);
});
if (!lease) throw new Error("Bridge lease is owned by another worker");
shutdownState.register(() => lease.release());
shutdownState.signal.throwIfAborted();
let deliveryStore: PostgresMappingStore | undefined;
const assertMayForward = async () => {
  shutdownState.signal.throwIfAborted();
  await lease.assertCurrent();
  if (!deliveryStore) throw new Error("Delivery lifecycle is not ready");
  await deliveryStore.assertDeliveryCurrent();
  await publicPolicy?.assertPublicChannel(guildId, channelId);
  const current = rawClient.channel(concordChannelId!);
  if (!current || (config.mode === "public" && current.isPrivate)) throw new Error("Concord channel must be public");
  if (config.mode === "public") await capacity.assertPublicProducer(community.idHex);
  await lease.assertCurrent();
  await deliveryStore.assertDeliveryCurrent();
  shutdownState.signal.throwIfAborted();
};

// ── Concord side ─────────────────────────────────────────────────────────────
const invite = parseInviteLink(inviteUrl);
if (!invite) throw new Error("BRIDGE_INVITE_URL is not a valid Armada invite");
const bootstrap = new RelayPool(invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS);
shutdownState.register(() => bootstrap.close());
const { community } = await resolveInvite(inviteUrl, bootstrap);
await bootstrap.close();
shutdownState.signal.throwIfAborted();
console.log(`bridge: joined material for community ${community.name} (${community.idHex})`);

const primaryKey = primarySk(config.primarySecretKey);
const primary = localIdentity(primaryKey);
const pool = identityRelayPool(community.relays, primaryKey);
shutdownState.register(() => pool.close());

// Fold the Control Plane FIRST. It reads from the community root the invite
// already carried, so it needs no private-channel key — which means the
// roster, and therefore who is entitled to vend a channel key, is knowable
// before we accept any. The intake below refuses bundles from anyone else.
const preflight = await ConcordClient.discover(community, pool, primary, { signal: shutdownState.signal });
const folded = preflight.folded!;
shutdownState.signal.throwIfAborted();
let rawClient = preflight;
if (config.mode !== "public") {

  // Private-channel keys addressed to us since the last boot. The join bundle
  // only ever carried what the inviter vended at the time, so a channel we were
  // granted afterwards is readable only once its Direct Invite is opened — and
  // this has to run BEFORE the client that serves `channels()` is built, or the
  // grant is invisible until the next restart. The stock floor is scanned
  // alongside the community relays because that is where a sender delivers to an
  // npub with no published inbox (which we were, until the 10050 below).
  const floor = identityRelayPool(inviteDeliveryRelays([]), primaryKey);
  shutdownState.register(() => floor.close());
  const intake = await intakeDirectInviteKeys([pool, floor], primary, community, {
    isAuthorizedSender: (pk) =>
      isAuthorized(folded.roster, pk, community.owner, Permissions.MANAGE_CHANNELS),
  }).finally(() => void floor.close());
  shutdownState.signal.throwIfAborted();
  if (intake.learned.length > 0) {
    console.log(`bridge: learned ${intake.learned.length} private-channel key(s) from direct invites`);
  }

  // Re-fold only when the intake actually changed the key set; otherwise the
  // preflight client already holds the answer.
  rawClient = intake.learned.length > 0 ? await ConcordClient.discover(intake.community, pool, primary, { signal: shutdownState.signal }) : preflight;
  shutdownState.signal.throwIfAborted();
}
const client = guardEffects(rawClient, assertMayForward, CONCORD_EFFECT_METHODS);

const concordChannelId =
  process.env.CONCORD_CHANNEL_ID?.trim() || client.channels()[0]?.idHex;
const channel = concordChannelId ? client.channel(concordChannelId) : undefined;
if (!channel) throw new Error(`concord channel not found (have: ${client.channels().map((c) => c.idHex).join(", ")})`);
if (config.mode === "public" && channel.isPrivate) throw new Error("Concord channel must be public");
console.log(`bridge: target channel #${channel.name}`);

// ── Storage, Discord, router ────────────────────────────────────────────────
const store = new PostgresMappingStore(sql);

const link: ChannelLink = {
  discordGuildId: guildId,
  discordChannelId: channelId,
  communityId: community.idHex,
  concordChannelIdHex: channel.idHex,
  enabled: true,
};
await provisionStandalone(sql, link, { idHex: community.idHex, relays: community.relays, name: community.name }, channel.streams.map(s => s.group.pk), Math.floor(Date.now() / 1000));
shutdownState.signal.throwIfAborted();
const sessionId = randomUUID();
const openedDelivery = await store.openDelivery(link, standaloneDeliveryOwner(link), lease, channel.streams.map(s => s.group.pk), Math.floor(Date.now() / 1000), sessionId, pool.urls);
deliveryStore = openedDelivery.store;
shutdownState.signal.throwIfAborted();
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
shutdownState.signal.throwIfAborted();



const puppets = new PuppetCache(config.masterSecretHex);
const profiles = new Kind0ProfileResolver(pool);

const lane = new LinkDelivery({
  deletionFloor: openedDelivery.snapshot.deletionFloor,
  onError: error => console.warn("bridge: delivery operation failed", error),
  onGap: floor => deliveryStore!.markDeliveryGap(floor),
});
shutdownState.register(() => lane.stop());
shutdownState.signal.addEventListener("abort", () => lane.stop(), { once: true });
let router: BridgeRouter;
const runDiscord = (work: () => Promise<unknown>): Promise<void> => {
  const admitted = lane.admit(Math.floor(Date.now() / 1000), async signal => {
    signal.throwIfAborted();
    try { await work(); }
    catch (error) {
      if (error instanceof ActionableDeletionCapacityError || error instanceof PromotionDeletionIntakeError) lane.markGap(error.repairFloor);
      throw error;
    }
  });
  return admitted ?? Promise.resolve();
};
const adapter = new DiscordAdapter(config.discordToken, {
  async onMessage(msg) {
    if (msg.channelId !== link.discordChannelId) return;
    await runDiscord(() => router.onDiscordMessage(msg, link));
  },
  async onMessageUpdate(msg) {
    if (msg.channelId !== link.discordChannelId) return;
    await runDiscord(() => router.onDiscordEdit(msg, link));
  },
  async onMessageDelete(del) {
    if (del.channelId !== link.discordChannelId) return;
    await runDiscord(() => router.onDiscordDelete(del, link));
  },
  async onReactionAdd(reaction) {
    if (reaction.channelId !== link.discordChannelId) return;
    await runDiscord(() => router.onDiscordReaction(reaction, link));
  },
  async onReactionRemove(reaction) {
    if (reaction.channelId !== link.discordChannelId) return;
    await runDiscord(() => router.onDiscordReactionRemove(reaction, link));
  },
  async onTyping(typing) {
    if (typing.bot || typing.channelId !== link.discordChannelId) return;
    lane.typing(async signal => { signal.throwIfAborted(); await router.onDiscordTyping(typing.userId, link); });
  },
}, async (id) => {
  if (id !== channelId) throw new Error("Channel not configured");
  await assertMayForward();
});
shutdownState.register(() => adapter.stop());
const self = { applicationId: "", webhookIds: adapter.ownWebhookIds };
router = new BridgeRouter(
  client,
  puppets,
  deliveryStore,
  observeDeletionEffects(adapter, observation => console.warn(`bridge: Discord ${observation.operation} needs ${observation.permission}`)),
  profiles,
  self,
  {
    beforeSideEffect: assertMayForward,
    bridgeEdits: config.bridgeEdits,
    blobs: config.blossomServer ? new BlossomStore(config.blossomServer) : undefined,
    klipy: config.klipyApiKey ? new KlipyClient(config.klipyApiKey) : undefined,
  },
);
await adapter.start();
shutdownState.signal.throwIfAborted();
self.applicationId = adapter.applicationId;
console.log("bridge: discord gateway up");

let currentChannel = channel;
const retryDeletes = (wake = false) => lane.requestRetry(wake, async (shouldWake, signal) => {
  signal.throwIfAborted();
  try { await router.retryPendingDeletes(link, shouldWake); }
  catch (error) {
    if (error instanceof ActionableDeletionCapacityError || error instanceof PromotionDeletionIntakeError) lane.markGap(error.repairFloor);
    throw error;
  }
}).catch(error => console.error("bridge: pending deletion retry failed", error));
const onChat = (chat: OpenedChat) => deliverConcordChat(router, chat, link, error =>
  console.warn(`bridge: ordinary Concord mirror ${chat.rumorId} failed`, error));
const onSubError = (relayUrl: string, error: unknown): void => {
  lane.subscriptionError(relayUrl);
  console.error(`bridge: chat subscription ${relayUrl}:`, error);
};
let unsubscribe = () => {};
const refreshChannel = () => {
  const fresh = client.channel(link.concordChannelIdHex);
  if (!fresh) throw new Error('Concord channel is no longer readable');
  const changed = fresh.streams.map(s => s.group.pk).join(',') !== currentChannel.streams.map(s => s.group.pk).join(',');
  if (changed) { lane.markGap(openedDelivery.snapshot.recoveryFloor); unsubscribe(); }
  currentChannel = fresh;
  if (changed) unsubscribe = client.subscribeChannel(fresh, onChat, onSubError, undefined, { lane, currentChannel: () => currentChannel });
};
const retryCatchup = () => client.repairDelivery(lane, {
  store: deliveryStore!, channel: () => currentChannel, relays: () => pool.urls,
  refresh: refreshChannel,
  deliver: async (chat, signal) => { signal.throwIfAborted(); await onChat(chat); },
}).catch(error => {
  if (!shutdownState.signal.aborted) console.warn("bridge: catch-up incomplete; retry is scheduled", error);
});
await startConcordDelivery({
  establishFloor: async () => { await deliveryStore!.assertDeliveryCurrent(); },
  installLive: () => {
    unsubscribe = client.subscribeChannel(currentChannel, onChat, onSubError, undefined, { lane, currentChannel: () => currentChannel });
    shutdownState.register(() => unsubscribe());
  },
  installControl: () => {
    const unsubControl = client.subscribeControl(() => {
      void retryDeletes(true);
      refreshChannel();
      void retryCatchup();
    }, onSubError);
    shutdownState.register(() => unsubControl());
  },
  catchUp: retryCatchup,
});
const deletionRetryTimer = setInterval(() => { void retryDeletes(); void retryCatchup(); }, DELETION_RETRY_MS);
shutdownState.register(() => clearInterval(deletionRetryTimer));
shutdownState.signal.throwIfAborted();
console.log("bridge: live in both directions");
}

void main().catch(error => {
  if (!shutdownState.signal.aborted) {
    console.error("bridge: startup failed", error);
    void shutdown(1);
  }
}).finally(() => shutdownState.finishStartup());
