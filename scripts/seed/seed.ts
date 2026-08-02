/**
 * Seed CLI.
 *
 *   bun run scripts/seed/seed.ts <key|all> [--live] [--rate=<ms>]
 *
 * Defaults to DRY RUN: prints the transcript, publishes nothing. `--live`
 * actually writes to relays and requires SEED_MASTER_SECRET (64 hex chars) in
 * the environment / .env, the same secret used for dry-run so the previewed
 * npubs are the real ones.
 *
 * The master secret is the ONLY thing that turns persona ids into keypairs.
 * Keep it in .env (gitignored). Never commit or print it.
 */

import { seed as discordRefugees } from "./content/discord-refugees";
import { seed as edh } from "./content/edh";
import { seed as gaming } from "./content/gaming";
import { seed as healthFitness } from "./content/health-fitness";
import { seed as neurodivergents } from "./content/neurodivergents";
import { seed as theBasement } from "./content/the-basement";
import { seed as vegans } from "./content/vegans";
import { runSeed } from "./engine";
import { loadOrCreateMaster } from "./keystore";
import type { CommunitySeed } from "./types";

const SEEDS: Record<string, CommunitySeed> = {
  "discord-refugees": discordRefugees,
  gaming,
  "the-basement": theBasement,
  edh,
  neurodivergents,
  "health-fitness": healthFitness,
  vegans,
};

function parseArgs(argv: string[]): { key: string; live: boolean; rateMs?: number; channel?: string; skipChannel?: string } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));
  const rateFlag = flags.find((f) => f.startsWith("--rate="));
  const chanFlag = flags.find((f) => f.startsWith("--channel="));
  const skipFlag = flags.find((f) => f.startsWith("--skip-channel="));
  return {
    key: positional[0] ?? "",
    live: flags.includes("--live"),
    rateMs: rateFlag ? Number(rateFlag.split("=")[1]) : undefined,
    channel: chanFlag ? chanFlag.slice("--channel=".length) : undefined,
    skipChannel: skipFlag ? skipFlag.slice("--skip-channel=".length) : undefined,
  };
}

// Master comes from the persistent keystore (env override → store file →
// created on first use), so dry-run and live use the SAME real sock identities.

async function main() {
  const { key, live, rateMs, channel, skipChannel } = parseArgs(process.argv.slice(2));
  if (!key) {
    console.error(`usage: bun run scripts/seed/seed.ts <${Object.keys(SEEDS).join("|")}|all> [--live] [--rate=<ms>] [--channel=<name>]`);
    process.exit(1);
  }

  const master = loadOrCreateMaster();
  const targets = key === "all" ? Object.values(SEEDS) : SEEDS[key] ? [SEEDS[key]!] : [];
  if (targets.length === 0) {
    console.error(`unknown seed "${key}". known: ${Object.keys(SEEDS).join(", ")}`);
    process.exit(1);
  }

  if (live) {
    console.log("=== LIVE MODE, this WILL publish to relays. ===\n");
  }

  for (const seed of targets) {
    await runSeed(seed, { live, master, rateMs, channel, skipChannel });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\nerror: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
