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
    const id = this.byDiscordChannel.get(msg.channelId);
    const rb = id ? this.running.get(id) : undefined;
    if (!rb?.router || rb.status !== "active") return;
    await rb.router.onDiscordMessage(msg, rb.link);
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

  /** Mint per-bridge secrets and move draft -> pending_confirm. */
  async activate(row: BridgeRow): Promise<void> {
    const masterSecret = randomBytes(32).toString("hex");
    const primarySk = generateSecretKey();
    const primary = localIdentity(primarySk);
    const confirmCode = randomBytes(4).toString("hex");

    await this.sql`
      UPDATE bridges SET
        master_secret_sealed = ${seal(this.env.sealKeyHex, masterSecret)},
        primary_sk_sealed = ${seal(this.env.sealKeyHex, bytesToHex(primarySk))},
        primary_pk = ${primary.pk},
        confirm_code = ${confirmCode},
        status = 'pending_confirm', status_detail = NULL, updated_at = now()
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
      unsubControl: client.subscribeControl(),
    };

    rb.unsubChat = client.subscribeChannel(channel, (chat) => {
      void this.onConcordChat(rb, chat, row.confirm_code ?? "").catch((error) =>
        console.error(`bridge ${rb.id}: concord handler failed`, error),
      );
    });

    if (rb.status === "active") {
      this.attachRouting(rb, unseal(this.env.sealKeyHex, row.master_secret_sealed));
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
      this.attachRouting(rb, unseal(this.env.sealKeyHex, row.master_secret_sealed!));
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

  private attachRouting(rb: Running, masterSecretHex: string): void {
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
}
