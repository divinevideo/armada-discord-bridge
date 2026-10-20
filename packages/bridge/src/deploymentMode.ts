import { parsePublicChannelRules, type PublicChannelRules } from "./discord/publicChannelPolicy";
export type BridgeMode = "legacy" | "public";
/** Deployment configuration cannot be widened by a caller or inferred from missing public rules. */
export function loadDeploymentMode(env: Record<string, string | undefined> = process.env): { mode: BridgeMode; publicChannels?: PublicChannelRules } {
  const mode = env.BRIDGE_MODE?.trim() || "legacy";
  if (mode !== "legacy" && mode !== "public") throw new Error("BRIDGE_MODE must be legacy or public");
  if (mode === "legacy") {
    if (env.BRIDGE_PUBLIC_CHANNELS?.trim() || env.BRIDGE_COMMUNITY_ID?.trim()) throw new Error("Public pairing configuration requires BRIDGE_MODE=public");
    return { mode };
  }
  return { mode, publicChannels: parsePublicChannelRules(env.BRIDGE_PUBLIC_CHANNELS) };
}
/** Restrict public deployments without changing the ordinary multi-guild authorization contract. */
export function guildInScope(config: { mode?: BridgeMode; publicChannels?: PublicChannelRules }, guildId: string): boolean {
  return config.mode !== "public" || config.publicChannels?.guildId === guildId;
}
