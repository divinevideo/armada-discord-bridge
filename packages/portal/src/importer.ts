/**
 * Server importer (armada-server-import-PLAN.md): snapshot a Discord guild,
 * preview the mapping, then mint a brand-new Armada community and publish its
 * control-plane editions — metadata, channels, roles, a public invite — and
 * wire live bridges for the selected text channels.
 *
 * Ownership: the USER's real Nostr key is the community owner (position 0,
 * baked into the community_id). The genesis authority chain is owner-signed
 * in the browser (Armada-style: the key never leaves the client): the owner
 * signs the stock Admin role, a grant handing that role to the portal's
 * OPERATIONAL key, their invite registry, and their guestbook join. The
 * operational key then publishes everything else (metadata, channels,
 * imported roles) citing that grant (`vac`), and the owner can revoke it
 * from Armada at any time.
 *
 * Every publish step checkpoints into the plan jsonb, so a crashed or failed
 * import resumes idempotently; a duplicate v1 edition is harmless (same
 * content, fold tiebreak).
 */

import {
  KIND_INVITE_BUNDLE,
  KIND_SEAL_ENCRYPTED,
  KIND_SEAL_PLAINTEXT,
  STOCK_RELAYS,
  adminRole,
  buildBundleEvent,
  buildChannelEdition,
  buildGrantEdition,
  buildInviteUrl,
  buildJoinRumor,
  buildMetadataEdition,
  buildRegistryEdition,
  buildRoleEdition,
  bytesToHex,
  capRelays,
  communityIdOf,
  controlGroups,
  currentControlGroup,
  currentGuestbookGroup,
  editionHash,
  grantLocator,
  grantToJSON,
  guestbookGroups,
  hex32,
  mintCommunity,
  mintLinkSigner,
  mintToken,
  parseInviteLink,
  random32,
  registerStreamKeys,
  sealEdition,
  sealGuestbook,
  wrapSeal,
} from "@armada-bridge/concord-core";
import type { AuthorityCitation, CommunityV2, InviteBundle, Rumor } from "@armada-bridge/concord-core";
import { BlossomStore } from "@armada-bridge/bridge/src/blossom";
import { RelayPool } from "@armada-bridge/bridge/src/concord/pool";
import type { RelayLike } from "@armada-bridge/bridge/src/concord/pool";
import { localIdentity } from "@armada-bridge/bridge/src/concord/signer";
import type { LocalIdentity } from "@armada-bridge/bridge/src/concord/signer";
import { discordEmojiUrl } from "@armada-bridge/bridge/src/router";
import type { DiscordInboundMessage } from "@armada-bridge/bridge/src/router";
import { derivePuppet } from "@armada-bridge/bridge/src/puppets";
import { sha256 } from "@noble/hashes/sha2.js";
import { createCipheriv, randomBytes } from "node:crypto";
import { encrypt as nip44Encrypt } from "nostr-tools/nip44";
import * as nip19 from "nostr-tools/nip19";
import { generateSecretKey, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import type postgres from "postgres";

import { fetchMyGuildMember } from "./discordRest";
import { botChannelMessagesBefore, botGuildSnapshot, botInstallUrl } from "./discordRest";
import type { RestMessage } from "./discordRest";
import type { PortalEnv } from "./env";
import { HISTORY_MESSAGE_CAP, buildImportPlan } from "./importPlan";
import type { ImportPlan, OwnerSignTemplate, PlannedChannel, SignedSeal } from "./importPlan";
import type { BridgeManager, BridgeRow } from "./manager";
import { seal, unseal } from "./seal";

export interface ImportRow {
  import_id: string;
  owner_discord_id: string;
  discord_guild_id: string;
  discord_guild_name: string | null;
  status: string;
  status_detail: string | null;
  plan: ImportPlan;
  owner_sk_sealed: Uint8Array | null;
  community_sealed: Uint8Array | null;
  community_id: string | null;
  invite_url_sealed: Uint8Array | null;
  link_signer_sk_sealed: Uint8Array | null;
}

export interface PrepareBody {
  /** The user's Armada account (npub or 64-hex): the community OWNER. */
  ownerNpub?: string;
  /** Community relay set; defaults to IMPORT_DEFAULT_RELAYS, then stock. */
  relays?: string[];
  /** Per-channel toggles keyed by Discord channel id. */
  channels?: Array<{ discordId: string; selected?: boolean; bridge?: boolean; history?: boolean }>;
}

export interface ClaimTarget {
  communityId: string;
  communityName: string;
  guildId: string;
  messageCount: number;
}

export interface ClaimBody {
  npub?: string;
  /** kind 30078 signed by the npub, content exactly the challenge string. */
  signedProof?: SignedSeal;
  /** Which levels to run. */
  levels?: { link?: boolean; roles?: boolean; key?: boolean };
  /** The one-time code the bot handed to the invoking Discord user. */
  code?: string;
}

const KIND_CLAIM_PROOF = 30078;

/** The exact content the claimant signs; versioned, community-scoped. */
export function claimChallenge(communityId: string, discordUserId: string): string {
  return `armada-bridge claim v1\ncommunity ${communityId}\ndiscord ${discordUserId}`;
}

export interface ConfirmBody {
  /** The owner-signed seals, in the same order as the prepared templates. */
  signedEvents?: SignedSeal[];
}

/** npub1… or bare 64-hex → lowercase hex; undefined when unparseable. */
export function parseAdminPubkey(input: string): string | undefined {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === "npub" ? (decoded.data as string) : undefined;
  } catch {
    return undefined;
  }
}

/** The community identity + access secrets sealed into `community_sealed`. */
interface CommunitySecrets {
  owner_salt: string;
  community_root: string;
}

/** Mirror of sealRumor's PLAINTEXT template: what the owner actually signs. */
function plaintextSealTemplate(rumor: Rumor): OwnerSignTemplate["template"] {
  return { kind: KIND_SEAL_PLAINTEXT, content: JSON.stringify(rumor), tags: [], created_at: rumor.created_at };
}

/** The Armada client's stock blob host, used when BLOSSOM_SERVER is unset. */
const DEFAULT_BLOSSOM = "https://blossom.ditto.pub";

/** A REST history message -> the router's inbound shape (same as gateway). */
export function restToInbound(message: RestMessage, guildId: string, channelId: string): DiscordInboundMessage {
  return {
    id: message.id,
    channelId,
    guildId,
    content: message.content ?? "",
    author: {
      id: message.author.id,
      display: message.author.global_name || message.author.username,
      avatarUrl: message.author.avatar
        ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png`
        : undefined,
      bot: message.author.bot === true,
    },
    webhookId: message.webhook_id,
    applicationId: message.application_id ?? undefined,
    referencedMessageId: message.message_reference?.message_id,
    timestampMs: Date.parse(message.timestamp),
    attachments: message.attachments?.map((a) => ({ url: a.url, filename: a.filename })),
    embeds: message.embeds?.map((e) => ({
      url: e.url,
      mediaUrl: e.video?.url ?? e.image?.url ?? e.thumbnail?.url,
    })),
    mentions: message.mentions?.map((m) => ({ id: m.id, display: m.global_name || m.username })),
  };
}

/** Largest icon/banner we bother rehosting. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

interface ImagePointerJson {
  url: string;
  key: string;
  nonce: string;
  hash: string;
}

/**
 * Rehost one Discord CDN image as a Concord encrypted-blob pointer
 * (CORD-02 §6, matching the Armada client's WebCrypto layout): AES-256-GCM
 * under a fresh 32-byte key + 16-byte nonce with the auth tag appended, the
 * HOST stores ciphertext, and `hash` is the SHA-256 of the PLAINTEXT so a
 * swapped blob fails closed.
 */
async function rehostEncryptedImage(
  sourceUrl: string,
  blossom: BlossomStore,
  uploader: LocalIdentity,
): Promise<ImagePointerJson> {
  const { data } = await blossom.download(sourceUrl, MAX_ASSET_BYTES);
  const key = randomBytes(32);
  const nonce = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const uploaded = await blossom.upload(new Uint8Array(ciphertext), "application/octet-stream", uploader);
  return {
    url: uploaded.url,
    key: key.toString("hex"),
    nonce: nonce.toString("hex"),
    hash: bytesToHex(sha256(data)),
  };
}

export class Importer {
  /** Imports with a pipeline currently running in this process. */
  private readonly running = new Set<string>();

  constructor(
    private readonly sql: postgres.Sql,
    private readonly env: PortalEnv,
    private readonly manager: BridgeManager,
    /** Test seam: swap the relay pool for an in-memory wire. */
    private readonly poolFactory: (relays: string[]) => RelayLike = (relays) => new RelayPool(relays),
    /** Test seam: history pages without the Discord REST API. */
    private readonly historyFetch: (
      channelId: string,
      beforeId?: string,
    ) => Promise<RestMessage[] | undefined> = (channelId, beforeId) =>
      botChannelMessagesBefore(this.env.discordBotToken, channelId, beforeId),
  ) {}

  /** Snapshot the guild and store a previewed plan. */
  async preview(
    ownerDiscordId: string,
    guildId: string,
  ): Promise<
    | { present: false; installUrl: string }
    | { present: true; importId: string; plan: ImportPlan; defaultRelays: string[] }
  > {
    if (!this.env.discordBotToken) throw new Error("bot token not configured");
    const snapshot = await botGuildSnapshot(this.env.discordBotToken, guildId);
    if (!snapshot) {
      return { present: false, installUrl: botInstallUrl(this.env.discordClientId, guildId) };
    }
    const plan = buildImportPlan(snapshot);
    const [row] = await this.sql<ImportRow[]>`
      INSERT INTO imports (owner_discord_id, discord_guild_id, discord_guild_name, plan)
      VALUES (${ownerDiscordId}, ${guildId}, ${snapshot.guild.name}, ${this.sql.json(plan as never)})
      RETURNING *`;
    return {
      present: true,
      importId: row.import_id,
      plan,
      defaultRelays: this.env.importRelays.length ? this.env.importRelays : STOCK_RELAYS,
    };
  }

  async get(importId: string, ownerDiscordId: string): Promise<(ImportRow & { inviteUrl?: string }) | undefined> {
    const [row] = await this.sql<ImportRow[]>`
      SELECT * FROM imports WHERE import_id = ${importId} AND owner_discord_id = ${ownerDiscordId}`;
    if (!row) return undefined;
    const inviteUrl =
      row.status === "done" && row.invite_url_sealed
        ? unseal(this.env.sealKeyHex, row.invite_url_sealed)
        : undefined;
    return { ...row, inviteUrl };
  }

  /**
   * Apply the user's selections, mint the community under THEIR key, and
   * return the seal templates the owner must sign in the browser.
   */
  async prepare(
    importId: string,
    ownerDiscordId: string,
    body: PrepareBody,
  ): Promise<{ ownerPk: string; templates: OwnerSignTemplate[] }> {
    const [row] = await this.sql<ImportRow[]>`
      SELECT * FROM imports WHERE import_id = ${importId} AND owner_discord_id = ${ownerDiscordId}`;
    if (!row) throw new Error("no such import");
    if (row.status !== "previewed" && row.status !== "awaiting_sigs") {
      throw new Error(`import is ${row.status}, not previewed`);
    }

    const ownerPk = parseAdminPubkey(body.ownerNpub ?? "");
    if (!ownerPk) throw new Error("connect your Armada account (npub) first");

    const plan = row.plan;
    for (const toggle of body.channels ?? []) {
      const channel = plan.channels.find((c) => c.discordId === toggle.discordId);
      if (!channel) continue;
      if (toggle.selected !== undefined) channel.selected = toggle.selected;
      if (toggle.bridge !== undefined) channel.bridge = toggle.bridge && channel.bridgeable;
      if (toggle.history !== undefined) channel.history = toggle.history && channel.bridgeable && plan.historyAllowed;
      if (!channel.selected) channel.bridge = false;
      if (!channel.bridge) channel.history = false;
    }
    if (!plan.channels.some((c) => c.selected)) throw new Error("select at least one channel");

    const requested = (body.relays ?? []).map((r) => r.trim()).filter(Boolean);
    for (const relay of requested) {
      if (!/^wss?:\/\//.test(relay)) throw new Error(`not a relay URL: ${relay}`);
    }
    plan.relays = capRelays(
      requested.length ? requested : this.env.importRelays.length ? this.env.importRelays : STOCK_RELAYS,
    );

    // Mint under the USER's key. Re-preparing (e.g. the user reconnected a
    // different account) re-mints from scratch: nothing has been published.
    const opSk = generateSecretKey();
    const op = localIdentity(opSk);
    const { community } = mintCommunity(plan.communityName, ownerPk, plan.relays);
    for (const channel of plan.channels) {
      channel.channelIdHex = channel.selected ? bytesToHex(random32()) : undefined;
    }
    for (const role of plan.roles) role.roleIdHex = bytesToHex(random32());
    const token = mintToken();
    const link = mintLinkSigner();

    plan.checkpoints = {
      communityIdHex: community.idHex,
      ownerPkHex: ownerPk,
      opPkHex: op.pk,
      adminRoleIdHex: bytesToHex(random32()),
      inviteLinkSignerPk: link.pk,
    };

    // The owner's genesis signatures: Admin role, the op grant, their invite
    // registry, their guestbook join. Everything else the op key signs with a
    // vac citation of that grant.
    const nowSecs = Math.floor(Date.now() / 1000);
    const v1 = (actor: string) => ({ actorPubkey: actor, version: 1n, createdAtSecs: nowSecs });
    const roleRumor = buildRoleEdition(adminRole(plan.checkpoints.adminRoleIdHex!), v1(ownerPk));
    const grant = { member: op.pk, roleIds: [plan.checkpoints.adminRoleIdHex!] };
    const grantRumor = buildGrantEdition(community.id, grant, v1(ownerPk));
    const registryRumor = buildRegistryEdition(community.id, ownerPk, [link.pk], v1(ownerPk));
    const joinRumor = buildJoinRumor(ownerPk, Date.now());

    plan.checkpoints.grantHashHex = bytesToHex(
      editionHash(grantLocator(community.id, hex32(op.pk)), 1n, undefined, new TextEncoder().encode(grantToJSON(grant))),
    );

    const guestbook = currentGuestbookGroup(community);
    plan.checkpoints.ownerTemplates = [
      { purpose: "admin-role", template: plaintextSealTemplate(roleRumor) },
      { purpose: "op-grant", template: plaintextSealTemplate(grantRumor) },
      { purpose: "invite-registry", template: plaintextSealTemplate(registryRumor) },
      {
        purpose: "owner-join",
        template: {
          kind: KIND_SEAL_ENCRYPTED,
          content: nip44Encrypt(JSON.stringify(joinRumor), guestbook.convKey),
          tags: [],
          created_at: joinRumor.created_at,
        },
      },
    ];

    const secrets: CommunitySecrets = {
      owner_salt: bytesToHex(community.ownerSalt),
      community_root: bytesToHex(community.root),
    };
    const inviteUrl = buildInviteUrl(this.env.inviteBaseUrl, link.pk, token, community.relays);
    await this.sql`
      UPDATE imports SET
        owner_sk_sealed = ${seal(this.env.sealKeyHex, bytesToHex(opSk))},
        community_sealed = ${seal(this.env.sealKeyHex, JSON.stringify(secrets))},
        community_id = ${community.idHex},
        invite_url_sealed = ${seal(this.env.sealKeyHex, inviteUrl)},
        link_signer_sk_sealed = ${seal(this.env.sealKeyHex, bytesToHex(link.sk))},
        plan = ${this.sql.json(plan as never)},
        status = 'awaiting_sigs', status_detail = NULL, updated_at = now()
      WHERE import_id = ${importId}`;
    return { ownerPk, templates: plan.checkpoints.ownerTemplates };
  }

  /** Verify the owner's signatures against the prepared templates and launch. */
  async confirm(importId: string, ownerDiscordId: string, body: ConfirmBody): Promise<void> {
    const [row] = await this.sql<ImportRow[]>`
      SELECT * FROM imports WHERE import_id = ${importId} AND owner_discord_id = ${ownerDiscordId}`;
    if (!row) throw new Error("no such import");
    if (row.status !== "awaiting_sigs") throw new Error(`import is ${row.status}, not awaiting signatures`);

    const plan = row.plan;
    const templates = plan.checkpoints.ownerTemplates ?? [];
    const signed = body.signedEvents ?? [];
    if (signed.length !== templates.length) {
      throw new Error(`expected ${templates.length} signed events, got ${signed.length}`);
    }
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i].template;
      const s = signed[i];
      if (
        s.kind !== t.kind ||
        s.content !== t.content ||
        s.created_at !== t.created_at ||
        JSON.stringify(s.tags) !== JSON.stringify(t.tags)
      ) {
        throw new Error(`signed event ${i} does not match the prepared template (${templates[i].purpose})`);
      }
      if (s.pubkey !== plan.checkpoints.ownerPkHex) {
        throw new Error(`signed event ${i} is signed by the wrong key`);
      }
      if (!verifyEvent(s as NostrEvent)) {
        throw new Error(`signed event ${i} has an invalid signature`);
      }
    }
    plan.checkpoints.ownerSignedSeals = signed;

    await this.sql`
      UPDATE imports SET plan = ${this.sql.json(plan as never)}, status = 'publishing',
        status_detail = NULL, updated_at = now()
      WHERE import_id = ${importId}`;
    this.launch(importId);
  }

  /** Re-run a failed import from its checkpoints. */
  async retry(importId: string, ownerDiscordId: string): Promise<void> {
    const [row] = await this.sql<ImportRow[]>`
      SELECT * FROM imports WHERE import_id = ${importId} AND owner_discord_id = ${ownerDiscordId}`;
    if (!row) throw new Error("no such import");
    if (row.status !== "failed") throw new Error(`import is ${row.status}, not failed`);
    if (!row.plan.checkpoints.ownerSignedSeals) throw new Error("import has no signatures; start over");
    await this.sql`
      UPDATE imports SET status = 'publishing', status_detail = NULL, updated_at = now()
      WHERE import_id = ${importId}`;
    this.launch(importId);
  }

  private launch(importId: string): void {
    if (this.running.has(importId)) return;
    this.running.add(importId);
    void this.run(importId)
      .catch(async (error) => {
        console.error(`import ${importId}: failed:`, error);
        await this.sql`
          UPDATE imports SET status = 'failed', status_detail = ${String(error)}, updated_at = now()
          WHERE import_id = ${importId}`;
      })
      .finally(() => this.running.delete(importId));
  }

  // ── The pipeline ───────────────────────────────────────────────────────────

  private async run(importId: string): Promise<void> {
    const { community, opSk, plan } = await this.load(importId);
    await this.publishEditions(importId, community, opSk, plan);
    await this.wireBridges(importId, community, plan);
    await this.importHistory(importId, plan);
    await this.sql`
      UPDATE imports SET status = 'done', status_detail = NULL, updated_at = now()
      WHERE import_id = ${importId}`;
    console.log(`import ${importId}: done (community ${community.idHex})`);
  }

  /** Rebuild the community + operational key from the sealed genesis material. */
  private async load(importId: string): Promise<{ community: CommunityV2; opSk: Uint8Array; plan: ImportPlan }> {
    const [row] = await this.sql<ImportRow[]>`SELECT * FROM imports WHERE import_id = ${importId}`;
    if (!row) throw new Error("import row vanished");
    const plan = row.plan;
    const cp = plan.checkpoints;
    if (!row.owner_sk_sealed || !row.community_sealed || !cp.communityIdHex || !cp.ownerPkHex) {
      throw new Error("import was never prepared");
    }
    const opSk = Uint8Array.from(Buffer.from(unseal(this.env.sealKeyHex, row.owner_sk_sealed), "hex"));
    const secrets = JSON.parse(unseal(this.env.sealKeyHex, row.community_sealed)) as CommunitySecrets;
    const ownerSalt = hex32(secrets.owner_salt);
    const root = hex32(secrets.community_root);
    const id = communityIdOf(hex32(cp.ownerPkHex), ownerSalt);
    const community: CommunityV2 = {
      id,
      idHex: bytesToHex(id),
      owner: cp.ownerPkHex,
      ownerSalt,
      root,
      rootEpoch: 0n,
      heldRoots: [{ epoch: 0n, key: root }],
      privateChannels: [],
      relays: plan.relays,
      name: plan.communityName,
    };
    if (community.idHex !== cp.communityIdHex) {
      throw new Error("sealed community secrets do not reproduce the checkpointed community id");
    }
    return { community, opSk, plan };
  }

  /** Publish the owner's signed seals, then every op-key edition, then the invite. */
  private async publishEditions(
    importId: string,
    community: CommunityV2,
    opSk: Uint8Array,
    plan: ImportPlan,
  ): Promise<void> {
    await this.sql`
      UPDATE imports SET status = 'publishing', updated_at = now() WHERE import_id = ${importId}`;
    const cp = plan.checkpoints;
    const op = localIdentity(opSk);
    const control = currentControlGroup(community);
    const guestbook = currentGuestbookGroup(community);
    registerStreamKeys([...controlGroups(community), ...guestbookGroups(community)], community.relays);
    const pool = this.poolFactory(community.relays);
    const save = async () => {
      await this.sql`
        UPDATE imports SET plan = ${this.sql.json(plan as never)}, updated_at = now()
        WHERE import_id = ${importId}`;
    };
    // Every op-key action cites the owner-signed grant (CORD-04 §5).
    const vac: AuthorityCitation = {
      entityId: grantLocator(community.id, hex32(op.pk)),
      version: 1n,
      editionHash: hex32(cp.grantHashHex!),
    };
    const opV1 = { actorPubkey: op.pk, version: 1n, authority: vac };

    const ownerSeal = (purpose: OwnerSignTemplate["purpose"]): NostrEvent => {
      const i = (cp.ownerTemplates ?? []).findIndex((t) => t.purpose === purpose);
      const s = cp.ownerSignedSeals?.[i];
      if (i < 0 || !s) throw new Error(`missing owner signature for ${purpose}`);
      return s as NostrEvent;
    };

    try {
      // 1. The owner-signed authority chain, control plane first.
      if (!cp.ownerRolePublishedAt) {
        await pool.publish(wrapSeal(ownerSeal("admin-role"), control));
        cp.ownerRolePublishedAt = Date.now();
        await save();
      }
      if (!cp.ownerGrantPublishedAt) {
        await pool.publish(wrapSeal(ownerSeal("op-grant"), control));
        cp.ownerGrantPublishedAt = Date.now();
        await save();
      }
      if (!cp.ownerRegistryPublishedAt) {
        await pool.publish(wrapSeal(ownerSeal("invite-registry"), control));
        cp.ownerRegistryPublishedAt = Date.now();
        await save();
      }
      if (!cp.ownerJoinPublishedAt) {
        await pool.publish(wrapSeal(ownerSeal("owner-join"), guestbook));
        cp.ownerJoinPublishedAt = Date.now();
        await save();
      }

      // 2. Server icon + banner: rehosted as encrypted blobs before the
      // metadata edition that references them. Best effort — an unreachable
      // CDN or blob host costs the images, never the import.
      if (!cp.assetsAt && !cp.metadataPublishedAt) {
        const blossom = new BlossomStore(this.env.blossomServer || DEFAULT_BLOSSOM);
        try {
          if (plan.guild.iconUrl) {
            cp.iconPointer = await rehostEncryptedImage(plan.guild.iconUrl, blossom, op);
          }
          if (plan.guild.bannerUrl) {
            cp.bannerPointer = await rehostEncryptedImage(plan.guild.bannerUrl, blossom, op);
          }
        } catch (error) {
          cp.assetsError = String(error);
          console.error(`import ${importId}: icon/banner rehost failed:`, error);
        }
        cp.assetsAt = Date.now();
        await save();
      }

      // 3. The op key's editions, each citing the grant.
      if (!cp.metadataPublishedAt) {
        const metadata = {
          name: plan.communityName,
          ...(plan.guild.description ? { description: plan.guild.description } : {}),
          relays: community.relays,
          ...(cp.iconPointer ? { icon: cp.iconPointer } : {}),
          ...(cp.bannerPointer ? { banner: cp.bannerPointer } : {}),
          // Forward-compatible pointer to the guild emoji pack (30030).
          ...(plan.emojis.length > 0 ? { custom: { emojiPack: `30030:${op.pk}:discord-import` } } : {}),
        };
        await pool.publish(
          await sealEdition(buildMetadataEdition(community.id, metadata, opV1), control, op.signer),
        );
        cp.metadataPublishedAt = Date.now();
        await save();
      }

      let position = 0;
      for (const channel of plan.channels) {
        if (!channel.selected) continue;
        const thisPosition = position++;
        if (channel.publishedAt) continue;
        const custom: Record<string, unknown> = { position: thisPosition };
        if (channel.topic) custom.topic = channel.topic;
        if (channel.category) custom.category = channel.category;
        if (channel.kind) custom.kind = channel.kind;
        const metadata = { name: channel.name, private: false, custom };
        await pool.publish(
          await sealEdition(buildChannelEdition(hex32(channel.channelIdHex!), metadata, opV1), control, op.signer),
        );
        channel.publishedAt = Date.now();
        await save();
      }

      for (const role of plan.roles) {
        if (role.publishedAt) continue;
        await pool.publish(
          await sealEdition(
            buildRoleEdition(
              {
                roleId: role.roleIdHex!,
                name: role.name,
                position: role.position,
                permissions: BigInt(role.permissions),
                scope: { kind: "server" },
                color: role.color,
              },
              opV1,
            ),
            control,
            op.signer,
          ),
        );
        role.publishedAt = Date.now();
        await save();
      }

      // Guild custom emoji: one kind 30030 emoji-set event (NIP-30 pack)
      // members can add to their palette; stable CDN image URLs so bridged
      // reactions round-trip back to the native Discord emoji.
      if (plan.emojis.length > 0 && !cp.emojiPackPublishedAt) {
        await pool.publish(
          await op.signer.signEvent({
            kind: 30030,
            content: "",
            tags: [
              ["d", "discord-import"],
              ["title", `${plan.communityName} emoji`],
              ...plan.emojis.map((e) => ["emoji", e.name, discordEmojiUrl(e.id, e.animated)]),
            ],
            created_at: Math.floor(Date.now() / 1000),
          }),
        );
        cp.emojiPackAddress = `30030:${op.pk}:discord-import`;
        cp.emojiPackPublishedAt = Date.now();
        await save();
      }

      if (!cp.opJoinPublishedAt) {
        await pool.publish(await sealGuestbook(buildJoinRumor(op.pk, Date.now()), guestbook, op.signer));
        cp.opJoinPublishedAt = Date.now();
        await save();
      }

      if (!cp.profilePublishedAt) {
        await pool.publish(
          await op.signer.signEvent({
            kind: 0,
            content: JSON.stringify({
              name: `${plan.communityName} importer`,
              about:
                "Operational account of the Armada bridge portal: imported this community from Discord and runs its bridges. Holds an Admin role the owner can revoke.",
              bot: true,
            }),
            tags: [],
            created_at: Math.floor(Date.now() / 1000),
          }),
        );
        cp.profilePublishedAt = Date.now();
        await save();
      }

      // 4. The public invite bundle at the owner's registered link. Wiring
      // resolves this bundle back FROM the relays, so only checkpoint once a
      // readback proves it actually landed (any-accept publish + propagation
      // lag otherwise races bridge activation into "bundle not found").
      const [sealedRow] = await this.sql<ImportRow[]>`
        SELECT * FROM imports WHERE import_id = ${importId}`;
      if (!sealedRow?.invite_url_sealed || !sealedRow.link_signer_sk_sealed) {
        throw new Error("import lost its sealed invite material");
      }
      const linkSk = Uint8Array.from(Buffer.from(unseal(this.env.sealKeyHex, sealedRow.link_signer_sk_sealed), "hex"));
      const linkPk = cp.inviteLinkSignerPk!;
      const parsed = parseInviteLink(unseal(this.env.sealKeyHex, sealedRow.invite_url_sealed));
      if (!parsed) throw new Error("stored invite URL no longer parses");
      const bundle: InviteBundle = {
        community_id: community.idHex,
        owner: community.owner,
        owner_salt: bytesToHex(community.ownerSalt),
        community_root: bytesToHex(community.root),
        root_epoch: 0,
        channels: [],
        relays: community.relays,
        name: plan.communityName,
        creator_npub: community.owner,
        label: "Imported from Discord",
      };
      const bundleSeen = async () =>
        (await pool.query([{ kinds: [KIND_INVITE_BUNDLE], authors: [linkPk], limit: 1 }]).catch(() => []))
          .length > 0;
      let bundleVisible = await bundleSeen();
      for (let attempt = 0; attempt < 4 && !bundleVisible; attempt++) {
        await pool.publish(buildBundleEvent(bundle, parsed.token, linkSk)).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1500));
        bundleVisible = await bundleSeen();
      }
      if (!bundleVisible) {
        throw new Error("invite bundle did not become readable on the community relays; retry the import");
      }
      if (!cp.invitePublishedAt) {
        cp.invitePublishedAt = Date.now();
        await save();
      }
    } finally {
      await pool.close();
    }
  }

  // ── History backfill (armada-history-claims-PLAN.md §2) ───────────────────

  /**
   * Backfill the newest HISTORY_MESSAGE_CAP messages of every bridged
   * channel that opted in, oldest → newest so replies resolve, through the
   * SAME router the live bridge uses (same puppets, transforms, rehosting,
   * mapping rows). Only offered under the member-count gate (§2.2).
   */
  private async importHistory(importId: string, plan: ImportPlan): Promise<void> {
    if (!plan.historyAllowed) return;
    const channels = plan.channels.filter(
      (c) => c.selected && c.bridge && c.bridgeable && c.history && !c.historyDoneAt,
    );
    if (channels.length === 0) return;
    await this.sql`
      UPDATE imports SET status = 'history', updated_at = now() WHERE import_id = ${importId}`;
    for (const channel of channels) {
      await this.backfillChannel(importId, plan, channel);
    }
  }

  private async backfillChannel(importId: string, plan: ImportPlan, channel: PlannedChannel): Promise<void> {
    const running = this.manager.routerFor(channel.discordId);
    if (!running) {
      console.warn(`import ${importId}: no live bridge for #${channel.name}; history skipped`);
      channel.historyDoneAt = Date.now();
      await this.savePlan(importId, plan);
      return;
    }

    // Collect the newest cap-worth of messages, stopping at the resume
    // cursor (everything at/below it already published on a prior run).
    const cursor = channel.historyCursor ? BigInt(channel.historyCursor) : undefined;
    const collected: RestMessage[] = [];
    let before: string | undefined;
    while (collected.length < HISTORY_MESSAGE_CAP) {
      const page = await this.historyFetch(channel.discordId, before);
      if (!page || page.length === 0) break;
      let stop = false;
      for (const message of page) {
        if (cursor !== undefined && BigInt(message.id) <= cursor) {
          stop = true;
          break;
        }
        collected.push(message);
        if (collected.length >= HISTORY_MESSAGE_CAP) break;
      }
      if (stop || collected.length >= HISTORY_MESSAGE_CAP) break;
      before = page[page.length - 1].id;
    }

    collected.reverse(); // oldest first, so reply targets exist when cited
    let published = channel.historyImported ?? 0;
    for (const message of collected) {
      if (message.type !== 0 && message.type !== 19) continue;
      const [exists] = await this.sql`
        SELECT 1 FROM messages WHERE discord_message_id = ${message.id} LIMIT 1`;
      if (!exists) {
        await running.router
          .onDiscordMessage(restToInbound(message, running.link.discordGuildId, channel.discordId), running.link)
          .catch((error) => console.warn(`import ${importId}: history message ${message.id} failed:`, error));
        await new Promise((resolve) => setTimeout(resolve, 25)); // relay pacing
      }
      published++;
      channel.historyImported = published;
      channel.historyCursor = message.id;
      if (published % 20 === 0) await this.savePlan(importId, plan);
    }
    channel.historyDoneAt = Date.now();
    await this.savePlan(importId, plan);
  }

  private async savePlan(importId: string, plan: ImportPlan): Promise<void> {
    await this.sql`
      UPDATE imports SET plan = ${this.sql.json(plan as never)}, updated_at = now()
      WHERE import_id = ${importId}`;
  }

  // ── Claims (armada-history-claims-PLAN.md §3) ─────────────────────────────

  /**
   * Communities where this Discord user has bridged/imported messages and
   * whose puppet master secret exists (i.e. the puppet is derivable).
   */
  async claimTargets(discordUserId: string): Promise<ClaimTarget[]> {
    return this.sql<ClaimTarget[]>`
      SELECT DISTINCT s.community_id AS "communityId",
             MAX(b.community_name) AS "communityName",
             s.discord_guild_id AS "guildId",
             count(m.discord_message_id) AS "messageCount"
      FROM guild_community_secrets s
      JOIN bridges b ON b.community_id = s.community_id AND b.discord_guild_id = s.discord_guild_id
      LEFT JOIN messages m ON m.community_id = s.community_id AND m.origin = 'discord' AND m.author_ref = ${discordUserId}
      GROUP BY s.community_id, s.discord_guild_id
      ORDER BY MAX(b.created_at) DESC`;
  }

  /**
   * Execute a claim: Level 1 (puppet profile link + dual attestations),
   * Level 2 (imported Discord roles granted to the claimant), Level 3
   * (puppet key revealed once, marked shared-custody). The npub is verified
   * against the signed challenge; the Discord side is the caller's session.
   */
  async claim(
    communityId: string,
    session: { user: { id: string }; accessToken?: string },
    body: ClaimBody,
  ): Promise<{ linkPublished: boolean; rolesGranted: string[]; puppetNsec?: string }> {
    const npub = parseAdminPubkey(body.npub ?? "");
    if (!npub) throw new Error("log in with your Armada account first");

    // The one-time code from /claim binds the claim to the Discord account
    // that INVOKED the command, not whoever holds the session or the link.
    const code = (body.code ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(code)) throw new Error("enter the code the bot gave you");
    const [claimCode] = await this.sql<{ discord_user_id: string }[]>`
      UPDATE claim_codes SET consumed_at = now()
      WHERE code = ${code} AND community_id = ${communityId}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING discord_user_id`;
    if (!claimCode) throw new Error("that code is wrong, used, or expired; run /claim again");
    const discordUserId = claimCode.discord_user_id;

    const proof = body.signedProof;
    if (
      !proof ||
      proof.kind !== KIND_CLAIM_PROOF ||
      proof.pubkey !== npub ||
      proof.content !== claimChallenge(communityId, discordUserId) ||
      !verifyEvent(proof as NostrEvent)
    ) {
      throw new Error("invalid ownership proof");
    }

    const levels = { link: body.levels?.link !== false, roles: body.levels?.roles !== false, key: body.levels?.key === true };

    const [bridge] = await this.sql<BridgeRow[]>`
      SELECT b.*, s.master_secret_sealed AS shared_secret_sealed FROM bridges b
      JOIN guild_community_secrets s ON s.community_id = b.community_id AND s.discord_guild_id = b.discord_guild_id
      WHERE b.community_id = ${communityId} AND b.invite_url_sealed IS NOT NULL
      LIMIT 1`;
    if (!bridge?.invite_url_sealed || !bridge.master_secret_sealed || !bridge.discord_guild_id) {
      throw new Error("no claimable community found");
    }

    const [importRow] = await this.sql<ImportRow[]>`
      SELECT * FROM imports WHERE community_id = ${communityId} AND discord_guild_id = ${bridge.discord_guild_id}
      AND status = 'done' ORDER BY created_at DESC LIMIT 1`;

    const puppet = derivePuppet(
      unseal(this.env.sealKeyHex, bridge.master_secret_sealed),
      discordUserId,
    );

    // Level 2: current Discord roles -> imported Armada roles (op-signed
    // grant). Optional: a stale OAuth scope, a plain (non-imported) bridge,
    // or a member with no mapped roles all degrade to "no roles granted"
    // rather than failing the claim.
    let rolesGranted: string[] = [];
    if (levels.roles && importRow?.owner_sk_sealed && importRow.community_sealed && session.accessToken) {
      try {
        const member = await fetchMyGuildMember(session.accessToken, bridge.discord_guild_id);
        rolesGranted = importRow.plan.roles
          .filter((r) => member.roles.includes(r.discordId))
          .map((r) => r.roleIdHex!);
        if (rolesGranted.length > 0) {
        const op = localIdentity(
          Uint8Array.from(Buffer.from(unseal(this.env.sealKeyHex, importRow.owner_sk_sealed), "hex")),
        );
        const secrets = JSON.parse(unseal(this.env.sealKeyHex, importRow.community_sealed)) as CommunitySecrets;
        const community: CommunityV2 = {
          id: hex32(importRow.community_id!),
          idHex: importRow.community_id!,
          owner: importRow.plan.checkpoints.ownerPkHex!,
          ownerSalt: hex32(secrets.owner_salt),
          root: hex32(secrets.community_root),
          rootEpoch: 0n,
          heldRoots: [{ epoch: 0n, key: hex32(secrets.community_root) }],
          privateChannels: [],
          relays: importRow.plan.relays,
          name: importRow.plan.communityName,
        };
        const control = currentControlGroup(community);
        registerStreamKeys([...controlGroups(community), ...guestbookGroups(community)], community.relays);
        const pool = this.poolFactory(community.relays);
        try {
          const vac: AuthorityCitation = {
            entityId: grantLocator(community.id, hex32(op.pk)),
            version: 1n,
            editionHash: hex32(importRow.plan.checkpoints.grantHashHex!),
          };
          await pool.publish(
            await sealEdition(
              buildGrantEdition(community.id, { member: npub, roleIds: rolesGranted },
                { actorPubkey: op.pk, version: 1n, authority: vac }),
              control,
              op.signer,
            ),
          );
        } finally {
          await pool.close();
        }
        }
      } catch (error) {
        console.warn(`claim: role grant failed for ${discordUserId}:`, error);
      }
    }

    // Level 1: link the puppet's profile to the claimant, dual-signed.
    // Needs the community relays: an imported community carries them, and a
    // plain bridge's sealed invite supplies them.
    let linkPublished = false;
    if (levels.link) {
      let relays = importRow?.plan.relays ?? [];
      if (relays.length === 0 && bridge.invite_url_sealed) {
        try {
          const parsed = parseInviteLink(unseal(this.env.sealKeyHex, bridge.invite_url_sealed));
          relays = parsed?.bootstrapRelays ?? [];
        } catch {
          relays = [];
        }
      }
      if (relays.length > 0) {
        const puppetIdentity = localIdentity(puppet.sk);
        const pool = this.poolFactory(relays);
        try {
          const now = Math.floor(Date.now() / 1000);
          const challenge = claimChallenge(communityId, discordUserId);
          await pool.publish(
            await puppetIdentity.signer.signEvent({
              kind: 0,
              content: JSON.stringify({ claimed_by: npub }),
              tags: [["p", npub]],
              created_at: now,
            }),
          );
          await pool.publish(
            await puppetIdentity.signer.signEvent({
              kind: KIND_CLAIM_PROOF,
              content: challenge,
              tags: [["p", npub]],
              created_at: now,
            }),
          );
          linkPublished = true;
        } finally {
          await pool.close();
        }
      }
    }

    const [row] = await this.sql<{ claim_id: string }[]>`
      INSERT INTO claims (community_id, discord_guild_id, discord_user_id, npub, linked, roles_granted, key_revealed)
      VALUES (${communityId}, ${bridge.discord_guild_id}, ${discordUserId}, ${npub},
              ${linkPublished}, ${rolesGranted}, ${levels.key})
      ON CONFLICT (tenant_id, community_id, discord_user_id)
      DO UPDATE SET npub = EXCLUDED.npub,
        linked = claims.linked OR EXCLUDED.linked,
        roles_granted = EXCLUDED.roles_granted,
        key_revealed = claims.key_revealed OR EXCLUDED.key_revealed
      RETURNING claim_id`;

    const result: { linkPublished: boolean; rolesGranted: string[]; puppetNsec?: string } = {
      linkPublished,
      rolesGranted,
    };
    if (levels.key) {
      result.puppetNsec = nip19.nsecEncode(puppet.sk);
    }
    return result;
  }

  /** Create + activate a bridges row per selected text channel, no consent gate (D4). */
  private async wireBridges(importId: string, community: CommunityV2, plan: ImportPlan): Promise<void> {
    await this.sql`
      UPDATE imports SET status = 'wiring', updated_at = now() WHERE import_id = ${importId}`;
    const [row] = await this.sql<ImportRow[]>`SELECT * FROM imports WHERE import_id = ${importId}`;
    if (!row?.invite_url_sealed) throw new Error("import lost its invite URL before wiring");
    const inviteUrl = unseal(this.env.sealKeyHex, row.invite_url_sealed);

    for (const channel of plan.channels) {
      if (!channel.selected || !channel.bridge || !channel.bridgeable || channel.bridgeId) continue;
      const [bridge] = await this.sql<BridgeRow[]>`
        INSERT INTO bridges (owner_discord_id, status, invite_url_sealed, community_id, community_name,
                             discord_guild_id, discord_channel_id, concord_channel_id)
        VALUES (${row.owner_discord_id}, 'draft', ${seal(this.env.sealKeyHex, inviteUrl)},
                ${community.idHex}, ${plan.communityName},
                ${row.discord_guild_id}, ${channel.discordId}, ${channel.channelIdHex!})
        RETURNING *`;
      // resolveInvite inside start() races relay propagation of the fresh
      // bundle; a couple of spaced retries absorb that.
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          await this.manager.activateImported(bridge);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      channel.bridgeId = bridge.bridge_id;
      await this.sql`
        UPDATE imports SET plan = ${this.sql.json(plan as never)}, updated_at = now()
        WHERE import_id = ${importId}`;
    }
  }
}
