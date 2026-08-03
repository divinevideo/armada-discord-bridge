/** Portal environment. Discord OAuth vars are optional in dev (dev login). */

export interface PortalEnv {
  databaseUrl: string;
  port: number;
  baseUrl: string;
  sealKeyHex: string;
  discordClientId: string;
  discordClientSecret: string;
  discordBotToken: string;
  /** Blossom server URL for attachment rehosting; empty leaves CDN links. */
  blossomServer: string;
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
  return {
    databaseUrl: required("DATABASE_URL"),
    port,
    baseUrl: process.env.PORTAL_BASE_URL?.trim() || `http://localhost:${port}`,
    sealKeyHex,
    discordClientId: process.env.DISCORD_CLIENT_ID?.trim() ?? "",
    discordClientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? "",
    discordBotToken: process.env.DISCORD_TOKEN?.trim() ?? "",
    blossomServer: process.env.BLOSSOM_SERVER?.trim() ?? "",
    devLogin: process.env.PORTAL_DEV_LOGIN === "1",
    inviteBaseUrl: process.env.INVITE_BASE_URL?.trim() || "https://armada.buzz",
    importRelays: (process.env.IMPORT_DEFAULT_RELAYS ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
    allowedOrigins: (process.env.PORTAL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  };
}
