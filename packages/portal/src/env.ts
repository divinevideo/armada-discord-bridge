/** Portal environment. Discord OAuth vars are optional in dev (dev login). */

import { parsePublicChannelRules, type PublicChannelRules } from "@armada-bridge/bridge/src/discord/publicChannelPolicy";

export interface PortalEnv {
  /** Provisioned root shared only with the moderation worker for this public pairing. */
  puppetMaster?: { communityId: string; guildId: string; key: string };
  publicChannels?: PublicChannelRules;
  databaseUrl: string;
  port: number;
  /**
   * Interface to bind. Loopback by default: the production deployment sits
   * behind a TLS proxy on the same host, and binding every interface quietly
   * published the whole API to the local network in plaintext, around
   * whatever the proxy enforces. Container deployments, where the boundary is
   * the container itself, set PORTAL_HOST=0.0.0.0 explicitly.
   */
  host: string;
  baseUrl: string;
  sealKeyHex: string;
  discordClientId: string;
  discordClientSecret: string;
  discordBotToken: string;
  /** Blossom server URL(s) for attachment rehosting, comma-separated in preference order; empty leaves CDN links. */
  blossomServer: string;
  /** KLIPY API key; resolves Klipy GIF-picker sends to their real GIF. Empty transcodes the mp4 instead. */
  klipyApiKey: string;
  /** When "1", /api/auth/dev issues a fake session for UI development. */
  devLogin: boolean;
  /** Cosmetic base for minted invite URLs (any deeplink domain parses). */
  inviteBaseUrl: string;
  /** Default relay set for imported communities; empty falls back to stock. */
  importRelays: string[];
  /**
   * Origins allowed to drive the API cross-origin (the Armada client running
   * the import wizard in-app). Empty = same-origin only, i.e. the portal's own
   * SPA and nothing else.
   *
   * Credentials are NOT sent cross-origin; those callers authenticate with a
   * bearer token instead of the session cookie, so a permissive entry here
   * cannot be used to ride a visitor's existing portal session.
   */
  allowedOrigins: string[];
  /**
   * Recovery knob for the Discord catch-up (epoch ms; unset in normal
   * operation). Anchors each channel's replay on the newest message mirrored
   * BEFORE this moment instead of the newest overall, so one boot can walk a
   * gap that later traffic has already papered over — a restart on code that
   * had no catch-up leaves exactly that. Already-mirrored messages are
   * skipped, so starting early costs reads, not duplicates. Set for one boot,
   * then remove.
   */
  catchUpSinceMs?: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function loadPortalEnv(): PortalEnv {
  const sealKeyHex = required("PORTAL_SEAL_KEY");
  if (!/^[0-9a-f]{64}$/.test(sealKeyHex)) throw new Error("PORTAL_SEAL_KEY must be 64 lowercase hex chars");
  const port = Number(process.env.PORTAL_PORT ?? 8787);
  const baseUrl = process.env.PORTAL_BASE_URL?.trim() || `http://localhost:${port}`;
  const devLogin = process.env.PORTAL_DEV_LOGIN === "1";
  // Refuse to boot rather than serve the backdoor. `/api/auth/dev` hands any
  // unauthenticated caller a session whose fixture guild carries canManage and
  // which is permanently exempt from the fresh-Discord permission re-check —
  // and every dev session shares one owner id, so they own each other's
  // bridges. "Never set in production" was a line in the README with nothing
  // enforcing it, and the compose file passes the variable straight through.
  if (devLogin && (process.env.NODE_ENV === "production" || baseUrl.startsWith("https:"))) {
    throw new Error(
      "PORTAL_DEV_LOGIN=1 refused: it grants any anonymous caller a session, and this looks like a production deployment",
    );
  }
  const master = process.env.BRIDGE_MASTER_SECRET;
  const communityId = process.env.BRIDGE_COMMUNITY_ID;
  const publicChannels = parsePublicChannelRules(process.env.BRIDGE_PUBLIC_CHANNELS);
  if (Boolean(master) !== Boolean(communityId) || (master && (!/^[0-9a-f]{64}$/.test(master) || !/^[0-9a-f]{64}$/.test(communityId!)))) throw new Error("Invalid provisioned puppet scope");
  return {
    puppetMaster: master ? { communityId: communityId!, guildId: publicChannels.guildId, key: master } : undefined,
    databaseUrl: required("DATABASE_URL"),
    publicChannels,
    port,
    host: process.env.PORTAL_HOST?.trim() || "127.0.0.1",
    baseUrl,
    sealKeyHex,
    discordClientId: process.env.DISCORD_CLIENT_ID?.trim() ?? "",
    discordClientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? "",
    discordBotToken: process.env.DISCORD_TOKEN?.trim() ?? "",
    blossomServer: process.env.BLOSSOM_SERVER?.trim() ?? "",
    klipyApiKey: process.env.KLIPY_API_KEY?.trim() ?? "",
    devLogin,
    inviteBaseUrl: process.env.INVITE_BASE_URL?.trim() || "https://armada.buzz",
    importRelays: (process.env.IMPORT_DEFAULT_RELAYS ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
    allowedOrigins: (process.env.PORTAL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    catchUpSinceMs: parseCatchUpSince(process.env.DISCORD_CATCHUP_SINCE),
  };
}

function parseCatchUpSince(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const ms = Date.parse(value.trim());
  // Refuse rather than ignore: a typo here would silently skip the recovery
  // the operator set it for.
  if (!Number.isFinite(ms)) throw new Error(`DISCORD_CATCHUP_SINCE is not a date: ${value}`);
  return ms;
}
