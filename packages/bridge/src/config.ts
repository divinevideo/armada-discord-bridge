/**
 * Bridge configuration, read once from the environment at startup.
 *
 * Secrets policy (see armada-discord-bridge-PLAN.md §2): the puppet master
 * secret and primary nsec are scoped per bridge. In the single-tenant
 * deployment they arrive via env; the multi-tenant portal stores them sealed
 * in Postgres and injects them per worker.
 */

export interface BridgeConfig {
  /** Postgres connection string. */
  databaseUrl: string;
  /** Discord bot token (empty allowed until the Discord adapter lands). */
  discordToken: string;
  /**
   * 32-byte hex master secret; every Discord user's puppet keypair derives
   * from it (HKDF). Rotating it rotates every puppet npub.
   */
  masterSecretHex: string;
  /** The bridge's own member identity (hex or nsec), the invited npub. */
  primarySecretKey: string;
  /** Log verbosity: debug | info | warn | error. */
  logLevel: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const masterSecretHex = required("BRIDGE_MASTER_SECRET");
  if (!/^[0-9a-f]{64}$/.test(masterSecretHex)) {
    throw new Error("BRIDGE_MASTER_SECRET must be 64 lowercase hex chars (32 bytes)");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    discordToken: env.DISCORD_TOKEN?.trim() ?? "",
    masterSecretHex,
    primarySecretKey: required("BRIDGE_PRIMARY_KEY"),
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}
