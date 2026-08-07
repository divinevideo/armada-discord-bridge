/**
 * Server-import planning (armada-server-import-PLAN.md): normalize a Discord
 * guild snapshot into an ImportPlan — the channels, roles, and metadata the
 * importer will mint on Armada, plus an honest report of what is skipped.
 * Pure mapping, no I/O; the plan is stored as the imports row's jsonb and
 * doubles as the pipeline's checkpoint ledger.
 */

import { ADMIN_ALL, NAME_MAX_BYTES, Permissions } from "@armada-bridge/concord-core";

import type { GuildSnapshot, SnapshotChannel, SnapshotRole } from "./discordRest";

// Discord permission bits (topics/permissions). Only the ones we map or read.
const D = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_AUDIT_LOG: 1n << 7n,
  VIEW_CHANNEL: 1n << 10n,
  MANAGE_MESSAGES: 1n << 13n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_ROLES: 1n << 28n,
} as const;

/** Discord bit → Concord bit, per the plan's permission map. */
const BIT_MAP: Array<[bigint, bigint]> = [
  [D.MANAGE_ROLES, Permissions.MANAGE_ROLES],
  [D.MANAGE_CHANNELS, Permissions.MANAGE_CHANNELS],
  [D.MANAGE_GUILD, Permissions.MANAGE_METADATA],
  [D.KICK_MEMBERS, Permissions.KICK],
  [D.BAN_MEMBERS, Permissions.BAN],
  [D.MANAGE_MESSAGES, Permissions.MANAGE_MESSAGES],
  [D.CREATE_INSTANT_INVITE, Permissions.CREATE_INVITE],
  [D.VIEW_AUDIT_LOG, Permissions.VIEW_AUDIT_LOG],
  [D.MENTION_EVERYONE, Permissions.MENTION_EVERYONE],
];

// Discord channel types (resources/channel).
const TEXT = 0;
const VOICE = 2;
const CATEGORY = 4;
const ANNOUNCEMENT = 5;
const STAGE = 13;
const FORUM = 15;
const MEDIA = 16;

export interface PlannedChannel {
  discordId: string;
  discordType: number;
  /** Final Concord channel name (voice suffix applied, 64-byte capped). */
  name: string;
  /** Discord channel topic, recorded under `custom["discord.import"].topic`. */
  topic?: string;
  /** Parent category name, published as `custom["armada.category"].name`. */
  category?: string;
  /** "voice" for imported voice/stage rooms (`custom["discord.import"].type`). */
  kind?: "voice";
  /**
   * Discord denied @everyone VIEW_CHANNEL, so this imports as a CORD-03
   * Private Channel: its own random key (never derived from the community
   * root) plus a channel-scoped Role that is its access list (CORD-04 §2).
   *
   * The key lands with the OWNER alone. Discord's per-channel allow list names
   * Discord roles held by Discord accounts, and an import has no npub for any
   * of them — members arrive later through the invite, and claim their npub
   * later still. Vending the key to anyone else at import time would mean
   * vending it to everyone who joins, which is a public channel with extra
   * steps. The owner distributes it from Armada, which is where the grant and
   * the rekey-on-revoke live.
   */
  private?: boolean;
  /** The channel-scoped Role that gates a private channel (minted at prepare). */
  accessRoleIdHex?: string;
  /** Its independent 32-byte key, sealed with the portal KMS key. */
  keySealed?: string;
  /** Unix ms when the access Role edition was accepted by a relay. */
  accessRolePublishedAt?: number;
  /** Only GuildText channels can be live-bridged (webhook mirroring). */
  bridgeable: boolean;
  /**
   * Pre-flight: the bot lacks Manage Webhooks in this channel, so a live
   * bridge could not mirror Armada messages into it. Set on the review screen
   * (Importer.preview) so the owner can fix Discord perms before wiring, not
   * discover the gap once the channel silently stops mirroring.
   */
  botMissingWebhook?: boolean;
  /** User toggle: create a live bridge for this channel. */
  bridge: boolean;
  /** User toggle: include this channel in the import at all. */
  selected: boolean;
  /** User toggle: backfill message history (bridged text channels only). */
  history: boolean;
  /** Backfill progress: messages published so far + resume cursor. */
  historyImported?: number;
  historyCursor?: string;
  historyDoneAt?: number;
  /** Minted at import time (hex32); checkpoint for the edition publish. */
  channelIdHex?: string;
  /** Unix ms when the channel edition was accepted by a relay. */
  publishedAt?: number;
  /** Set once a bridges row was created and activated for this channel. */
  bridgeId?: string;
}

export interface PlannedRole {
  discordId: string;
  name: string;
  color: number;
  /** Concord position (lower = higher authority; 1 is the stock Admin). */
  position: number;
  /** Concord permission bits as a decimal string (jsonb has no bigint). */
  permissions: string;
  /** Discord-only permissions this role loses, for the preview's honesty. */
  dropped: string[];
  roleIdHex?: string;
  publishedAt?: number;
}

export interface SkippedItem {
  kind: "channel" | "role" | "feature";
  name: string;
  reason: string;
}

/** An unsigned seal template the community owner signs in their browser. */
export interface OwnerSignTemplate {
  purpose: "admin-role" | "op-grant" | "invite-registry" | "owner-join";
  template: { kind: number; content: string; tags: string[][]; created_at: number };
}

/** A signed event as it comes back from the browser (NIP-07 / local nsec). */
export interface SignedSeal {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
  id: string;
  sig: string;
}

export interface ImportCheckpoints {
  /** Set once mintCommunity ran; identity + access secrets live sealed in the row. */
  communityIdHex?: string;
  /** The community owner: the USER's real pubkey (position 0, supreme). */
  ownerPkHex?: string;
  /** The portal's operational key: holds a revocable Admin grant, does the bulk publishing. */
  opPkHex?: string;
  /** The stock Admin role the owner mints and grants to the operational key. */
  adminRoleIdHex?: string;
  /** selfHash of the owner-signed grant edition — the vac citation every op action carries. */
  grantHashHex?: string;
  /** Templates awaiting the owner's signature, then the signed seals. */
  ownerTemplates?: OwnerSignTemplate[];
  ownerSignedSeals?: SignedSeal[];
  ownerRolePublishedAt?: number;
  ownerGrantPublishedAt?: number;
  ownerRegistryPublishedAt?: number;
  ownerJoinPublishedAt?: number;
  /**
   * The Grant edition that hands the owner the staff write key (CORD-04 §3).
   * The portal mints the `control_root` server-side, so without this delivery
   * the owner holds `control_pk` (read) but could never publish a Control
   * edition from Armada — not even to revoke the op grant.
   */
  ownerControlKeyPublishedAt?: number;
  /** Encrypted-blob pointers (CORD-02 §6) for the rehosted icon/banner. */
  iconPointer?: { url: string; key: string; nonce: string; hash: string };
  bannerPointer?: { url: string; key: string; nonce: string; hash: string };
  /** Set when icon/banner rehosting was attempted (success or noted failure). */
  assetsAt?: number;
  assetsError?: string;
  metadataPublishedAt?: number;
  opJoinPublishedAt?: number;
  profilePublishedAt?: number;
  /** Public invite link: bundle published under this signer. */
  inviteLinkSignerPk?: string;
  invitePublishedAt?: number;
  /**
   * The Direct Invite that handed the owner their private-channel keys.
   * `Error` records a delivery that failed after everything else landed — the
   * community is intact, the owner is just missing their copy, and re-running
   * the import retries with the SAME checkpointed keys.
   */
  ownerChannelKeysSentAt?: number;
  ownerChannelKeysError?: string;
  /** kind 30030 guild emoji pack, addressable at `30030:<opPk>:discord-import`. */
  emojiPackAddress?: string;
  emojiPackPublishedAt?: number;
}

/** History import gates (armada-history-claims-PLAN.md §2.2). */
export const HISTORY_MEMBER_CAP = 100;
export const HISTORY_MESSAGE_CAP = 10_000;

export interface PlannedEmoji {
  id: string;
  name: string;
  animated: boolean;
}

export interface ImportPlan {
  guild: { id: string; name: string; description?: string; iconUrl?: string; bannerUrl?: string };
  /** Community name (defaults to the guild name, 64-byte capped). */
  communityName: string;
  /** approximate_member_count at snapshot time; gates history import. */
  memberCount?: number;
  /** False for servers above HISTORY_MEMBER_CAP members. */
  historyAllowed: boolean;
  /** Guild custom emoji, published as a kind 30030 pack. */
  emojis: PlannedEmoji[];
  channels: PlannedChannel[];
  roles: PlannedRole[];
  skipped: SkippedItem[];
  /** Filled at confirm time. */
  relays: string[];
  /** Armada pubkey (hex) granted the Admin role; optional. */
  adminPkHex?: string;
  checkpoints: ImportCheckpoints;
}

/** Truncate to the protocol's 64-byte name cap without splitting a code point. */
export function capName(name: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= NAME_MAX_BYTES) return name;
  let out = "";
  for (const ch of name) {
    if (encoder.encode(out + ch).length > NAME_MAX_BYTES) break;
    out += ch;
  }
  return out;
}

const label = (c: SnapshotChannel) => `#${c.name}`;

/**
 * Whether a channel is private on the Discord side: an @everyone (role id ==
 * guild id) overwrite denying VIEW_CHANNEL, on the channel itself or inherited
 * from its category when the channel doesn't explicitly re-allow it.
 *
 * These used to be dropped ("READ access in Concord is key possession, which
 * v1 does not distribute" — plan Q2). Armada 0.45.0 ships role-gated Private
 * Channels, so they now import as one: see `PlannedChannel.private` for who
 * ends up holding the key.
 */
function isPrivate(channel: SnapshotChannel, guildId: string, categories: Map<string, SnapshotChannel>): boolean {
  const everyoneOf = (c: SnapshotChannel | undefined) =>
    c?.permission_overwrites?.find((o) => o.id === guildId && o.type === 0);
  const own = everyoneOf(channel);
  if (own) {
    if ((BigInt(own.deny) & D.VIEW_CHANNEL) !== 0n) return true;
    if ((BigInt(own.allow) & D.VIEW_CHANNEL) !== 0n) return false;
  }
  const parent = channel.parent_id ? everyoneOf(categories.get(channel.parent_id)) : undefined;
  return parent !== undefined && (BigInt(parent.deny) & D.VIEW_CHANNEL) !== 0n;
}

function voiceName(name: string): string {
  return /voice$/i.test(name) ? name : `${name}-voice`;
}

function planChannels(snapshot: GuildSnapshot, skipped: SkippedItem[]): PlannedChannel[] {
  const categories = new Map(snapshot.channels.filter((c) => c.type === CATEGORY).map((c) => [c.id, c]));
  const out: PlannedChannel[] = [];

  const ordered = [...snapshot.channels].sort((a, b) => {
    const cat = (c: SnapshotChannel) => (c.parent_id ? categories.get(c.parent_id)?.position ?? -1 : -1);
    return cat(a) - cat(b) || a.position - b.position;
  });

  for (const channel of ordered) {
    if (channel.type === CATEGORY) continue; // carried as custom.category on children
    if (channel.type === FORUM || channel.type === MEDIA) {
      skipped.push({ kind: "channel", name: label(channel), reason: "forum/media channels are not supported yet" });
      continue;
    }
    const voice = channel.type === VOICE || channel.type === STAGE;
    if (!voice && channel.type !== TEXT && channel.type !== ANNOUNCEMENT) {
      skipped.push({ kind: "channel", name: label(channel), reason: `unsupported channel type ${channel.type}` });
      continue;
    }
    const priv = isPrivate(channel, snapshot.guild.id, categories);
    // A private channel CAN be mirrored, but never by default: doing so vends
    // its key to the bridge's custodial npub and copies a deliberately gated
    // room into Discord in plaintext. That is a choice the owner makes per
    // channel, on the review screen, not one an import makes for them.
    //
    // (The bridge takes delivery of the key at boot as a Direct Invite — see
    // keyIntake.ts — which the wiring step sends before starting it. What is
    // still unhandled is CORD-06 rotation: after a revoke-driven rekey the
    // bridge holds a superseded key and goes quiet until it is re-granted.)
    const bridgeable = channel.type === TEXT;
    out.push({
      discordId: channel.id,
      discordType: channel.type,
      name: capName(voice ? voiceName(channel.name) : channel.name),
      topic: channel.topic?.trim() ? channel.topic.trim().slice(0, 1024) : undefined,
      category: channel.parent_id ? categories.get(channel.parent_id)?.name : undefined,
      kind: voice ? "voice" : undefined,
      private: priv || undefined,
      bridgeable,
      bridge: bridgeable && !priv,
      selected: true,
      history: false, // flipped on below when the member gate allows
    });
  }
  return out;
}

/** Human labels for the Discord bits we deliberately drop, preview copy. */
const DISCORD_ONLY: Array<[bigint, string]> = [
  [1n << 6n, "Add Reactions"],
  [1n << 8n, "Priority Speaker"],
  [1n << 11n, "Send Messages"],
  [1n << 12n, "Send TTS Messages"],
  [1n << 14n, "Embed Links"],
  [1n << 15n, "Attach Files"],
  [1n << 16n, "Read Message History"],
  [1n << 18n, "Use External Emojis"],
  [1n << 20n, "Connect"],
  [1n << 21n, "Speak"],
  [1n << 22n, "Mute Members"],
  [1n << 23n, "Deafen Members"],
  [1n << 24n, "Move Members"],
  [1n << 25n, "Use Voice Activity"],
  [1n << 26n, "Change Nickname"],
  [1n << 27n, "Manage Nicknames"],
  [1n << 29n, "Manage Webhooks"],
  [1n << 30n, "Manage Expressions"],
  [1n << 34n, "Manage Events"],
  [1n << 38n, "Manage Threads"],
];

export function mapRolePermissions(discordBits: bigint): { permissions: bigint; dropped: string[] } {
  if ((discordBits & D.ADMINISTRATOR) !== 0n) return { permissions: ADMIN_ALL, dropped: [] };
  let permissions = 0n;
  for (const [dBit, cBit] of BIT_MAP) if ((discordBits & dBit) !== 0n) permissions |= cBit;
  const dropped = DISCORD_ONLY.filter(([bit]) => (discordBits & bit) !== 0n).map(([, name]) => name);
  return { permissions, dropped };
}

/**
 * Concord holds 100 roles per community; position 1 is reserved for the stock
 * Admin role the importer mints, so 99 slots remain for imported roles.
 */
export const MAX_IMPORTED_ROLES = 99;

function planRoles(snapshot: GuildSnapshot, skipped: SkippedItem[]): PlannedRole[] {
  const candidates: PlannedRole[] = [];
  // Highest Discord position = highest authority; walk top-down so Concord
  // positions (lower = higher) preserve the hierarchy below the stock Admin.
  const roles = [...snapshot.guild.roles].sort((a, b) => b.position - a.position);
  for (const role of roles) {
    if (role.id === snapshot.guild.id) continue; // @everyone is the memberhood itself
    if (role.managed) {
      skipped.push({ kind: "role", name: role.name, reason: "managed role (bot/integration/booster)" });
      continue;
    }
    const { permissions, dropped } = mapRolePermissions(BigInt(role.permissions));
    if (permissions === 0n && !role.hoist) {
      skipped.push({ kind: "role", name: role.name, reason: "no mappable permissions and not displayed separately" });
      continue;
    }
    candidates.push({
      discordId: role.id,
      name: capName(role.name),
      color: role.color,
      position: 0, // assigned below
      permissions: permissions.toString(),
      dropped,
    });
  }
  for (const dropped of candidates.slice(MAX_IMPORTED_ROLES)) {
    skipped.push({ kind: "role", name: dropped.name, reason: "community role cap (100) reached" });
  }
  const kept = candidates.slice(0, MAX_IMPORTED_ROLES);
  kept.forEach((role, i) => (role.position = i + 2)); // 2..n, below the stock Admin at 1
  return kept;
}

export function buildImportPlan(snapshot: GuildSnapshot): ImportPlan {
  const skipped: SkippedItem[] = [];
  const channels = planChannels(snapshot, skipped);
  const roles = planRoles(snapshot, skipped);

  const memberCount = snapshot.guild.approximate_member_count;
  const historyAllowed = memberCount !== undefined && memberCount <= HISTORY_MEMBER_CAP;
  if (historyAllowed) {
    // Follows the bridge default, so a private channel doesn't arrive with
    // history pre-ticked under an unticked bridge it depends on.
    for (const channel of channels) if (channel.bridgeable && channel.bridge) channel.history = true;
  } else {
    skipped.push({
      kind: "feature",
      name: "Message history",
      reason: `not currently available for servers with more than ${HISTORY_MEMBER_CAP} members`,
    });
  }

  const emojis: PlannedEmoji[] = (snapshot.guild.emojis ?? [])
    .filter((e) => e.available !== false && /^\w+$/.test(e.name))
    .map((e) => ({ id: e.id, name: e.name, animated: e.animated === true }));

  skipped.push(
    { kind: "feature", name: "Members", reason: "members join via the Armada invite; bridged senders appear as puppets" },
    { kind: "feature", name: "Stickers, soundboard", reason: "no Armada equivalent yet" },
    { kind: "feature", name: "Onboarding, welcome screen, integrations", reason: "no Armada equivalent" },
  );

  const gid = snapshot.guild.id;
  return {
    guild: {
      id: gid,
      name: snapshot.guild.name,
      description: snapshot.guild.description ?? undefined,
      iconUrl: snapshot.guild.icon
        ? `https://cdn.discordapp.com/icons/${gid}/${snapshot.guild.icon}.png?size=512`
        : undefined,
      bannerUrl: snapshot.guild.banner
        ? `https://cdn.discordapp.com/banners/${gid}/${snapshot.guild.banner}.png?size=1024`
        : snapshot.guild.splash
          ? `https://cdn.discordapp.com/splashes/${gid}/${snapshot.guild.splash}.png?size=1024`
          : undefined,
    },
    communityName: capName(snapshot.guild.name),
    memberCount,
    historyAllowed,
    emojis,
    channels,
    roles,
    skipped,
    relays: [],
    checkpoints: {},
  };
}
