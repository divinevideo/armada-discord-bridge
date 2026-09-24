/**
 * Server importer: snapshot a Discord guild,
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
  buildDirectInviteRumor,
  buildGrantEdition,
  buildInviteUrl,
  buildJoinRumor,
  buildMetadataEdition,
  buildRegistryEdition,
  buildRoleEdition,
  bytesToBase64,
  bytesToHex,
  capRelays,
  communityIdOf,
  controlGroups,
  controlSignerGroupKey,
  currentControlWriteGroup,
  currentGuestbookGroup,
  editionHash,
  encodeControlWrap,
  grantLocator,
  grantToJSON,
  guestbookGroups,
  hex32,
  inviteDeliveryRelays,
  mintCommunity,
  mintLinkSigner,
  mintToken,
  parseInviteLink,
  random32,
  recipientInboxRelays,
  registerStreamKeys,
  sealDirectInvite,
  sealEdition,
  sealGuestbook,
  withChannelCategory,
  withChannelPosition,
  wrapDirectInvite,
  wrapSeal,
} from "@armada-bridge/concord-core";
import type {
  AuthorityCitation,
  ChannelMetadata,
  CommunityV2,
  InviteBundle,
  Rumor,
} from "@armada-bridge/concord-core";

/**
 * Namespace for the Discord facts Concord has no field for (channel topic, the
 * originating Discord channel type). Ours, not `armada.*`: CORD-02 §6 makes an
 * unknown custom member something every editor round-trips, so squatting on
 * another project's namespace would collide the day they define it.
 */
export const DISCORD_IMPORT_METADATA_KEY = "discord.import";
import { BlossomStore } from "@armada-bridge/bridge/src/blossom";
import { RelayPool } from "@armada-bridge/bridge/src/concord/pool";
import type { RelayLike } from "@armada-bridge/bridge/src/concord/pool";
import { localIdentity } from "@armada-bridge/bridge/src/concord/signer";
import type { LocalIdentity } from "@armada-bridge/bridge/src/concord/signer";
import { discordEmojiUrl } from "@armada-bridge/bridge/src/router";
import { sha256 } from "@noble/hashes/sha2.js";
import { createCipheriv, randomBytes } from "node:crypto";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import * as nip19 from "nostr-tools/nip19";
import { generateSecretKey, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import type postgres from "postgres";

import { botCanManageWebhooks } from "./discordRest";
import { botChannelMessagesBefore, botGuildSnapshot, botInstallUrl, restToInbound } from "./discordRest";
import type { RestMessage } from "./discordRest";
import type { PortalEnv } from "./env";
import { HISTORY_MESSAGE_CAP, buildImportPlan } from "./importPlan";
import type { ImportPlan, OwnerSignTemplate, PlannedChannel, SignedSeal } from "./importPlan";
import type { BridgeManager, BridgeRow } from "./manager";
import { assertPublicRelays } from "./relayGuard";
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
  /**
   * The staff write key (CORD-02 §2). The portal's op key is the only staff
   * member it publishes as, so this is what lets it reach the Control Plane at
   * all. Absent on rows sealed before the split: those are legacy communities
   * whose plane is still keyed by `community_root` alone, and they stay that
   * way until a Refounding mints the pair (CORD-06 §3).
   */
  control_root?: string;
}

/**
 * Rebuild the runtime community from its sealed secrets. The control pair is
 * derived, not stored twice: `control_pk` is a pure function of the
 * `control_root` at this epoch, so there is no way for the two to disagree.
 * A row without a `control_root` rebuilds as a legacy community — no
 * `controlPk`, and every control read/write falls back to the member-derivable
 * address (CORD-02 §5).
 */
function communityFromSecrets(
  secrets: CommunitySecrets,
  args: { id: Uint8Array; owner: string; relays: string[]; name: string },
): CommunityV2 {
  const root = hex32(secrets.community_root);
  const controlRoot = secrets.control_root ? hex32(secrets.control_root) : undefined;
  const controlPk = controlRoot ? controlSignerGroupKey(controlRoot, args.id, 0n).pk : undefined;
  return {
    id: args.id,
    idHex: bytesToHex(args.id),
    owner: args.owner,
    ownerSalt: hex32(secrets.owner_salt),
    root,
    rootEpoch: 0n,
    ...(controlPk ? { controlPk } : {}),
    ...(controlRoot ? { controlRoot } : {}),
    heldRoots: [{ epoch: 0n, key: root, ...(controlPk ? { controlPk } : {}) }],
    privateChannels: [],
    relays: args.relays,
    name: args.name,
  };
}

/** Mirror of sealRumor's PLAINTEXT template: what the owner actually signs. */
function plaintextSealTemplate(rumor: Rumor): OwnerSignTemplate["template"] {
  return { kind: KIND_SEAL_PLAINTEXT, content: JSON.stringify(rumor), tags: [], created_at: rumor.created_at };
}

/** The Armada client's stock blob host, used when BLOSSOM_SERVER is unset. */
const DEFAULT_BLOSSOM = "https://blossom.ditto.pub";

/** How recently an interrupted import must have progressed to auto-resume on boot. */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    /**
     * Test seam: vet relay hosts without a resolver. The guard refuses a name
     * it cannot resolve, which is right in production and would otherwise make
     * every fixture relay a DNS lookup.
     */
    private readonly vetRelays: (relays: readonly string[]) => Promise<void> = assertPublicRelays,
    /**
     * Test seam: how long to wait between a publish and re-checking that it
     * became readable. Real relays need propagation slack; the in-memory wire
     * answers instantly, so tests drive it to near-zero to exercise the
     * give-up path without sleeping for it.
     */
    private readonly publishRetryMs: number = 1500,
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
    // Pre-flight the bot's Manage Webhooks in every live-bridgeable channel,
    // so the review screen can warn before wiring. Sequential (not a burst)
    // to stay gentle on the rate limiter; the helper waits out any 429.
    for (const channel of plan.channels) {
      if (!channel.bridgeable) continue;
      if (!(await botCanManageWebhooks(this.env.discordBotToken, channel.discordId))) {
        channel.botMissingWebhook = true;
      }
    }
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

    // One live community per guild. Minting a second one here would wire a
    // parallel bridge onto the same Discord channels, and the manager routes
    // each channel to whichever bridge attached LAST (manager.ts byDiscordChannel
    // is last-writer-wins), so the newcomer silently steals the channel from the
    // members who already joined the first community — the duplicate-community
    // stranding the Lynch import hit. Recover a failed import with retry() /
    // rerunHistory(), which reuse the existing community, not a brand-new one.
    const [live] = await this.sql<{ status: string }[]>`
      SELECT status FROM bridges
      WHERE discord_guild_id = ${row.discord_guild_id}
        AND status IN ('active', 'pending_confirm')
        AND community_id IS DISTINCT FROM ${row.community_id}
      LIMIT 1`;
    if (live) {
      throw new Error(
        "this Discord server is already bridged to an Armada community; " +
          "retry or re-run history on the existing import instead of importing it again",
      );
    }

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
    // Scheme AND host: the old check was scheme-only, so `ws://127.0.0.1:6379/`
    // passed and the server opened a socket to it on the caller's behalf.
    await this.vetRelays(requested);
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
      // A Private Channel is born with an independent key and the Role that
      // gates it (CORD-03 §1, CORD-04 §2). Both are minted here so a resumed
      // import republishes the SAME pair instead of forking the channel into
      // two generations, and the key is sealed at rest like every other
      // secret in this row.
      if (channel.selected && channel.private) {
        channel.accessRoleIdHex = bytesToHex(random32());
        // Hex, not the raw Buffer: this rides the plan's jsonb column.
        channel.keySealed = seal(this.env.sealKeyHex, bytesToHex(random32())).toString("hex");
      }
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
      // Minted by mintCommunity alongside the root. Without this the op key
      // could never publish an edition after the first reload (CORD-02 §2).
      control_root: community.controlRoot ? bytesToHex(community.controlRoot) : undefined,
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

  /**
   * Pick up imports a restart cut off mid-pipeline. Call once bridges are up:
   * the wiring and history stages route through the live bridges.
   *
   * `launch` only ever ran from a request, so a process that died mid-import
   * left the row in publishing/wiring/history for good — and `retry` refuses
   * anything that isn't `failed`, so the owner could not even restart it.
   * Rows back to August were stranded that way.
   *
   * The pipeline resumes idempotently from its checkpoints, so a recent one is
   * simply relaunched. One older than RESUME_WINDOW_MS is marked failed
   * instead, with a detail saying why: its owner has likely moved on, and a
   * history backfill starting up weeks later on its own would be a surprise.
   * Failed is retryable, so the choice stays theirs.
   */
  async resumeInterrupted(): Promise<void> {
    const stranded = await this.sql<{ import_id: string; updated_at: Date }[]>`
      SELECT import_id, updated_at FROM imports
      WHERE status IN ('minting', 'publishing', 'wiring', 'history')`;
    for (const row of stranded) {
      if (this.running.has(row.import_id)) continue;
      if (Date.now() - row.updated_at.getTime() <= RESUME_WINDOW_MS) {
        console.log(`import ${row.import_id}: resuming after restart`);
        this.launch(row.import_id);
        continue;
      }
      await this.sql`
        UPDATE imports SET status = 'failed',
          status_detail = 'interrupted by a portal restart; retry to resume from where it stopped',
          updated_at = now()
        WHERE import_id = ${row.import_id} AND status IN ('minting', 'publishing', 'wiring', 'history')`;
      console.warn(`import ${row.import_id}: stranded since ${row.updated_at.toISOString()}; marked failed (retryable)`);
    }
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
    await this.wireBridges(importId, community, opSk, plan);
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
    const id = communityIdOf(hex32(cp.ownerPkHex), hex32(secrets.owner_salt));
    const community = communityFromSecrets(secrets, {
      id,
      owner: cp.ownerPkHex,
      relays: plan.relays,
      name: plan.communityName,
    });
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
    const control = currentControlWriteGroup(community);
    const guestbook = currentGuestbookGroup(community);
    registerStreamKeys([...controlGroups(community), ...guestbookGroups(community)], community.relays);
    const pool = this.poolFactory(community.relays);
    const save = async () => {
      await this.sql`
        UPDATE imports SET plan = ${this.sql.json(plan as never)}, updated_at = now()
        WHERE import_id = ${importId}`;
    };
    // Publish a durable edition and DO NOT return until a relay actually hands
    // it back. `pool.publish` resolves on the FIRST relay's ACK (any-accept),
    // so it reports success for a write that never persisted — a relay that
    // ACKs then drops it, or ordinary propagation lag on the AUTH-gated
    // community relays. Every edition is a wrap with a stable id, so read it
    // back by id and only let the caller checkpoint once it is readable.
    //
    // This is the verify-then-checkpoint the invite bundle already did; the
    // MISSING read-back everywhere else is the bug that let the importer mark
    // channel editions (and the owner's control-key Grant) published when they
    // never landed — minting bridge rows pointing at a channel absent from
    // every member's fold, which then can never start, and leaving the owner
    // able to read the Control Plane but never write to it. Throwing here
    // matches the bundle's semantics: `retry()` resumes idempotently from the
    // checkpoints, so a failed publish costs a retry, not a corrupt community.
    const publishVerified = async (event: NostrEvent, label: string): Promise<void> => {
      // `authors` narrows nothing — the id already fixes the author — but it is
      // how the pool learns which stream key to AUTH as, and AUTH-gated relays
      // serve a kind-1059 read to nobody else.
      const landed = async () =>
        (await pool.query([{ ids: [event.id], authors: [event.pubkey] }]).catch(() => [])).length > 0;
      // Check-then-sleep, not sleep-then-check: a relay that persists the write
      // and can answer for it immediately (the common case) returns with no
      // delay, so verifying every edition costs a query, not a wall of 1.5s
      // waits. The sleep only pays for genuine propagation lag before a retry.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await landed()) return;
        await pool.publish(event).catch(() => {});
        if (await landed()) return;
        await new Promise((resolve) => setTimeout(resolve, this.publishRetryMs));
      }
      throw new Error(`${label} did not become readable on the community relays; retry the import`);
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
        await publishVerified(wrapSeal(ownerSeal("admin-role"), control), "admin role edition");
        cp.ownerRolePublishedAt = Date.now();
        await save();
      }
      if (!cp.ownerGrantPublishedAt) {
        await publishVerified(wrapSeal(ownerSeal("op-grant"), control), "operator grant edition");
        cp.ownerGrantPublishedAt = Date.now();
        await save();
      }
      if (!cp.ownerRegistryPublishedAt) {
        await publishVerified(wrapSeal(ownerSeal("invite-registry"), control), "invite registry edition");
        cp.ownerRegistryPublishedAt = Date.now();
        await save();
      }
      if (!cp.ownerJoinPublishedAt) {
        await publishVerified(wrapSeal(ownerSeal("owner-join"), guestbook), "owner join");
        cp.ownerJoinPublishedAt = Date.now();
        await save();
      }

      // 1b. Hand the OWNER the staff write key (CORD-04 §3). The portal minted
      // the `control_root` server-side and the owner joins through the public
      // invite, which carries `control_pk` but never the secret — so without
      // this they could read the Control Plane and never write to it, not even
      // to revoke the op grant this whole chain exists to make revocable.
      //
      // The vehicle is the spec's own: a Grant edition for the owner carrying
      // `control_wrap`, the secret NIP-44'd under the op↔owner pairwise key
      // (one ECDH either side computes, so a bunker account opens it). The
      // role set is EMPTY on purpose — the owner's authority is position 0,
      // rooted in the community_id, and never came from a grant; op holds
      // Admin at position 1 and so could not hand out a role at its own rank
      // anyway. This edition delivers a key and claims nothing.
      if (!cp.ownerControlKeyPublishedAt && community.controlRoot) {
        const controlWrap = nip44Encrypt(
          bytesToBase64(encodeControlWrap(community.rootEpoch, community.controlRoot)),
          getConversationKey(opSk, community.owner),
        );
        await publishVerified(
          await sealEdition(
            buildGrantEdition(
              community.id,
              { member: community.owner, roleIds: [], controlWrap },
              opV1,
            ),
            control,
            op.signer,
          ),
          "owner control-key grant",
        );
        cp.ownerControlKeyPublishedAt = Date.now();
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
          // Pointer to the guild emoji pack (30030). Nothing in Armada reads
          // it yet — packs are per-user there (kind 10030 lists), not a
          // community field — so this is a forward-compatible breadcrumb under
          // a namespace we own, not a feature.
          ...(plan.emojis.length > 0
            ? { custom: { [DISCORD_IMPORT_METADATA_KEY]: { emojiPack: `30030:${op.pk}:discord-import` } } }
            : {}),
        };
        await publishVerified(
          await sealEdition(buildMetadataEdition(community.id, metadata, opV1), control, op.signer),
          "community metadata edition",
        );
        cp.metadataPublishedAt = Date.now();
        await save();
      }

      // Channel-access Roles sit below every imported Role. They are peers of
      // each other (CORD-04 §3 lets Roles share a position; display order
      // tiebreaks on role_id), and the op key holds the stock Admin at
      // position 1, so it outranks them and may mint them.
      const accessRolePosition = plan.roles.length + 2;

      let position = 0;
      for (const channel of plan.channels) {
        if (!channel.selected) continue;
        const thisPosition = position++;
        if (channel.publishedAt) continue;
        // The arrangement rides Armada's namespaced custom members, NOT bare
        // `category`/`position` keys — `channelCategory`/`channelOrder` read
        // `armada.category` and `armada.order` and nothing else, so an import
        // that invents its own spelling lands as a flat alphabetical list with
        // the sidebar arrangement computed and then discarded.
        // The access Role publishes BEFORE the channel edition, the ordering
        // Armada's own createChannel takes: a Role scoped to a channel that
        // never appeared is inert (it confers no key and grants nothing),
        // while a private channel whose Role mint then failed is a room with
        // no access list at all.
        if (channel.private && !channel.accessRolePublishedAt) {
          await publishVerified(
            await sealEdition(
              buildRoleEdition(
                {
                  roleId: channel.accessRoleIdHex!,
                  name: channel.name,
                  position: accessRolePosition,
                  permissions: 0n,
                  scope: { kind: "channel", channelId: channel.channelIdHex! },
                  color: 0,
                },
                opV1,
              ),
              control,
              op.signer,
            ),
            `access role edition for #${channel.name}`,
          );
          channel.accessRolePublishedAt = Date.now();
          await save();
        }
        let metadata: ChannelMetadata = { name: channel.name, private: Boolean(channel.private) };
        metadata = withChannelPosition(metadata, thisPosition);
        metadata = withChannelCategory(metadata, channel.category);
        // Discord facts Concord has no field for. Kept under a namespace this
        // repo owns rather than `armada.*` (which is Armada's to define) so a
        // client round-trips them per CORD-02 §6 instead of dropping them:
        // `topic` has no Concord equivalent, and `type` records what the room
        // was on Discord — every Concord channel is callable (CORD-07 §1), so
        // a voice room is a naming convention here, not a kind.
        if (channel.topic || channel.kind) {
          metadata = {
            ...metadata,
            custom: {
              ...metadata.custom,
              [DISCORD_IMPORT_METADATA_KEY]: {
                ...(channel.topic ? { topic: channel.topic } : {}),
                ...(channel.kind ? { type: channel.kind } : {}),
              },
            },
          };
        }
        await publishVerified(
          await sealEdition(buildChannelEdition(hex32(channel.channelIdHex!), metadata, opV1), control, op.signer),
          `channel edition for #${channel.name}`,
        );
        channel.publishedAt = Date.now();
        await save();
      }

      for (const role of plan.roles) {
        if (role.publishedAt) continue;
        await publishVerified(
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
          `role edition "${role.name}"`,
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
        // Read access to the Control Plane, never write (CORD-02 §7). Absent
        // on a legacy community, which folds Control at the legacy address.
        control_pk: community.controlPk,
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

      // 5. The private-channel keys, handed to the OWNER as a Direct Invite
      // (CORD-05 §6). They cannot ride the public bundle above — that bundle
      // is what every joiner reads, so a key in it gates nothing — and the
      // owner never receives one otherwise: they join their own community
      // through that same public link.
      //
      // Only the owner. Everyone else's access is a grant of the channel's
      // Role, made from Armada once real npubs exist (see PlannedChannel.private).
      const privateChannels = plan.channels.filter((c) => c.selected && c.private && c.keySealed);
      if (privateChannels.length > 0 && !cp.ownerChannelKeysSentAt) {
        const keyBundle: InviteBundle = {
          ...bundle,
          channels: privateChannels.map((c) => ({
            id: c.channelIdHex!,
            key: unseal(this.env.sealKeyHex, Buffer.from(c.keySealed!, "hex")),
            epoch: 0,
            name: c.name,
          })),
          label: "Imported from Discord — private channel keys",
        };
        const rumor = buildDirectInviteRumor(keyBundle, op.pk);
        const directSeal = await sealDirectInvite(rumor, community.owner, op.signer);
        const wrap = wrapDirectInvite(directSeal, community.owner);
        // The owner's giftwrap inbox, not the community relays: that is where
        // their client scans (their 10050 DM relays, else NIP-65 reads). A
        // FAILED lookup is not "no list" — delivering to the stock floor would
        // report success while the invite sat somewhere they never read.
        const inbox = await recipientInboxRelays(pool, community.owner);
        const deliveryPool = this.poolFactory(inviteDeliveryRelays(inbox ?? []));
        try {
          await deliveryPool.publish(wrap);
          cp.ownerChannelKeysSentAt = Date.now();
        } catch (error) {
          // Non-fatal: the community is fully published and the channels are
          // gated. What is missing is the owner's copy of the keys, which is
          // recoverable by re-running the import (this step is idempotent —
          // the keys are checkpointed, not re-minted).
          cp.ownerChannelKeysError = String(error);
        } finally {
          await deliveryPool.close().catch(() => {});
        }
        await save();
      }
    } finally {
      await pool.close();
    }
  }

  // ── History backfill ──────────────────────────────────────────────────────

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

  /**
   * Re-run history backfill for an import that already completed (recovery
   * for the silent-skip bug: clears the done markers so opted-in channels
   * backfill again, deduped against the messages table). The community and
   * its bridges are reused as-is; nothing is re-minted.
   */
  async rerunHistory(importId: string, ownerDiscordId: string): Promise<void> {
    const [row] = await this.sql<ImportRow[]>`
      SELECT * FROM imports WHERE import_id = ${importId} AND owner_discord_id = ${ownerDiscordId}`;
    if (!row) throw new Error("no such import");
    if (row.status !== "done" && row.status !== "failed") {
      throw new Error(`import is ${row.status}; only a finished import can re-run history`);
    }
    const plan = row.plan;
    if (!plan.historyAllowed) throw new Error("history is not allowed for this server");
    let any = false;
    for (const channel of plan.channels) {
      if (channel.selected && channel.bridge && channel.bridgeable && channel.history) {
        channel.historyDoneAt = undefined;
        // Start over from the top: the cursor may have been advanced past
        // messages that never published (the pre-fix run counted deduped
        // messages as done). The per-community dedupe absorbs the overlap.
        channel.historyCursor = undefined;
        channel.historyImported = 0;
        any = true;
      }
    }
    if (!any) throw new Error("no channels opted into history");
    // Flip the status here (synchronously) so a client polling right after
    // this request never sees the stale 'done'.
    await this.sql`
      UPDATE imports SET plan = ${this.sql.json(plan as never)}, status = 'history',
        status_detail = NULL, updated_at = now()
      WHERE import_id = ${importId}`;
    this.launchHistoryOnly(importId);
  }

  /** Backfill-only pipeline for rerunHistory (no re-mint, no re-wire). */
  private launchHistoryOnly(importId: string): void {
    if (this.running.has(importId)) return;
    this.running.add(importId);
    void (async () => {
      const [row] = await this.sql<ImportRow[]>`SELECT * FROM imports WHERE import_id = ${importId}`;
      await this.importHistory(importId, row!.plan);
      await this.sql`
        UPDATE imports SET status = 'done', status_detail = NULL, updated_at = now()
        WHERE import_id = ${importId}`;
    })()
      .catch(async (error) => {
        console.error(`import ${importId}: history re-run failed:`, error);
        await this.sql`
          UPDATE imports SET status = 'failed', status_detail = ${String(error)}, updated_at = now()
          WHERE import_id = ${importId}`;
      })
      .finally(() => this.running.delete(importId));
  }

  private async backfillChannel(importId: string, plan: ImportPlan, channel: PlannedChannel): Promise<void> {
    // Re-fold control so the running bridge knows the channels the import
    // just created; without this client.channel() returns undefined and the
    // router silently skips every history message (the invisible-history bug).
    await this.manager.resyncFor(channel.discordId).catch(() => {});
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
    let skipped = 0;
    for (const message of collected) {
      if (message.type !== 0 && message.type !== 19) continue;
      // Scoped to this community: re-importing the same guild elsewhere left
      // rows for the same discord_message_id, which made every history
      // message look already-imported and silently skipped the whole backfill.
      const [exists] = await this.sql`
        SELECT 1 FROM messages
        WHERE discord_message_id = ${message.id}
          AND community_id = ${running.link.communityId} LIMIT 1`;
      if (!exists) {
        const rumorId = await running.router
          .onDiscordMessage(restToInbound(message, running.link.discordGuildId, channel.discordId), running.link)
          .catch((error) => {
            console.warn(`import ${importId}: history message ${message.id} failed:`, error);
            return undefined;
          });
        if (rumorId === undefined) {
          // A skip, not a success: the channel wasn't in the bridge's fold
          // (router.ts:291) or the message was otherwise unbridgeable. Do NOT
          // count it or advance the cursor past it, or a resume will never
          // retry it — that was the silent-history-loss bug.
          skipped++;
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 25)); // relay pacing
      }
      published++;
      channel.historyImported = published;
      channel.historyCursor = message.id;
      if (published % 20 === 0) await this.savePlan(importId, plan);
    }
    if (skipped > 0) {
      console.warn(
        `import ${importId}: #${channel.name}: ${skipped} history messages skipped (bot/webhook-authored, empty after conversion, or channel not in bridge fold)`,
      );
    }
    channel.historyDoneAt = Date.now();
    await this.savePlan(importId, plan);
  }

  private async savePlan(importId: string, plan: ImportPlan): Promise<void> {
    await this.sql`
      UPDATE imports SET plan = ${this.sql.json(plan as never)}, updated_at = now()
      WHERE import_id = ${importId}`;
  }

  /** Create + activate a bridges row per selected text channel, no consent gate (D4). */
  /**
   * Let a bridge into a private channel the owner ticked for mirroring.
   *
   * Two steps, in this order:
   *
   * 1. Grant the bridge's npub the channel-scoped access Role. This is the
   *    access list Armada shows and revokes from — without it the bridge would
   *    hold a key nobody can see it holding, and a revoke would have nothing to
   *    remove. The op key mints it under the Admin role the owner granted it.
   * 2. Hand it the key as a Direct Invite (CORD-05 §6), giftwrapped to that
   *    npub and published where the bridge scans at boot: the community relays
   *    plus the stock floor. Nothing is persisted for it — the wrap is a
   *    durable relay event, so a restart re-reads the same key.
   *
   * Rotation is still not covered: a CORD-06 rekey after a revoke mints an
   * epoch the bridge does not follow, so it goes quiet on that channel until
   * re-granted. That is the known bound on this feature, not a failure here.
   */
  private async admitBridgeToPrivateChannel(
    community: CommunityV2,
    opSk: Uint8Array,
    plan: ImportPlan,
    channel: PlannedChannel,
    bridgePk: string,
  ): Promise<void> {
    const op = localIdentity(opSk);
    const control = currentControlWriteGroup(community);
    registerStreamKeys(controlGroups(community), community.relays);
    const pool = this.poolFactory(community.relays);
    try {
      const opV1 = {
        actorPubkey: op.pk,
        version: 1n,
        authority: {
          entityId: grantLocator(community.id, hex32(op.pk)),
          version: 1n,
          editionHash: hex32(plan.checkpoints.grantHashHex!),
        },
      };
      await pool.publish(
        await sealEdition(
          buildGrantEdition(
            community.id,
            { member: bridgePk, roleIds: [channel.accessRoleIdHex!] },
            opV1,
          ),
          control,
          op.signer,
        ),
      );

      const keyBundle: InviteBundle = {
        community_id: community.idHex,
        owner: community.owner,
        owner_salt: bytesToHex(community.ownerSalt),
        community_root: bytesToHex(community.root),
        root_epoch: 0,
        control_pk: community.controlPk,
        channels: [
          {
            id: channel.channelIdHex!,
            key: unseal(this.env.sealKeyHex, Buffer.from(channel.keySealed!, "hex")),
            epoch: 0,
            name: channel.name,
          },
        ],
        relays: community.relays,
        name: plan.communityName,
        creator_npub: community.owner,
        label: `Bridge access — ${channel.name}`,
      };
      const rumor = buildDirectInviteRumor(keyBundle, op.pk);
      const directSeal = await sealDirectInvite(rumor, bridgePk, op.signer);
      await pool.publish(wrapDirectInvite(directSeal, bridgePk));
    } finally {
      await pool.close?.();
    }
  }

  private async wireBridges(
    importId: string,
    community: CommunityV2,
    opSk: Uint8Array,
    plan: ImportPlan,
  ): Promise<void> {
    await this.sql`
      UPDATE imports SET status = 'wiring', updated_at = now() WHERE import_id = ${importId}`;
    const [row] = await this.sql<ImportRow[]>`SELECT * FROM imports WHERE import_id = ${importId}`;
    if (!row?.invite_url_sealed) throw new Error("import lost its invite URL before wiring");
    const inviteUrl = unseal(this.env.sealKeyHex, row.invite_url_sealed);

    for (const channel of plan.channels) {
      if (!channel.selected || !channel.bridge || !channel.bridgeable || channel.bridgeId) continue;

      // A channel someone already bridged by hand: one live bridge per Discord
      // channel is a database invariant, so activating a second would throw
      // and take the whole import down with it. Note it and move on — the
      // owner can unlink the old bridge and re-run if they meant to replace it.
      const [claimed] = await this.sql<{ bridge_id: string }[]>`
        SELECT bridge_id FROM bridges
         WHERE discord_channel_id = ${channel.discordId}
           AND status IN ('pending_confirm', 'active')`;
      if (claimed) {
        channel.bridgeSkipped = "another bridge already mirrors this Discord channel";
        await this.sql`
          UPDATE imports SET plan = ${this.sql.json(plan as never)}, updated_at = now()
          WHERE import_id = ${importId}`;
        continue;
      }

      const [bridge] = await this.sql<BridgeRow[]>`
        INSERT INTO bridges (owner_discord_id, status, invite_url_sealed, community_id, community_name,
                             discord_guild_id, discord_channel_id, concord_channel_id)
        VALUES (${row.owner_discord_id}, 'draft', ${seal(this.env.sealKeyHex, inviteUrl)},
                ${community.idHex}, ${plan.communityName},
                ${row.discord_guild_id}, ${channel.discordId}, ${channel.channelIdHex!})
        RETURNING *`;

      // Mint the identity first, so a private channel's key can reach it
      // before it boots — key intake happens once, at start.
      const provisioned = await this.manager.provisionImported(bridge);
      if (channel.private && channel.keySealed && provisioned.primary_pk) {
        await this.admitBridgeToPrivateChannel(community, opSk, plan, channel, provisioned.primary_pk);
      }

      // resolveInvite inside start() races relay propagation of the fresh
      // bundle; a couple of spaced retries absorb that.
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          await this.manager.startImported(provisioned);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      channel.bridgeId = bridge.bridge_id;
      // Wait until the running bridge's fold actually contains this channel,
      // so the backfill that follows doesn't skip every message (router.ts:291).
      for (let attempt = 0; attempt < 5; attempt++) {
        await this.manager.resyncFor(channel.discordId).catch(() => {});
        if (this.manager.channelKnown(channel.discordId, channel.channelIdHex!)) break;
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      await this.sql`
        UPDATE imports SET plan = ${this.sql.json(plan as never)}, updated_at = now()
        WHERE import_id = ${importId}`;
    }
  }
}
