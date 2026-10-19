/**
 * BridgeManager: the portal's data plane. Owns one Discord gateway (one bot
 * application serves every bridge) and, per bridge, a headless Concord
 * client. Drives the lifecycle: draft -> pending_confirm (in-channel code)
 * -> active (routing attached) -> paused/severed/unlinked.
 *
 * `severed` is the community cutting the bridge off — banned by the control
 * plane, refounded past its keys, or dissolved — detected live (see
 * ./severance.ts) and recorded like any operator stop. `paused`/`unlinked`
 * remain operator actions only.
 *
 * The in-channel confirm is the Armada side's consent gate: only a member
 * holding MANAGE_CHANNELS (or the owner) can flip a bridge live, and the
 * portal cannot bypass it.
 */

import { BridgeLeases, BridgeLeaseUnavailableError, bridgeResource, type BridgeLease } from "@armada-bridge/bridge/src/db/leases";
import { CONCORD_EFFECT_METHODS, guardEffects } from "@armada-bridge/bridge/src/effectGuard";
import { discordPublicChannelPolicy, type PublicChannelPolicy } from "@armada-bridge/bridge/src/discord/publicChannelPolicy";
import { randomBytes } from "node:crypto";
import {
  KIND_WRAP,
  Permissions,
  STOCK_RELAYS,
  inviteDeliveryRelays,
  isAuthorized,
  parseInviteLink,
} from "@armada-bridge/concord-core";
import type { ChannelV2, CommunityV2, FoldedControl, OpenedChat } from "@armada-bridge/concord-core";
import { BlossomStore } from "@armada-bridge/bridge/src/blossom";
import { KlipyClient } from "@armada-bridge/bridge/src/klipy";
import { ConcordClient, resolveInvite, severanceStreamKeys } from "@armada-bridge/bridge/src/concord/client";
import { identityRelayPool } from "@armada-bridge/bridge/src/concord/identityPool";
import { intakeDirectInviteKeys } from "@armada-bridge/bridge/src/concord/keyIntake";
import { RelayPool } from "@armada-bridge/bridge/src/concord/pool";
import { localIdentity } from "@armada-bridge/bridge/src/concord/signer";
import { PostgresMappingStore } from "@armada-bridge/bridge/src/db/store";
import { DiscordAdapter, isMissingPermissions, parseBotCommand } from "@armada-bridge/bridge/src/discord/adapter";
import { Kind0ProfileResolver } from "@armada-bridge/bridge/src/profiles";
import { PuppetCache } from "@armada-bridge/bridge/src/puppets";
import { BridgeRouter } from "@armada-bridge/bridge/src/router";
import type { ChannelLink, DiscordInboundMessage } from "@armada-bridge/bridge/src/router";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateSecretKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import type postgres from "postgres";

import { replayDiscordSince } from "./catchup";
import { botChannelMessagesAfter, restToInbound } from "./discordRest";
import type { PortalEnv } from "./env";
import { filterPublicRelays } from "./relayGuard";
import { seal, unseal } from "./seal";
import { detectSeverance, severanceDetail, type SeveranceVerdict } from "./severance";

export interface BridgeRow {
  bridge_id: string;
  owner_discord_id: string;
  status: string;
  status_detail: string | null;
  invite_url_sealed: Uint8Array | null;
  master_secret_sealed: Uint8Array | null;
  primary_sk_sealed: Uint8Array | null;
  primary_pk: string | null;
  community_id: string | null;
  community_name: string | null;
  discord_guild_id: string | null;
  discord_channel_id: string | null;
  concord_channel_id: string | null;
  confirm_code: string | null;
  options: Record<string, unknown> | null;
  announced_at: string | null;
  perm_alerted_at: string | null;
  /** Postgres hands timestampz back as a Date; accepted as either. */
  created_at: Date | string;
}

interface Running {
  lease: BridgeLease;
  assertMayForward: () => Promise<void>;
  id: string;
  client: ConcordClient;
  pool: RelayPool;
  channel: ChannelV2;
  link: ChannelLink;
  primary: ReturnType<typeof localIdentity>;
  router?: BridgeRouter;
  status: "pending_confirm" | "active";
  unsubChat: () => void;
  unsubControl: () => void;
  /** The dissolved-plane + base-rekey standing REQ (severance watchers). */
  unsubSeverance: () => void;
}

export const CONFIRM_RE = /^\/bridge confirm ([0-9a-f]{8})$/i;

/**
 * How long a bridge may keep failing to start before the failure is
 * committed as a sever. Relays give no tombstones: an empty query for the
 * invite bundle can mean the community was dissolved, or it can mean no
 * relay happened to answer inside one boot's window — the two are
 * indistinguishable from a single attempt. Only failure sustained across
 * retries for this long is treated as the community actually being gone.
 */
export const START_FAILURE_SEVER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const START_RETRY_BASE_MS = 5 * 60 * 1000;
const START_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Backoff for reconnecting the shared Discord gateway after its login throws.
 * Short, because the gateway being down blocks every active bridge, so the
 * cost of waiting is paid by all of them at once.
 */
const GATEWAY_RETRY_BASE_MS = 10 * 1000;
const GATEWAY_RETRY_MAX_MS = 10 * 60 * 1000;

/**
 * Raised when an active bridge is asked to start while the shared Discord
 * gateway is down. It is deliberately its OWN error type, not a start failure:
 * the gateway being unreachable is a process-wide, transient condition that
 * says NOTHING about the community, so it must never advance the seven-day
 * sever streak or reach markSevered. Treating it as a start failure once
 * severed every active bridge on a boot that raced a Discord API blip
 * (2026-08-27, ~378 bridges). Bridges that throw this defer and retry; the
 * gateway heals via connectAdapter() and onAdapterConnected() brings them up.
 */
class GatewayUnavailableError extends Error {
  constructor() {
    super("Discord gateway not connected; deferring bridge start");
    this.name = "GatewayUnavailableError";
  }
}

/**
 * Raised when severance detection cuts a bridge off DURING its own start (the
 * boot probe found the ban / Refounding / tombstone). Its own error type for
 * the mirror-image reason as GatewayUnavailableError: this one is about the
 * COMMUNITY and must never be retried or counted as a start failure — the
 * detection path has already written 'severed' with the real reason, and a
 * seven-day failure streak would overwrite that detail and fight the record.
 */
class SeveredError extends Error {
  constructor(readonly verdict: SeveranceVerdict) {
    super(severanceDetail(verdict));
    this.name = "SeveredError";
  }
}

/** How many bridges may be starting at once during boot; see startAll(). */
const START_CONCURRENCY = 12;

/**
 * Most Discord messages one start-time catch-up will read per channel (see
 * catchUpDiscord). Bounds an old anchor — a bridge that was down for weeks —
 * to a burst the channel can absorb.
 */
const DISCORD_CATCHUP_MAX = 500;

/**
 * How many severance-plane wraps one live bridge accumulates before the oldest
 * are evicted. A Refounding is a handful of chunks and a dissolution is one
 * event, so this is many multiples of any honest need; under a flood the
 * eviction drops chunks, and a rotation missing a chunk reads as no verdict —
 * a missed severance heals at the next boot probe, a false one would not.
 */
const SEVERANCE_WRAP_CAP = 256;

/** The kind 10304 command manifest every bridge primary advertises. */
export const BRIDGE_COMMANDS = [
  {
    name: "bridge",
    description: "Manage this channel's Discord bridge. /bridge confirm <code> approves a pending link.",
    args: [
      { name: "action", type: "choice", description: "What to do", required: true, choices: ["confirm"] },
      { name: "code", type: "string", description: "The 8-character confirm code", required: true },
    ],
  },
  {
    name: "help",
    description: "What this bridge bot does and which commands it answers.",
  },
];

class PublicPolicyUnavailableError extends Error {}

export class BridgeManager {
  private adapter?: DiscordAdapter;
  private readonly running = new Map<string, Running>();
  private readonly byDiscordChannel = new Map<string, string>();
  /** One shared store: mapping rows for every router, plus catch-up cursors. */
  private readonly store: PostgresMappingStore;
  /** Pending start-retry timers by bridge id; cancelled by stop(). */
  private readonly startRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Pending gateway reconnect timer, if the last login attempt failed. */
  private adapterRetryTimer?: ReturnType<typeof setTimeout>;
  /** Set once the initial boot's startAll has run, so a LATE gateway connect
   *  knows to bring up deferred bridges rather than double-starting them. */
  private booted = false;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly env: PortalEnv,
    private readonly publicPolicy?: Pick<PublicChannelPolicy, "assertPublicChannel"> & Partial<Pick<PublicChannelPolicy, "assertPublicChannels">>,
  ) {
    this.store = new PostgresMappingStore(sql);
  }

  async assertChannelPolicy(guildId: string, channelId: string): Promise<void> {
    if (this.env.mode === "public") await this.assertPublicChannel(guildId, channelId);
  }

  async assertPublicChannel(guildId: string, channelId: string): Promise<void> {
    const policy = this.publicPolicy ?? (this.env.publicChannels && discordPublicChannelPolicy(this.env.publicChannels, this.env.discordBotToken));
    if (!policy) throw new PublicPolicyUnavailableError("Public channel policy is not configured");
    try { await policy.assertPublicChannel(guildId, channelId); }
    catch { throw new PublicPolicyUnavailableError("Public channel visibility could not be verified"); }
  }

  async assertPublicChannels(guildId: string, channelIds: readonly string[]): Promise<void> {
    const policy = this.publicPolicy ?? (this.env.publicChannels && discordPublicChannelPolicy(this.env.publicChannels, this.env.discordBotToken));
    if (!policy) throw new PublicPolicyUnavailableError("Public channel policy is not configured");
    try {
      if (policy.assertPublicChannels) await policy.assertPublicChannels(guildId, channelIds);
      else for (const id of channelIds) await policy.assertPublicChannel(guildId, id);
    } catch { throw new PublicPolicyUnavailableError("Public channel visibility could not be verified"); }
  }

  get discordConnected(): boolean { return this.adapter?.client.isReady() ?? false; }

  async init(): Promise<void> {
    if (this.env.discordBotToken) {
      await this.connectAdapter();
    } else {
      console.warn("portal: DISCORD_TOKEN not set; bridges cannot go live");
    }
    await this.startAll(await this.bridgesToStart());
    this.booted = true;
  }

  /**
   * Every bridge that should be running, the most recently active first.
   *
   * Boot is a queue, and whatever sits at the back of it stays dark until the
   * front has started; in heap order that was arbitrary, so a busy channel
   * could wait out the whole boot behind hundreds that never speak. Ordering
   * by the newest mirrored message puts the conversations people are having
   * first. Bridges with no traffic yet (new, or pending confirm) go last.
   */
  private bridgesToStart(): Promise<BridgeRow[]> {
    return this.sql<BridgeRow[]>`
      SELECT b.* FROM bridges b
      LEFT JOIN LATERAL (
        SELECT m.created_at FROM messages m
        WHERE m.tenant_id = 'default' AND m.discord_channel_id = b.discord_channel_id
        ORDER BY m.created_at DESC LIMIT 1
      ) last ON true
      WHERE b.status IN ('pending_confirm', 'active')
      ORDER BY last.created_at DESC NULLS LAST`;
  }

  /** A fresh gateway client wired to this manager's handlers. */
  private buildAdapter(token: string): DiscordAdapter {
    return new DiscordAdapter(token, {
      onMessage: async (msg) => this.onDiscord(msg),
      onBotCommand: (message) => this.handleBotCommand(message),
      onMessageUpdate: async (msg) => {
        const rb = this.activeRouterFor(msg.channelId);
        if (rb) await rb.router!.onDiscordEdit(msg, rb.link);
      },
      onMessageDelete: async (del) => {
        const rb = this.activeRouterFor(del.channelId);
        if (rb) await rb.router!.onDiscordDelete(del, rb.link);
      },
      onReactionAdd: async (reaction) => {
        const rb = this.activeRouterFor(reaction.channelId);
        if (rb) await rb.router!.onDiscordReaction(reaction, rb.link);
      },
      onReactionRemove: async (reaction) => {
        const rb = this.activeRouterFor(reaction.channelId);
        if (rb) await rb.router!.onDiscordReactionRemove(reaction, rb.link);
      },
      onTyping: async (typing) => {
        if (typing.bot) return;
        const rb = this.activeRouterFor(typing.channelId);
        if (rb) await rb.router!.onDiscordTyping(typing.userId, rb.link);
      },
    }, async (channelId) => {
      const running = this.activeRouterFor(channelId);
      if (!running) throw new Error("No active channel owner");
      await running.assertMayForward();
    });
  }

  /**
   * Bring up the shared Discord gateway, retrying on failure with capped
   * backoff. A failed login (e.g. the REST preflight to discord.com refused
   * during a network blip — 2026-08-27) used to leave the gateway down for the
   * whole process lifetime, which is what turned that blip into a mass sever:
   * every active bridge then found no adapter and was severed on the spot. Now
   * the gateway heals on its own and onAdapterConnected() brings the bridges
   * up, so a transient outage no longer needs a manual restart. A persistent
   * error (a bad token, or MESSAGE_CONTENT not enabled) just keeps logging
   * until the config is fixed — harmless, and the right failure mode.
   */
  private async connectAdapter(attempt = 0): Promise<void> {
    const token = this.env.discordBotToken;
    if (!token) return;
    const adapter = this.buildAdapter(token);
    try {
      await adapter.start();
      this.adapter = adapter;
      console.log("portal: discord gateway up");
      if (this.booted) void this.onAdapterConnected();
    } catch (error) {
      await adapter.stop().catch(() => {}); // don't leak a half-open client
      this.adapter = undefined;
      const cap = Math.min(GATEWAY_RETRY_BASE_MS * 2 ** Math.min(attempt, 6), GATEWAY_RETRY_MAX_MS);
      const delay = cap / 2 + Math.random() * (cap / 2);
      console.error(
        `portal: discord gateway failed to start (attempt ${attempt + 1}); retrying in ${Math.round(delay / 1000)}s:`,
        error,
      );
      this.adapterRetryTimer = setTimeout(() => void this.connectAdapter(attempt + 1), delay);
    }
  }

  /**
   * The gateway came up AFTER boot (a reconnect). Bridges that deferred their
   * start while it was down are not running and are sitting on a backoff timer;
   * start them now rather than wait the backoff out.
   */
  private async onAdapterConnected(): Promise<void> {
    const rows = await this.bridgesToStart();
    const deferred = rows.filter((row) => !this.running.has(row.bridge_id));
    for (const row of deferred) this.cancelStartRetry(row.bridge_id);
    if (deferred.length > 0) {
      console.log(`portal: gateway back; starting ${deferred.length} deferred bridge(s)`);
      await this.startAll(deferred);
    }
  }

  /**
   * Bring every stored bridge up, several at a time.
   *
   * One at a time took half an hour for a few hundred bridges, and the cost
   * is not evenly shared: each start() is a chain of relay round trips
   * (resolve, fold, key intake, four publishes) plus two Discord lookups, so
   * every bridge queued behind the current one stays dark for the whole
   * boot. A single unresponsive relay makes that wait unbounded for
   * everything after it — the bridge at the end of the list pays for every
   * sick relay in front of it.
   *
   * Bounded rather than unbounded: bridges share relays and a single Discord
   * bot token, so starting all of them at once would aim hundreds of
   * simultaneous REQs at the same few hosts and spend the token's REST
   * budget on name lookups.
   */
  private async startAll(rows: BridgeRow[]): Promise<void> {
    const queue = [...rows];
    const began = Date.now();
    // shift() needs no lock: the workers only interleave at their awaits.
    const worker = async (): Promise<void> => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        await this.startTracked(row);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(START_CONCURRENCY, queue.length) }, () => worker()),
    );
    const live = rows.filter((row) => this.running.has(row.bridge_id)).length;
    console.log(
      `portal: ${live}/${rows.length} bridges live in ${Math.round((Date.now() - began) / 1000)}s`,
    );
  }

  private async onDiscord(msg: DiscordInboundMessage): Promise<void> {
    const rb = this.activeRouterFor(msg.channelId);
    if (rb) await rb.router!.onDiscordMessage(msg, rb.link);
  }

  private activeRouterFor(discordChannelId: string): Running | undefined {
    const id = this.byDiscordChannel.get(discordChannelId);
    const rb = id ? this.running.get(id) : undefined;
    return rb?.router && rb.status === "active" ? rb : undefined;
  }

  /** Resolve + fold a community for the wizard's pairing step (transient). */
  async inspectInvite(inviteUrl: string): Promise<{
    community: { idHex: string; name: string; relays: string[] };
    channels: Array<{ idHex: string; name: string }>;
  }> {
    const invite = parseInviteLink(inviteUrl);
    if (!invite) throw new Error("not a valid Armada invite URL");
    // Both lists are attacker-reachable: bootstrapRelays is encoded in the
    // pasted link, and community.relays rides on the event that link resolves
    // to. Neither may name a host inside our network.
    const bootstrap = new RelayPool(
      await filterPublicRelays(
        invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS,
        STOCK_RELAYS,
      ),
    );
    try {
      const { community } = await resolveInvite(inviteUrl, bootstrap);
      const pool = new RelayPool(await filterPublicRelays(community.relays, STOCK_RELAYS));
      try {
        const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
        await client.syncControl();
        return {
          community: { idHex: community.idHex, name: community.name, relays: community.relays },
          channels: client.channels().filter((c) => this.env.mode !== "public" || !c.isPrivate).map((c) => ({ idHex: c.idHex, name: c.name })),
        };
      } finally {
        await pool.close();
      }
    } finally {
      await bootstrap.close();
    }
  }

  /**
   * One sealed master secret per (community, guild); first channel mints,
   * rest reuse, so a Discord user keeps one npub across every channel
   * bridged between the same server and community. The primary key makes
   * concurrent activations race-proof: both insert, one wins, both read
   * back the same row.
   */
  private async sharedMasterSecret(communityId: string, guildId: string): Promise<Uint8Array> {
    const master = this.env.puppetMaster;
    if (master && (master.communityId !== communityId || master.guildId !== guildId)) throw new Error("Provisioned puppet scope mismatch");
    const candidate = seal(this.env.sealKeyHex, master?.key ?? randomBytes(32).toString("hex"));
    await this.sql`
      INSERT INTO guild_community_secrets (community_id, discord_guild_id, master_secret_sealed)
      VALUES (${communityId}, ${guildId}, ${candidate})
      ON CONFLICT (community_id, discord_guild_id) DO NOTHING`;
    const [row] = await this.sql<{ master_secret_sealed: Uint8Array }[]>`
      SELECT master_secret_sealed FROM guild_community_secrets
      WHERE community_id = ${communityId} AND discord_guild_id = ${guildId}`;
    if (master && unseal(this.env.sealKeyHex, row.master_secret_sealed) !== master.key) throw new Error("Puppet root differs from provisioned worker identity");
    return row.master_secret_sealed;
  }

  /** Mint per-bridge secrets and move draft -> pending_confirm. */
  async activate(row: BridgeRow): Promise<void> {
    if (!row.community_id || !row.discord_guild_id) {
      throw new Error("bridge must be linked (community + guild) before activation");
    }
    await this.assertChannelPolicy(row.discord_guild_id, row.discord_channel_id ?? "");
    const primarySk = generateSecretKey();
    const primary = localIdentity(primarySk);
    const confirmCode = randomBytes(4).toString("hex");
    const masterSecretSealed = await this.sharedMasterSecret(row.community_id, row.discord_guild_id);

    await this.sql`
      UPDATE bridges SET
        master_secret_sealed = ${masterSecretSealed},
        primary_sk_sealed = ${seal(this.env.sealKeyHex, bytesToHex(primarySk))},
        primary_pk = ${primary.pk},
        confirm_code = ${confirmCode},
        status = 'pending_confirm', status_detail = NULL, updated_at = now()
      WHERE bridge_id = ${row.bridge_id}`;

    const [fresh] = await this.sql<BridgeRow[]>`SELECT * FROM bridges WHERE bridge_id = ${row.bridge_id}`;
    await this.start(fresh);
  }

  /**
   * Activate a bridge minted by the server importer: same secret minting as
   * `activate`, but straight to `active` with no in-channel confirm — the
   * portal custodially owns the imported community, so the Armada-side
   * consent the confirm gate exists for is implicit.
   */
  /**
   * Mint the bridge's identity and mark it active, WITHOUT starting it.
   *
   * Kept separate from {@link activateImported} so import checkpoints can persist
   * provisioned identity before starting the public-channel bridge.
   */
  async provisionImported(row: BridgeRow): Promise<BridgeRow> {
    if (!row.community_id || !row.discord_guild_id) {
      throw new Error("bridge must be linked (community + guild) before activation");
    }
    await this.assertChannelPolicy(row.discord_guild_id, row.discord_channel_id ?? "");
    const primarySk = generateSecretKey();
    const primary = localIdentity(primarySk);
    const masterSecretSealed = await this.sharedMasterSecret(row.community_id, row.discord_guild_id);

    await this.sql`
      UPDATE bridges SET
        master_secret_sealed = ${masterSecretSealed},
        primary_sk_sealed = ${seal(this.env.sealKeyHex, bytesToHex(primarySk))},
        primary_pk = ${primary.pk},
        status = 'active', status_detail = NULL, updated_at = now()
      WHERE bridge_id = ${row.bridge_id}`;

    const [fresh] = await this.sql<BridgeRow[]>`SELECT * FROM bridges WHERE bridge_id = ${row.bridge_id}`;
    return fresh;
  }

  /** Start an already-provisioned bridge. Safe to retry: `start` is idempotent. */
  async startImported(row: BridgeRow): Promise<void> {
    await this.start(row);
  }

  async activateImported(row: BridgeRow): Promise<void> {
    await this.start(await this.provisionImported(row));
  }

  private async start(row: BridgeRow): Promise<void> {
    if (this.running.has(row.bridge_id)) return;
    // An active bridge mirrors in both directions through the shared gateway,
    // so without it there is nothing to attach — defer before doing the relay
    // work (resolve and fold) rather than fold a whole community only
    // to find nowhere to route it. GatewayUnavailableError is caught in
    // startTracked and never counts toward a sever (see its definition).
    if (row.status === "active" && !this.adapter) throw new GatewayUnavailableError();
    if (!row.invite_url_sealed || !row.master_secret_sealed || !row.primary_sk_sealed) {
      throw new Error("bridge is missing sealed key material");
    }
    await this.assertChannelPolicy(row.discord_guild_id ?? "", row.discord_channel_id ?? "");
    let starting = true;
    let lost = false;
    const lease = await new BridgeLeases(this.sql).acquire(bridgeResource(row.discord_guild_id!, row.discord_channel_id!), () => {
      lost = true;
      // Startup owns its partial resources until startOwned has unwound. A
      // callback there must not race cleanup or leave a dead instance registered.
      if (!starting) void this.onLeaseLost(row.bridge_id, lease!).catch((error) =>
        console.error(`bridge ${row.bridge_id}: lease loss cleanup failed`, error));
    });
    if (!lease) throw new BridgeLeaseUnavailableError("Bridge lease is owned by another worker");
    try {
      await this.startOwned(row, lease);
      starting = false;
      if (lost) {
        await this.onLeaseLost(row.bridge_id, lease);
        throw new BridgeLeaseUnavailableError("Bridge lease expired during startup");
      }
    } catch (error) {
      starting = false;
      await lease.release().catch(() => {});
      if (lost) {
        this.scheduleStartRetry(row.bridge_id, 0, true);
        throw new BridgeLeaseUnavailableError("Bridge lease expired during startup");
      }
      throw error;
    }
  }

  private async startOwned(row: BridgeRow, lease: BridgeLease): Promise<void> {
    const cleanup: Array<() => void | Promise<void>> = [];
    try {
      const inviteUrl = unseal(this.env.sealKeyHex, row.invite_url_sealed!);
      const invite = parseInviteLink(inviteUrl);
      if (!invite) throw new Error("stored invite no longer parses");

      const bootstrap = new RelayPool(
        await filterPublicRelays(
          invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS,
          STOCK_RELAYS,
        ),
      );
      const { community } = await resolveInvite(inviteUrl, bootstrap).finally(() => void bootstrap.close());

      const primarySk = Uint8Array.from(Buffer.from(unseal(this.env.sealKeyHex, row.primary_sk_sealed!), "hex"));
      const primary = localIdentity(primarySk);
      // NIP-42 identity: the bridge's own npub, not a throwaway. Relays that gate
      // kind 1059 serve a giftwrap only to the pubkey it is addressed to, and the
      // Direct Invites carrying private-channel keys are addressed to this npub.
      // Under a random identity the bridge could never read its own key
      // deliveries on relay.ditto.pub or relay.dreamith.to — every private
      // channel an import admitted it to failed "concord channel not found" on
      // every start (2026-09-24). The npub is public already (kind 0, guestbook).
      const pool = identityRelayPool(await filterPublicRelays(community.relays, STOCK_RELAYS), primarySk);

      cleanup.push(() => pool.close());
      // Fold the Control Plane first: it reads from the community root the
      // invite carried, so the roster — and with it, who may vend a channel key
      // — is knowable before we accept any. The intake refuses anyone else.
      const preflight = new ConcordClient(community, pool, primary);
      const folded = await preflight.syncControl();
      let rawClient = preflight;
      if (this.env.mode !== "public") {

        // Private-channel keys granted to THIS bridge's npub since it was linked,
        // delivered as Direct Invites (see keyIntake.ts). Runs before the client
        // that serves `channels()` is built, so a gated channel is present on the
        // first pass.
        const floor = identityRelayPool(inviteDeliveryRelays([]), primarySk);
        const intake = await intakeDirectInviteKeys([pool, floor], primary, community, {
          isAuthorizedSender: (pk) =>
            isAuthorized(folded.roster, pk, community.owner, Permissions.MANAGE_CHANNELS),
        }).finally(() => void floor.close());

        rawClient =
          intake.learned.length > 0 ? new ConcordClient(intake.community, pool, primary) : preflight;
        if (intake.learned.length > 0) await rawClient.syncControl();
      }
      const assertMayForward = async () => {
        await lease.assertCurrent();
        const [state] = await this.sql`SELECT status FROM bridges WHERE bridge_id = ${row.bridge_id}`;
        if (!state || !["active", "pending_confirm"].includes(state.status)) throw new Error("Bridge is paused or unlinked");
        try {
          await this.assertChannelPolicy(row.discord_guild_id ?? "", row.discord_channel_id ?? "");
        } catch (error) {
          await lease.assertCurrent();
          await this.sql`UPDATE bridges SET status_detail = 'Forwarding blocked: public visibility unavailable', updated_at = now() WHERE bridge_id = ${row.bridge_id}`;
          throw error;
        }
        const current = row.concord_channel_id && rawClient.channel(row.concord_channel_id);
        if (!current || (this.env.mode === "public" && current.isPrivate)) throw new Error("Concord channel must be public");
        await lease.assertCurrent();
        await this.sql`UPDATE bridges SET status_detail = NULL WHERE bridge_id = ${row.bridge_id}
          AND status_detail = 'Forwarding blocked: public visibility unavailable'`;
      };
      const client = guardEffects(rawClient, assertMayForward, CONCORD_EFFECT_METHODS);

      const channel = row.concord_channel_id ? client.channel(row.concord_channel_id) : undefined;
      if (!channel) {
        await pool.close();
        throw new Error("concord channel not found (deleted, or key not held)");
      }
      if (this.env.mode === "public" && channel.isPrivate) {
        await pool.close();
        throw new Error("Concord channel must be public");
      }
      // Severance, checked BEFORE anything is announced or attached: a banned,
      // refounded or dissolved community must never earn one more mirrored
      // message or one more welcome. One bounded query across the severance
      // planes plus the fold we already hold decides it (see ./severance.ts for
      // the three cases); a throw below lands in startTracked as a SeveredError
      // and is not retried.
      await this.detectSeveranceAtBoot(row, community, pool, rawClient.folded, primary);
      // Refresh display names each start: renames heal on the next boot, and
      // rows from before the name columns existed backfill themselves. The two
      // lookups hit different Discord endpoints and neither reads the other, so
      // they go together rather than one after the next.
      const [discordName, guildName] = await Promise.all([
        row.discord_channel_id
          ? this.adapter?.channelName(row.discord_channel_id).catch(() => null)
          : null,
        row.discord_guild_id ? this.adapter?.guildName(row.discord_guild_id).catch(() => null) : null,
      ]);
      // A failed lookup is null, and null used to be written straight over a
      // name that was already correct — so one rate-limited boot silently
      // blanked the dashboard for bridges nothing was wrong with. Keep what we
      // knew unless Discord actually answered; a real rename still heals,
      // because a rename answers.
      await this.sql`
        UPDATE bridges SET concord_channel_name = ${channel.name},
          discord_channel_name = coalesce(${discordName ?? null}, discord_channel_name),
          discord_guild_name = coalesce(${guildName ?? null}, discord_guild_name)
        WHERE bridge_id = ${row.bridge_id}`;
      // Four announcements the bridge owes the relays, none of which anything
      // below reads: the join, our giftwrap inbox (so the next key handoff is
      // delivered to the relays we actually watch rather than the stock interop
      // floor), the bot's profile, and the command manifest. Awaited in sequence
      // they cost four publish timeouts — up to ~32s during which the bridge is
      // fully folded and able to mirror, but routing has not been attached. So
      // they are fired together and not waited on; each already swallows its own
      // failure, exactly as announceBridge does.
      void Promise.all([
        client.publishJoin().catch(() => {}),
        client.publishDmRelays(primary, community.relays).catch(() => {}),
        client
          .publishProfile(primary, {
            name: "Discord <-> Armada Bridge Bot",
            picture: this.adapter?.botAvatarUrl,
            about:
              "Automated bridge account: posts link confirmations and mirrors this channel with a Discord server.",
            bot: true,
          })
          .catch(() => {}),
        client.publishManifest(BRIDGE_COMMANDS).catch(() => {}),
      ]);

      const link: ChannelLink = {
        discordGuildId: row.discord_guild_id ?? "",
        discordChannelId: row.discord_channel_id ?? "",
        communityId: community.idHex,
        concordChannelIdHex: channel.idHex,
        enabled: true,
      };

      const rb: Running = {
        lease,
        assertMayForward,
        id: row.bridge_id,
        client,
        pool,
        channel,
        link,
        primary,
        status: row.status === "active" ? "active" : "pending_confirm",
        unsubChat: () => {},
        unsubControl: () => {},
        unsubSeverance: () => {},
      };

      cleanup.push(() => { rb.unsubChat(); rb.unsubControl(); rb.unsubSeverance(); });
      rb.unsubChat = client.subscribeChannel(
        channel,
        (chat) => {
          void this.onConcordChat(rb, chat, row.confirm_code ?? "").catch((error) =>
            console.error(`bridge ${rb.id}: concord handler failed`, error),
          );
        },
        (relayUrl, error) => console.error(`bridge ${rb.id}: chat subscription ${relayUrl}:`, error),
        (streamPk, wrapAt) => {
          void this.store.cursorSet(community.idHex, streamPk, wrapAt).catch(() => {});
        },
      );
      // A rekey (epoch bump) mints new stream keys; a REQ pinned to the old
      // ones goes silent while publishes (fresh channel lookup) keep working.
      // Re-subscribe whenever the fold changes the channel's stream set. The
      // same fold carries the Banlist — severance case 1 — so that check rides
      // along here instead of waiting for sends to fail one at a time.
      const joinedAtMs =
        row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
      const severanceWraps = new Map<string, NostrEvent>();
      const checkSeverance = (folded: FoldedControl | undefined) => {
        const verdict = detectSeverance({
          wraps: [...severanceWraps.values()],
          community,
          me: primary.pk,
          folded,
          joinedAtMs,
        });
        if (!verdict) return;
        void this.applySeverance(rb.id, verdict, community).catch((error) =>
          console.error(`bridge ${rb.id}: severance handling failed`, error),
        );
      };
      rb.unsubControl = client.subscribeControl((folded) => {
        this.refreshChatSubscription(rb, row.confirm_code ?? "");
        checkSeverance(folded);
      });
      // Severance cases 2-3 arrive on their own planes: the dissolved tombstone
      // and the base-rekey window (see severanceStreamKeys). Wraps accumulate
      // because a Refounding publishes as several chunks and only a COMPLETE
      // rotation says anything — and eviction is safe in the only direction
      // that matters: a rotation missing a chunk reads as NO verdict (never a
      // false sever), so a flood's failure mode is missing one until the next
      // boot's probe, not inventing one.
      rb.unsubSeverance = pool.subscribe(
        [{ kinds: [KIND_WRAP], authors: severanceStreamKeys(community).map((k) => k.pk) }],
        {
          onEvent: (wrap) => {
            severanceWraps.set(wrap.id, wrap);
            while (severanceWraps.size > SEVERANCE_WRAP_CAP) {
              severanceWraps.delete(severanceWraps.keys().next().value as string);
            }
            checkSeverance(rb.client.folded);
          },
        },
      );

      if (rb.status === "active") {
        const liveFromMs = Date.now();
        this.attachRouting(rb, unseal(this.env.sealKeyHex, row.master_secret_sealed!), row.options);
        this.backfillMissed(rb).catch((error) =>
          console.warn(`bridge ${rb.id}: catch-up backfill failed:`, error),
        );
        this.catchUpDiscord(rb, liveFromMs).catch((error) =>
          console.warn(`bridge ${rb.id}: Discord catch-up failed:`, error),
        );
      } else {
        await client.sendChat(channel, {
          content:
            `A Discord bridge requests to link this channel. Bridged messages LEAVE ` +
            `end-to-end encryption and are mirrored to Discord in plaintext. ` +
            `A member with Manage Channels can enable it by replying:\n` +
            `/bridge confirm ${row.confirm_code}`,
          author: { pk: primary.pk, signer: primary.signer },
        });
      }
      await lease.assertCurrent();
      this.running.set(rb.id, rb);
    } catch (error) {
      for (const close of cleanup.reverse()) await Promise.resolve().then(close).catch(() => {});
      const current = this.running.get(row.bridge_id);
      if (!current || current.lease === lease) this.byDiscordChannel.delete(row.discord_channel_id ?? "");
      throw error;
    }
  }

  /**
   * Bounded catch-up after downtime: replay wraps newer than the stored
   * cursor through the router (the mapping table dedupes). A channel with no
   * cursor has never been tailed; it starts live-only, deliberately, so a
   * fresh bridge does not replay stored history into Discord.
   */
  private async backfillMissed(rb: Running): Promise<void> {
    const streamPks = rb.channel.streams.map((s) => s.group.pk);
    const cursor = await this.store.cursorGet(rb.link.communityId, streamPks);
    if (cursor === undefined) return;
    // Small overlap absorbs relay/pool clock skew; dedupe eats the rest.
    const { chats, newestWrapAt } = await rb.client.backfillChannel(rb.channel, cursor - 60);
    let mirrored = 0;
    for (const chat of chats) {
      if (!rb.router) break;
      const ids = await rb.router
        .onConcordChat(chat, rb.link)
        .catch((error) => {
          if (isMissingPermissions(error)) void this.alertMissingWebhookPermission(rb);
          else console.warn(`bridge ${rb.id}: backfill mirror failed for ${chat.rumorId}:`, error);
          return [];
        });
      mirrored += ids.length > 0 ? 1 : 0;
    }
    if (newestWrapAt !== undefined) {
      for (const pk of streamPks) {
        await this.store.cursorSet(rb.link.communityId, pk, newestWrapAt).catch(() => {});
      }
    }
    if (mirrored > 0) console.log(`bridge ${rb.id}: backfilled ${mirrored} missed messages`);
  }

  /**
   * Discord-side catch-up after downtime: replay what the Discord channel
   * said since the newest message this bridge has mirrored in either
   * direction.
   *
   * The gateway only delivers what happens while we are connected, and
   * backfillMissed covers the Armada side alone, so every restart dropped
   * whatever Discord said while the process was down — seven hours of it on
   * 2026-09-23. A channel with nothing mirrored yet has no anchor and is left
   * alone: history is the importer's job, not a restart's.
   *
   * Stops at `liveFromMs`, when routing attached: from then on the gateway
   * delivers, and replaying past it would race the live path into
   * publishing the same message twice.
   */
  private async catchUpDiscord(rb: Running, liveFromMs: number): Promise<void> {
    if (!this.env.discordBotToken || !rb.router) return;
    // A channel whose history import hasn't finished belongs to the importer.
    // It publishes oldest first, so mid-run the largest mirrored snowflake is
    // wherever it had got to — 2022, for one channel on 2026-09-24 — and a
    // catch-up from there races it over the same messages, with only a
    // check-then-insert between them. The importer needs no help: a resumed
    // run re-collects everything newer than its cursor, up to the moment it
    // resumes, and the gateway has everything after.
    const [importing] = await this.sql`
      SELECT 1 FROM imports i, jsonb_array_elements(i.plan->'channels') c
      WHERE i.status IN ('publishing', 'wiring', 'history')
        AND c->>'discordId' = ${rb.link.discordChannelId}
        AND (c->>'history')::boolean AND c->>'historyDoneAt' IS NULL
      LIMIT 1`;
    if (importing) return;
    // The anchor is the largest snowflake mirrored, never the newest row:
    // created_at is when WE wrote a row, and a history import writes old
    // messages now. The snowflake is Discord's own clock.
    const before = new Date(this.env.catchUpSinceMs ?? Date.now());
    const [{ anchor }] = await this.sql<{ anchor: string | null }[]>`
      SELECT max(discord_message_id::numeric)::text AS anchor FROM messages
      WHERE tenant_id = 'default' AND discord_channel_id = ${rb.link.discordChannelId}
        AND community_id = ${rb.link.communityId} AND created_at < ${before}`;
    if (!anchor) return;

    const { mirrored, capped } = await replayDiscordSince(anchor, liveFromMs, DISCORD_CATCHUP_MAX, {
      fetchAfter: async (afterId) => {
        await rb.assertMayForward();
        return botChannelMessagesAfter(this.env.discordBotToken, rb.link.discordChannelId, afterId);
      },
      alreadyMirrored: async (messageId) => {
        const [exists] = await this.sql`
          SELECT 1 FROM messages
          WHERE tenant_id = 'default' AND discord_message_id = ${messageId}
            AND community_id = ${rb.link.communityId} LIMIT 1`;
        return !!exists;
      },
      mirror: async (message) => {
        // A bridge stopped mid-replay has no router; the rest is moot.
        if (!rb.router) return false;
        const rumorId = await rb.router
          .onDiscordMessage(restToInbound(message, rb.link.discordGuildId, rb.link.discordChannelId), rb.link)
          .catch((error) => {
            console.warn(`bridge ${rb.id}: catch-up of Discord message ${message.id} failed:`, error);
            return undefined;
          });
        return rumorId !== undefined;
      },
    });
    if (mirrored > 0) console.log(`bridge ${rb.id}: caught up ${mirrored} missed Discord messages`);
    if (capped) console.warn(`bridge ${rb.id}: Discord catch-up stopped at ${DISCORD_CATCHUP_MAX} messages`);
  }

  /** Tear down and rebuild the chat REQ when the channel's stream set changes. */
  private refreshChatSubscription(rb: Running, confirmCode: string): void {
    const fresh = rb.client.channel(rb.link.concordChannelIdHex);
    // A channel vanishing from the fold is its own (local) condition — deleted,
    // or privatized past our keys — not community severance; the community
    // going away is the watchers in detectSeveranceAtBoot/checkSeverance.
    if (!fresh) return;
    const keys = (c: ChannelV2) => c.streams.map((s) => s.group.pk).join(",");
    if (keys(fresh) === keys(rb.channel)) return;
    rb.unsubChat();
    rb.channel = fresh;
    rb.unsubChat = rb.client.subscribeChannel(
      fresh,
      (chat) => {
        void this.onConcordChat(rb, chat, confirmCode).catch((error) =>
          console.error(`bridge ${rb.id}: concord handler failed`, error),
        );
      },
      (relayUrl, error) => console.error(`bridge ${rb.id}: chat subscription ${relayUrl}:`, error),
    );
    console.log(`bridge ${rb.id}: stream keys rotated; chat subscription refreshed`);
  }

  private async onConcordChat(rb: Running, chat: OpenedChat, confirmCode: string): Promise<void> {
    if (rb.status === "pending_confirm") {
      const match = chat.kind === 9 && CONFIRM_RE.exec(chat.content.trim());
      if (!match || match[1].toLowerCase() !== confirmCode.toLowerCase()) return;
      const folded = rb.client.folded;
      const authorized =
        !!folded &&
        isAuthorized(folded.roster, chat.author, rb.client.community.owner, Permissions.MANAGE_CHANNELS);
      if (!authorized) return;

      await rb.assertMayForward();
      const [row] = await this.sql<BridgeRow[]>`
        UPDATE bridges SET status = 'active', status_detail = NULL, updated_at = now()
        WHERE bridge_id = ${rb.id} RETURNING *`;
      rb.status = "active";
      try {
        this.attachRouting(rb, unseal(this.env.sealKeyHex, row.master_secret_sealed!), row.options);
      } catch (error) {
        if (!(error instanceof GatewayUnavailableError)) throw error;
        // Confirmed while the gateway was down. The row stays active; routing
        // attaches on the next restart. Don't sever, and don't claim it's live.
        console.warn(`bridge ${rb.id}: confirmed while Discord gateway down; will attach on reconnect`);
        return;
      }
      await rb.client
        .sendChat(rb.channel, {
          content: "Bridge confirmed. This channel is now mirrored with Discord.",
          author: rb.primary,
        })
        .catch(() => {});
      return;
    }
    if (!rb.router) return;
    try {
      await rb.router.onConcordChat(chat, rb.link);
    } catch (error) {
      if (isMissingPermissions(error)) return void this.alertMissingWebhookPermission(rb);
      throw error;
    }
  }

  /**
   * One-time alert that the bot can't mirror into its Discord channel because
   * it's missing Manage Webhooks. Claimed on the row first (survives restarts,
   * fires once), then announced where people will see it: the Concord channel
   * — which always works — and, best effort, the Discord channel itself (a
   * plain bot message needs only Send Messages, so it usually lands even when
   * webhooks don't). The bridge stays active; mirroring resumes on its own
   * once the permission is granted.
   */
  private async alertMissingWebhookPermission(rb: Running): Promise<void> {
    const detail = "the bot is missing Manage Webhooks in the linked Discord channel; Armada messages can't mirror there until it's granted";
    const [claimed] = await this.sql`
      UPDATE bridges SET perm_alerted_at = now(), status_detail = ${detail}
      WHERE bridge_id = ${rb.id} AND perm_alerted_at IS NULL
      RETURNING bridge_id`;
    if (!claimed) return;
    console.warn(`bridge ${rb.id}: ${detail}`);
    await rb.client
      .sendChat(rb.channel, {
        content:
          "Heads up: the Discord bridge bot is missing the \"Manage Webhooks\" permission in the " +
          "linked channel, so messages from here aren't being mirrored to Discord. A Discord admin " +
          "can grant the bot Manage Webhooks on that channel to restore it.",
        author: rb.primary,
      })
      .catch(() => {});
    await rb.assertMayForward();
    await this.adapter
      ?.notice(
        rb.link.discordChannelId,
        "I can't mirror Armada messages into this channel until I'm granted the \"Manage Webhooks\" permission here.",
      )
      .catch(() => {});
  }

  private attachRouting(
    rb: Running,
    masterSecretHex: string,
    options?: Record<string, unknown> | null,
  ): void {
    // The boot path guards this earlier (start()); this covers a live confirm
    // that races the gateway being down. Throwing — never severing — is the
    // whole point: a missing gateway is not the community going away.
    if (!this.adapter) throw new GatewayUnavailableError();
    rb.router = new BridgeRouter(
      rb.client,
      new PuppetCache(masterSecretHex),
      this.store,
      this.adapter,
      new Kind0ProfileResolver(rb.pool),
      { applicationId: this.adapter.applicationId, webhookIds: this.adapter.ownWebhookIds },
      {
        beforeSideEffect: rb.assertMayForward,
        bridgeEdits: options?.edits === true,
        blobs: this.env.blossomServer ? new BlossomStore(this.env.blossomServer) : undefined,
        klipy: this.env.klipyApiKey ? new KlipyClient(this.env.klipyApiKey) : undefined,
      },
    );
    this.byDiscordChannel.set(rb.link.discordChannelId, rb.id);
    this.announceBridge(rb).catch(() => {});
  }

  /**
   * One-time welcome in both directions when a bridge goes live: tells
   * everyone the channel is mirrored. Fire-and-forget.
   *
   * One-time means once per bridge EVER, not once per process: attachRouting
   * runs again on every restart's resume, so the sent-ness is claimed on the
   * row first. A crash between the claim and the sends drops the welcome,
   * which is the better failure than greeting the channel on every deploy.
   */
  private async announceBridge(rb: Running): Promise<void> {
    const [claimed] = await this.sql`
      UPDATE bridges SET announced_at = now()
      WHERE bridge_id = ${rb.id} AND announced_at IS NULL
      RETURNING bridge_id`;
    if (!claimed) return;
    await rb.client
      .sendChat(rb.channel, {
        content: "This channel is now mirrored with Discord.",
        author: rb.primary,
      })
      .catch(() => {});
    await rb.assertMayForward();
    await this.adapter!.send(rb.link, {
      username: "Armada Bridge",
      content: "This channel is now mirrored with an Armada community. /help lists what this bot answers.",
    }).catch(() => {});
  }

  private async closeRunning(rb: Running): Promise<void> {
    // Remove only this instance, before yielding: a replacement must never be
    // deleted by an old lease's delayed cleanup. Fencing is still in the DB.
    if (this.running.get(rb.id) !== rb) return;
    this.running.delete(rb.id);
    if (this.byDiscordChannel.get(rb.link.discordChannelId) === rb.id) {
      this.byDiscordChannel.delete(rb.link.discordChannelId);
    }
    rb.router = undefined;
    try { rb.unsubChat(); } catch {}
    try { rb.unsubControl(); } catch {}
    try { rb.unsubSeverance(); } catch {}
    await rb.pool.close().catch(() => {});
  }

  private async onLeaseLost(bridgeId: string, lease: BridgeLease): Promise<void> {
    const rb = this.running.get(bridgeId);
    if (!rb || rb.lease !== lease) return;
    try {
      await this.closeRunning(rb);
    } finally {
      // This is not an operator pause: preserve durable status and retry even
      // if storage is still down. retryStart re-reads any subsequent pause.
      this.scheduleStartRetry(bridgeId, 0, true);
    }
  }

  async stop(bridgeId: string, status: "paused" | "unlinked", detail?: string): Promise<void> {
    this.cancelStartRetry(bridgeId);
    const rb = this.running.get(bridgeId);
    if (rb) {
      // release invalidates the local handle before its DB round trip. Failure
      // must not keep subscriptions alive or prevent the requested status write.
      await rb.lease.release().catch((error) => console.warn(`bridge ${bridgeId}: lease release failed`, error));
      await this.closeRunning(rb);
    }
    if (status === "unlinked") {
      await this.sql`
        UPDATE bridges SET status = 'unlinked', status_detail = ${detail ?? null},
          invite_url_sealed = NULL, master_secret_sealed = NULL, primary_sk_sealed = NULL,
          updated_at = now()
        WHERE bridge_id = ${bridgeId}`;
    } else {
      await this.sql`
        UPDATE bridges SET status = ${status}, status_detail = ${detail ?? null}, updated_at = now()
        WHERE bridge_id = ${bridgeId}`;
    }
  }

  async resume(bridgeId: string): Promise<void> {
    const [row] = await this.sql<BridgeRow[]>`SELECT * FROM bridges WHERE bridge_id = ${bridgeId}`;
    if (!row) throw new Error("no such bridge");
    await this.assertChannelPolicy(row.discord_guild_id ?? "", row.discord_channel_id ?? "");
    const next = row.confirm_code && !this.running.has(bridgeId) ? "pending_confirm" : "active";
    await this.sql`UPDATE bridges SET status = ${row.status === "paused" ? "active" : next}, updated_at = now() WHERE bridge_id = ${bridgeId}`;
    const [fresh] = await this.sql<BridgeRow[]>`SELECT * FROM bridges WHERE bridge_id = ${bridgeId}`;
    await this.startTracked(fresh);
  }

  /**
   * start() with failure treated as transient rather than terminal. A start
   * that throws leaves the row in its current status — still holding the
   * one-bridge-per-channel slot, so no duplicate can be minted mid-outage —
   * records when the failing streak began (in options, so it survives
   * restarts), and retries with backoff. markSevered only fires once the
   * streak outlives START_FAILURE_SEVER_AFTER_MS: a single relay window
   * where nobody answered used to sever permanently (see the Lynch Memorial
   * Park bridge, 2026-08-10), and severed rows are never retried.
   */
  private async startTracked(row: BridgeRow, attempt = 0): Promise<void> {
    // A deferred bridge can be nudged by both onAdapterConnected() and its own
    // backoff timer; start() also guards, but skip the work up front.
    if (this.running.has(row.bridge_id)) return;
    try {
      await this.start(row);
    } catch (error) {
      if (error instanceof BridgeLeaseUnavailableError) {
        // Another owner (or a just-dead process's 90s lease) is not a bridge
        // failure. Do not overwrite its status detail or wait minutes to retry.
        this.scheduleStartRetry(row.bridge_id, attempt, true);
        return;
      }
      if (error instanceof PublicPolicyUnavailableError) {
        try {
          await this.sql`UPDATE bridges SET status_detail = ${error.message}, updated_at = now() WHERE bridge_id = ${row.bridge_id}`;
        } catch (bookkeepingError) {
          console.warn(`bridge ${row.bridge_id}: could not record deferred start`, bookkeepingError);
        } finally {
          this.scheduleStartRetry(row.bridge_id, attempt);
        }
        return;
      }
      if (error instanceof GatewayUnavailableError) {
        // Not a start failure: the community is fine, the local gateway is
        // down. Retry without touching status_detail or the sever streak, so
        // no amount of gateway downtime can ever sever a bridge. The gateway
        // healing (connectAdapter) will bring it up via onAdapterConnected;
        // this timer is just a backstop.
        console.warn(`bridge ${row.bridge_id}: deferring start, Discord gateway down (attempt ${attempt + 1})`);
        this.scheduleStartRetry(row.bridge_id, attempt);
        return;
      }
      if (error instanceof SeveredError) {
        // The community cut this bridge off during its own start. Detection
        // already tore it down and wrote 'severed' with the real reason; the
        // start-failure path would overwrite that detail with the throw text
        // and arm a seven-day retry streak against a banned, refounded or
        // dissolved community. Severed rows wait for an operator (resume).
        return;
      }
      // The bookkeeping is best-effort; the retry is not. This runs from a
      // bare timer and from startAll's workers, so a throw here was an
      // unhandled rejection that killed the process — 2026-09-24, a postgres
      // CONNECT_TIMEOUT 70 minutes into a CPU-bound boot restarted the whole
      // thousand-bridge boot from zero.
      await this.handleStartFailure(row, String(error), attempt).catch((bookkeepingError) => {
        console.error(`bridge ${row.bridge_id}: could not record start failure; retrying anyway:`, bookkeepingError);
        this.scheduleStartRetry(row.bridge_id, attempt);
      });
      return;
    }
    // Started and running: failing to clear the streak marker must not be
    // mistaken for a failed start. The next successful boot clears it. Both
    // clears are gated on the bridge still being up: a severance that landed
    // between start() and here must keep its record, not have the reason
    // wiped by the very boot it cut off.
    if (!this.running.has(row.bridge_id)) return;
    await this.clearStartFailure(row).catch((error) =>
      console.warn(`bridge ${row.bridge_id}: could not clear start-failure marker:`, error),
    );
    await this.clearSeveredReason(row).catch((error) =>
      console.warn(`bridge ${row.bridge_id}: could not clear severed_reason:`, error),
    );
  }

  private async handleStartFailure(row: BridgeRow, detail: string, attempt: number): Promise<void> {
    const since = row.options?.startFailedAt;
    const firstAt = typeof since === "string" ? Date.parse(since) : NaN;
    if (Number.isFinite(firstAt) && Date.now() - firstAt >= START_FAILURE_SEVER_AFTER_MS) {
      await this.markSevered(row.bridge_id, detail);
      return;
    }
    console.warn(`bridge ${row.bridge_id}: start failed (attempt ${attempt + 1}), will retry: ${detail}`);
    if (Number.isFinite(firstAt)) {
      await this.sql`
        UPDATE bridges SET status_detail = ${detail}, updated_at = now()
        WHERE bridge_id = ${row.bridge_id}`;
    } else {
      await this.sql`
        UPDATE bridges SET options = options || ${this.sql.json({ startFailedAt: new Date().toISOString() })},
          status_detail = ${detail}, updated_at = now()
        WHERE bridge_id = ${row.bridge_id}`;
    }
    this.scheduleStartRetry(row.bridge_id, attempt);
  }

  private scheduleStartRetry(bridgeId: string, attempt: number, leaseContention = false): void {
    if (this.startRetryTimers.has(bridgeId)) return;
    // Full jitter: bridges share relays, so one relay outage puts many
    // bridges into this path at once — identical delays would line them all
    // up on the same retry tick against a host that is already struggling.
    const cap = leaseContention ? 5_000 : Math.min(START_RETRY_BASE_MS * 2 ** Math.min(attempt, 6), START_RETRY_MAX_MS);
    const delay = cap / 2 + Math.random() * (cap / 2);
    const timer = setTimeout(() => {
      this.startRetryTimers.delete(bridgeId);
      // retryStart's own row read can fail the same way; back off and try
      // again rather than let the rejection take the process down.
      this.retryStart(bridgeId, attempt + 1).catch((error) => {
        console.error(`bridge ${bridgeId}: retry failed before starting; rescheduling:`, error);
        this.scheduleStartRetry(bridgeId, attempt + 1);
      });
    }, delay);
    this.startRetryTimers.set(bridgeId, timer);
  }

  private async retryStart(bridgeId: string, attempt: number): Promise<void> {
    if (this.running.has(bridgeId)) return;
    // Re-read the row: an operator may have paused or unlinked the bridge
    // while the retry was pending, and that decision wins.
    const [row] = await this.sql<BridgeRow[]>`SELECT * FROM bridges WHERE bridge_id = ${bridgeId}`;
    if (!row || (row.status !== "active" && row.status !== "pending_confirm")) return;
    await this.startTracked(row, attempt);
  }

  private cancelStartRetry(bridgeId: string): void {
    const timer = this.startRetryTimers.get(bridgeId);
    if (timer) {
      clearTimeout(timer);
      this.startRetryTimers.delete(bridgeId);
    }
  }

  private async clearStartFailure(row: BridgeRow): Promise<void> {
    this.cancelStartRetry(row.bridge_id);
    if (row.options?.startFailedAt === undefined) return;
    console.log(`bridge ${row.bridge_id}: recovered from failing start`);
    await this.sql`
      UPDATE bridges SET options = options - 'startFailedAt', status_detail = NULL, updated_at = now()
      WHERE bridge_id = ${row.bridge_id}`;
  }

  private async markSevered(bridgeId: string, detail: string): Promise<void> {
    this.cancelStartRetry(bridgeId);
    console.error(`bridge ${bridgeId}: severed: ${detail}`);
    // Drop the failing-streak marker so a manual resume after a sever starts
    // a fresh grace window instead of instantly re-severing on one failure.
    await this.sql`
      UPDATE bridges SET status = 'severed', status_detail = ${detail},
        options = options - 'startFailedAt', updated_at = now()
      WHERE bridge_id = ${bridgeId}`;
  }

  /**
   * The severance ACTION (./severance.ts decides THAT it fired; this decides
   * what the bridge does about it). Three things, the same three the operator
   * pause/unlink path does: stop forwarding (tear the running instance down
   * exactly as stop() does), surface it (bridges.status 'severed' +
   * status_detail via markSevered — the dashboard's resume button already
   * speaks 'severed'), and durably record WHY (schema.sql's
   * communities.severed_reason — the 'banned' | 'refounded' | 'dissolved'
   * column nothing wrote until now). A second verdict for an already-torn-down
   * bridge only refreshes that record.
   */
  private async applySeverance(
    bridgeId: string,
    verdict: SeveranceVerdict,
    community: { idHex: string; relays?: string[]; name?: string },
  ): Promise<void> {
    const rb = this.running.get(bridgeId);
    if (rb) {
      // Same teardown as stop(): release invalidates the local handle before
      // its DB round trip, then subscriptions and pool close. A teardown
      // failure must not prevent the durable record below.
      await rb.lease.release().catch((error) => console.warn(`bridge ${bridgeId}: lease release failed`, error));
      await this.closeRunning(rb);
    }
    await this.markSevered(bridgeId, severanceDetail(verdict));
    // Best-effort, like every secondary bookkeeping write here: the bridges
    // row is the dashboard's surface and already stands; this row is the
    // durable per-community reason, worth recording but not worth failing the
    // action for.
    await this.sql`
      INSERT INTO communities (tenant_id, community_id, relays, name, severed_reason)
      VALUES ('default', ${community.idHex}, ${community.relays ?? []}, ${community.name ?? null}, ${verdict.reason})
      ON CONFLICT (tenant_id, community_id)
      DO UPDATE SET severed_reason = EXCLUDED.severed_reason`.catch((error) =>
      console.warn(`bridge ${bridgeId}: could not record severed_reason:`, error),
    );
  }

  /**
   * Boot-time severance: one bounded query across the severance planes (the
   * dissolved tombstone and the base-rekey window travel as the same kind
   * 1059, routed by stream address) plus the control fold this start already
   * holds. A failed read is NOT severance — relays give no tombstones (see
   * START_FAILURE_SEVER_AFTER_MS on exactly this indistinguishability) — so a
   * probe that could not run leaves the bridge up for the standing watchers to
   * catch: the failure mode is a late sever, never a false one.
   */
  private async detectSeveranceAtBoot(
    row: BridgeRow,
    community: CommunityV2,
    pool: RelayPool,
    folded: FoldedControl | undefined,
    primary: ReturnType<typeof localIdentity>,
  ): Promise<void> {
    const wraps = await pool
      .query([
        { kinds: [KIND_WRAP], authors: severanceStreamKeys(community).map((k) => k.pk), limit: SEVERANCE_WRAP_CAP },
      ])
      .catch((error: unknown) => {
        console.warn(`bridge ${row.bridge_id}: severance probe failed:`, error);
        return [] as NostrEvent[];
      });
    const verdict = detectSeverance({
      wraps,
      community,
      me: primary.pk,
      folded,
      joinedAtMs: row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at)),
    });
    if (!verdict) return;
    await this.applySeverance(row.bridge_id, verdict, community);
    throw new SeveredError(verdict);
  }

  /**
   * A bridge that started clean is not cut off. Separate from
   * clearStartFailure: the streak marker is transient bookkeeping, this is the
   * severance record — cleared only so a resumed bridge's row stops
   * advertising why it was severed the moment it is back.
   */
  private async clearSeveredReason(row: BridgeRow): Promise<void> {
    if (!row.community_id) return;
    await this.sql`
      UPDATE communities SET severed_reason = NULL
      WHERE tenant_id = 'default' AND community_id = ${row.community_id}
        AND severed_reason IS NOT NULL`;
  }

  /** How many bridges are running in this process. */
  get liveCount(): number {
    return this.running.size;
  }

  isLive(bridgeId: string): boolean {
    return this.running.has(bridgeId);
  }

  /** The live router + link for a Discord channel (history backfill hook). */
  routerFor(discordChannelId: string): { router: BridgeRouter; link: ChannelLink } | undefined {
    const rb = this.activeRouterFor(discordChannelId);
    return rb?.router ? { router: rb.router, link: rb.link } : undefined;
  }

  /**
   * Re-fold the control plane for the live bridge on a Discord channel, so a
   * just-imported channel is known before the backfill publishes into it
   * (the fold at start() can precede the channel editions' propagation).
   */
  async resyncFor(discordChannelId: string): Promise<void> {
    const rb = this.activeRouterFor(discordChannelId);
    if (rb) await rb.client.syncControl();
  }

  /** Whether the live bridge's fold knows this Concord channel. */
  channelKnown(discordChannelId: string, concordChannelIdHex: string): boolean {
    const rb = this.activeRouterFor(discordChannelId);
    return rb?.client.channel(concordChannelIdHex) !== undefined;
  }

  /**
   * Any `/command` posted in a bridged channel gets handled or answered
   * (never silently swallowed): /help and unknown commands get the same help
   * text. Unbridged channels stay silent.
   *
   * Only a human typing in Discord issues a command. Our webhook relays
   * Armada messages verbatim, so a `/claim` sent from Armada arrives here as
   * a webhook post; answering it — or any bot, our own replies included —
   * let a reply that itself began with `/claim` re-trigger forever.
   */
  private handleBotCommand(message: import("discord.js").Message): boolean {
    if (message.author.bot || message.webhookId) return false;
    const command = parseBotCommand(message.content);
    if (!command) return false;
    const rb = this.activeRouterFor(message.channelId);
    if (!rb) return false; // not ours: stay silent, another bot may own it
    void this.replyToCommand(message, command, rb).catch((error) =>
      console.error(`portal: /${command} reply failed`, error),
    );
    return true;
  }

  private async replyToCommand(
    message: import("discord.js").Message,
    command: string,
    rb: Running,
  ): Promise<void> {
    await rb.assertMayForward();
    if (command === "help") {
      await message.reply(this.helpText());
      return;
    }
    await message.reply(`Unknown command /${command}. ${this.helpText()}`);
  }

  private helpText(): string {
    return "Commands: /bridge confirm <code> approves a pending bridge link (Armada side).";
  }
}
