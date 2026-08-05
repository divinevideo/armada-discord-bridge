/**
 * BridgeManager: the portal's data plane. Owns one Discord gateway (one bot
 * application serves every bridge) and, per bridge, a headless Concord
 * client. Drives the lifecycle: draft -> pending_confirm (in-channel code)
 * -> active (routing attached) -> paused/severed/unlinked.
 *
 * The in-channel confirm is the Armada side's consent gate: only a member
 * holding MANAGE_CHANNELS (or the owner) can flip a bridge live, and the
 * portal cannot bypass it.
 */

import { randomBytes } from "node:crypto";
import {
  Permissions,
  STOCK_RELAYS,
  inviteDeliveryRelays,
  isAuthorized,
  parseInviteLink,
} from "@armada-bridge/concord-core";
import type { ChannelV2, OpenedChat } from "@armada-bridge/concord-core";
import { BlossomStore } from "@armada-bridge/bridge/src/blossom";
import { ConcordClient, resolveInvite } from "@armada-bridge/bridge/src/concord/client";
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
import type postgres from "postgres";

import type { PortalEnv } from "./env";
import { seal, unseal } from "./seal";

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
}

interface Running {
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
}

export const CONFIRM_RE = /^\/bridge confirm ([0-9a-f]{8})$/i;

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
    name: "claim",
    description: "Link your Discord identity to your own npub (run it on the Discord side).",
  },
  {
    name: "help",
    description: "What this bridge bot does and which commands it answers.",
  },
];

export class BridgeManager {
  private adapter?: DiscordAdapter;
  private readonly running = new Map<string, Running>();
  private readonly byDiscordChannel = new Map<string, string>();
  /** One shared store: mapping rows for every router, plus catch-up cursors. */
  private readonly store: PostgresMappingStore;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly env: PortalEnv,
  ) {
    this.store = new PostgresMappingStore(sql);
  }

  async init(): Promise<void> {
    if (this.env.discordBotToken) {
      try {
        this.adapter = new DiscordAdapter(this.env.discordBotToken, {
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
        });
        await this.adapter.start();
        console.log("portal: discord gateway up");
      } catch (error) {
        // Common cause: MESSAGE_CONTENT privileged intent not enabled on the
        // bot ("Used disallowed intents"). The portal stays up so the rest of
        // the flow keeps working; fix the app settings and restart.
        this.adapter = undefined;
        console.error("portal: discord gateway failed to start:", error);
      }
    } else {
      console.warn("portal: DISCORD_TOKEN not set; bridges cannot go live");
    }
    const rows = await this.sql<BridgeRow[]>`
      SELECT * FROM bridges WHERE status IN ('pending_confirm', 'active')`;
    for (const row of rows) {
      await this.start(row).catch((error) => this.markSevered(row.bridge_id, String(error)));
    }
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
    const bootstrap = new RelayPool(invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS);
    try {
      const { community } = await resolveInvite(inviteUrl, bootstrap);
      const pool = new RelayPool(community.relays);
      try {
        const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
        await client.syncControl();
        return {
          community: { idHex: community.idHex, name: community.name, relays: community.relays },
          channels: client.channels().map((c) => ({ idHex: c.idHex, name: c.name })),
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
    const candidate = seal(this.env.sealKeyHex, randomBytes(32).toString("hex"));
    await this.sql`
      INSERT INTO guild_community_secrets (community_id, discord_guild_id, master_secret_sealed)
      VALUES (${communityId}, ${guildId}, ${candidate})
      ON CONFLICT (community_id, discord_guild_id) DO NOTHING`;
    const [row] = await this.sql<{ master_secret_sealed: Uint8Array }[]>`
      SELECT master_secret_sealed FROM guild_community_secrets
      WHERE community_id = ${communityId} AND discord_guild_id = ${guildId}`;
    return row.master_secret_sealed;
  }

  /** Mint per-bridge secrets and move draft -> pending_confirm. */
  async activate(row: BridgeRow): Promise<void> {
    if (!row.community_id || !row.discord_guild_id) {
      throw new Error("bridge must be linked (community + guild) before activation");
    }
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
   * consent the confirm gate exists for is implicit (plan D4).
   */
  /**
   * Mint the bridge's identity and mark it active, WITHOUT starting it.
   *
   * Split out from {@link activateImported} because a private channel's key has
   * to reach this npub before the bridge boots: `start()` takes key delivery
   * exactly once, at boot (see keyIntake.ts). A bridge started first simply
   * cannot see the channel, and would sit there mirroring nothing.
   */
  async provisionImported(row: BridgeRow): Promise<BridgeRow> {
    if (!row.community_id || !row.discord_guild_id) {
      throw new Error("bridge must be linked (community + guild) before activation");
    }
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
    if (!row.invite_url_sealed || !row.master_secret_sealed || !row.primary_sk_sealed) {
      throw new Error("bridge is missing sealed key material");
    }
    const inviteUrl = unseal(this.env.sealKeyHex, row.invite_url_sealed);
    const invite = parseInviteLink(inviteUrl);
    if (!invite) throw new Error("stored invite no longer parses");

    const bootstrap = new RelayPool(invite.bootstrapRelays.length ? invite.bootstrapRelays : STOCK_RELAYS);
    const { community } = await resolveInvite(inviteUrl, bootstrap).finally(() => void bootstrap.close());

    const pool = new RelayPool(community.relays);
    const primarySkHex = unseal(this.env.sealKeyHex, row.primary_sk_sealed);
    const primary = localIdentity(Uint8Array.from(Buffer.from(primarySkHex, "hex")));

    // Private-channel keys granted to THIS bridge's npub since it was linked,
    // delivered as Direct Invites (see keyIntake.ts). Runs before the fold so
    // a gated channel is present in `client.channels()` on the first pass.
    const floor = new RelayPool(inviteDeliveryRelays([]));
    const intake = await intakeDirectInviteKeys([pool, floor], primary, community).finally(
      () => void floor.close(),
    );

    const client = new ConcordClient(intake.community, pool, primary);
    await client.syncControl();

    const channel = row.concord_channel_id ? client.channel(row.concord_channel_id) : undefined;
    if (!channel) {
      await pool.close();
      throw new Error("concord channel not found (deleted, or key not held)");
    }
    // Refresh display names each start: renames heal on the next boot, and
    // rows from before the name columns existed backfill themselves.
    const discordName = row.discord_channel_id
      ? await this.adapter?.channelName(row.discord_channel_id).catch(() => null)
      : null;
    const guildName = row.discord_guild_id
      ? await this.adapter?.guildName(row.discord_guild_id).catch(() => null)
      : null;
    await this.sql`
      UPDATE bridges SET concord_channel_name = ${channel.name},
        discord_channel_name = ${discordName ?? null},
        discord_guild_name = ${guildName ?? null}
      WHERE bridge_id = ${row.bridge_id}`;
    await client.publishJoin().catch(() => {});
    // Our giftwrap inbox, so the next key handoff is delivered to the relays
    // we actually watch rather than the stock interop floor.
    await client.publishDmRelays(primary, community.relays).catch(() => {});
    await client
      .publishProfile(primary, {
        name: "Discord <-> Armada Bridge Bot",
        picture: this.adapter?.botAvatarUrl,
        about:
          "Automated bridge account: posts link confirmations and mirrors this channel with a Discord server.",
        bot: true,
      })
      .catch(() => {});
    await client.publishManifest(BRIDGE_COMMANDS).catch(() => {});

    const link: ChannelLink = {
      discordGuildId: row.discord_guild_id ?? "",
      discordChannelId: row.discord_channel_id ?? "",
      communityId: community.idHex,
      concordChannelIdHex: channel.idHex,
      enabled: true,
    };

    const rb: Running = {
      id: row.bridge_id,
      client,
      pool,
      channel,
      link,
      primary,
      status: row.status === "active" ? "active" : "pending_confirm",
      unsubChat: () => {},
      unsubControl: () => {},
    };

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
    // Re-subscribe whenever the fold changes the channel's stream set.
    rb.unsubControl = client.subscribeControl(() => {
      this.refreshChatSubscription(rb, row.confirm_code ?? "");
    });

    if (rb.status === "active") {
      this.attachRouting(rb, unseal(this.env.sealKeyHex, row.master_secret_sealed), row.options);
      this.backfillMissed(rb).catch((error) =>
        console.warn(`bridge ${rb.id}: catch-up backfill failed:`, error),
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
    this.running.set(rb.id, rb);
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

  /** Tear down and rebuild the chat REQ when the channel's stream set changes. */
  private refreshChatSubscription(rb: Running, confirmCode: string): void {
    const fresh = rb.client.channel(rb.link.concordChannelIdHex);
    if (!fresh) return; // channel left the fold; severance detection is separate work
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

      const [row] = await this.sql<BridgeRow[]>`
        UPDATE bridges SET status = 'active', status_detail = NULL, updated_at = now()
        WHERE bridge_id = ${rb.id} RETURNING *`;
      rb.status = "active";
      this.attachRouting(rb, unseal(this.env.sealKeyHex, row.master_secret_sealed!), row.options);
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
    if (!this.adapter) {
      void this.markSevered(rb.id, "no Discord bot token configured");
      return;
    }
    rb.router = new BridgeRouter(
      rb.client,
      new PuppetCache(masterSecretHex),
      this.store,
      this.adapter,
      new Kind0ProfileResolver(rb.pool),
      { applicationId: this.adapter.applicationId, webhookIds: this.adapter.ownWebhookIds },
      {
        bridgeEdits: options?.edits === true,
        blobs: this.env.blossomServer ? new BlossomStore(this.env.blossomServer) : undefined,
      },
    );
    this.byDiscordChannel.set(rb.link.discordChannelId, rb.id);
    this.announceBridge(rb).catch(() => {});
  }

  /**
   * One-time welcome in both directions when a bridge goes live: tells
   * everyone the channel is mirrored and teaches /claim. Fire-and-forget.
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
        content:
          "This channel is now mirrored with Discord. Members can run /claim there " +
          "to connect their Discord account to their Armada account.",
        author: rb.primary,
      })
      .catch(() => {});
    await this.adapter!.send(rb.link, {
      username: "Armada Bridge",
      content:
        "This channel is now mirrored with an Armada community. " +
        "Run /claim to connect your Discord account to your Armada account " +
        "(your history, roles, and puppet key), or /help for commands.",
    }).catch(() => {});
  }

  async stop(bridgeId: string, status: "paused" | "unlinked", detail?: string): Promise<void> {
    const rb = this.running.get(bridgeId);
    if (rb) {
      rb.unsubChat();
      rb.unsubControl();
      await rb.pool.close().catch(() => {});
      this.byDiscordChannel.delete(rb.link.discordChannelId);
      this.running.delete(bridgeId);
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
    const next = row.confirm_code && !this.running.has(bridgeId) ? "pending_confirm" : "active";
    await this.sql`UPDATE bridges SET status = ${row.status === "paused" ? "active" : next}, updated_at = now() WHERE bridge_id = ${bridgeId}`;
    const [fresh] = await this.sql<BridgeRow[]>`SELECT * FROM bridges WHERE bridge_id = ${bridgeId}`;
    await this.start(fresh).catch((error) => this.markSevered(bridgeId, String(error)));
  }

  private async markSevered(bridgeId: string, detail: string): Promise<void> {
    console.error(`bridge ${bridgeId}: severed: ${detail}`);
    await this.sql`
      UPDATE bridges SET status = 'severed', status_detail = ${detail}, updated_at = now()
      WHERE bridge_id = ${bridgeId}`;
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
   * (never silently swallowed): /claim is the one real command today; /help
   * and unknown commands get the same help text. Unbridged channels stay
   * silent.
   */
  private handleBotCommand(message: import("discord.js").Message): boolean {
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
    if (command === "help") {
      await message.reply(this.helpText());
      return;
    }
    if (command !== "claim") {
      await message.reply(`Unknown command /${command}. ${this.helpText()}`);
      return;
    }
    const [existing] = await this.sql<{ npub: string }[]>`
      SELECT npub FROM claims
      WHERE community_id = ${rb.link.communityId} AND discord_user_id = ${message.author.id}`;
    if (existing) {
      await message.reply(`You've already claimed ${existing.npub.slice(0, 12)}… in this community.`);
      return;
    }
    // A one-time code bound to the INVOKING user: only the Discord account
    // that asked can claim the npub, even if the link is forwarded.
    const code = randomBytes(4).toString("hex");
    await this.sql`
      INSERT INTO claim_codes (code, community_id, discord_guild_id, discord_user_id)
      VALUES (${code}, ${rb.link.communityId}, ${rb.link.discordGuildId}, ${message.author.id})
      ON CONFLICT (code) DO NOTHING`;
    await message.reply(
      `Claim your bridged history: open ${this.env.baseUrl}/claim/${rb.link.communityId} and enter code ${code} (expires in 30 minutes).`,
    );
  }

  private helpText(): string {
    return "Commands: /claim connects your Discord account to your Armada account (your history, roles, and puppet key).";
  }
}
