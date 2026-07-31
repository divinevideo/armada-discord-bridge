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
  /** Discord channel topic, recorded in ChannelMetadata.custom.topic. */
  topic?: string;
  /** Parent category name, recorded in ChannelMetadata.custom.category. */
  category?: string;
  /** "voice" for imported voice/stage rooms (ChannelMetadata.custom.kind). */
  kind?: "voice";
  /** Only GuildText channels can be live-bridged (webhook mirroring). */
  bridgeable: boolean;
  /** User toggle: create a live bridge for this channel. */
  bridge: boolean;
  /** User toggle: include this channel in the import at all. */
  selected: boolean;
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
}

export interface ImportPlan {
  guild: { id: string; name: string; description?: string; iconUrl?: string; bannerUrl?: string };
  /** Community name (defaults to the guild name, 64-byte capped). */
  communityName: string;
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
 * from its category when the channel doesn't explicitly re-allow it. READ
 * access in Concord is key possession, which v1 does not distribute, so
 * private channels are skipped (plan Q2).
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
    if (isPrivate(channel, snapshot.guild.id, categories)) {
      skipped.push({ kind: "channel", name: label(channel), reason: "private channels are not supported yet" });
      continue;
    }
    const bridgeable = channel.type === TEXT;
    out.push({
      discordId: channel.id,
      discordType: channel.type,
      name: capName(voice ? voiceName(channel.name) : channel.name),
      topic: channel.topic?.trim() ? channel.topic.trim().slice(0, 1024) : undefined,
      category: channel.parent_id ? categories.get(channel.parent_id)?.name : undefined,
      kind: voice ? "voice" : undefined,
      bridgeable,
      bridge: bridgeable,
      selected: true,
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

  skipped.push(
    { kind: "feature", name: "Message history", reason: "not imported; bridged channels mirror new messages" },
    { kind: "feature", name: "Members", reason: "members join via the Armada invite; bridged senders appear as puppets" },
    { kind: "feature", name: "Emoji, stickers, soundboard", reason: "no Armada equivalent yet" },
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
    channels,
    roles,
    skipped,
    relays: [],
    checkpoints: {},
  };
}
