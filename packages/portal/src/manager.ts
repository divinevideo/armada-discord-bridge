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
  isAuthorized,
  parseInviteLink,
} from "@armada-bridge/concord-core";
import type { ChannelV2, OpenedChat } from "@armada-bridge/concord-core";
import { BlossomStore } from "@armada-bridge/bridge/src/blossom";
import { ConcordClient, resolveInvite } from "@armada-bridge/bridge/src/concord/client";
import { RelayPool } from "@armada-bridge/bridge/src/concord/pool";
import { localIdentity } from "@armada-bridge/bridge/src/concord/signer";
import { PostgresMappingStore } from "@armada-bridge/bridge/src/db/store";
import { DiscordAdapter } from "@armada-bridge/bridge/src/discord/adapter";
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

export class BridgeManager {
  private adapter?: DiscordAdapter;
  private readonly running = new Map<string, Running>();
  private readonly byDiscordChannel = new Map<string, string>();

  constructor(
    private readonly sql: postgres.Sql,
    private readonly env: PortalEnv,
  ) {}

  async init(): Promise<void> {
    if (this.env.discordBotToken) {
      try {
        this.adapter = new DiscordAdapter(this.env.discordBotToken, {
          onMessage: async (msg) => this.onDiscord(msg),
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
  async activateImported(row: BridgeRow): Promise<void> {
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
    await this.start(fresh);
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
    const client = new ConcordClient(community, pool, primary);
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
    await client
      .publishProfile(primary, {
        name: "Discord <-> Armada Bridge Bot",
        picture: this.adapter?.botAvatarUrl,
        about:
          "Automated bridge account: posts link confirmations and mirrors this channel with a Discord server.",
        bot: true,
      })
      .catch(() => {});

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
    );
    // A rekey (epoch bump) mints new stream keys; a REQ pinned to the old
    // ones goes silent while publishes (fresh channel lookup) keep working.
    // Re-subscribe whenever the fold changes the channel's stream set.
    rb.unsubControl = client.subscribeControl(() => {
      this.refreshChatSubscription(rb, row.confirm_code ?? "");
    });

    if (rb.status === "active") {
      this.attachRouting(rb, unseal(this.env.sealKeyHex, row.master_secret_sealed), row.options);
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
    if (rb.router) await rb.router.onConcordChat(chat, rb.link);
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
      new PostgresMappingStore(this.sql),
      this.adapter,
      new Kind0ProfileResolver(rb.pool),
      { applicationId: this.adapter.applicationId, webhookIds: this.adapter.ownWebhookIds },
      {
        bridgeEdits: options?.edits === true,
        blobs: this.env.blossomServer ? new BlossomStore(this.env.blossomServer) : undefined,
      },
    );
    this.byDiscordChannel.set(rb.link.discordChannelId, rb.id);
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
}
