/**
 * Sock keystore: a persistent master secret + an exported nsec/npub table,
 * stored OUTSIDE any git repo (default ~/Projects/armada-socks, override with
 * SOCK_STORE_DIR). Security is intentionally not a concern for these throwaway
 * demo accounts, the point is that the same personas can be edited and posted
 * from again later.
 *
 * Keys are deterministic: sk = HKDF(master, personaId) (see sock.ts). The table
 * is a convenience export; the master secret alone can regenerate everything.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

import { deriveSockSk } from "./sock";
import type { Persona } from "./types";

const HEX32 = /^[0-9a-f]{64}$/i;

export function storeDir(): string {
  return process.env.SOCK_STORE_DIR?.trim() || join(homedir(), "Projects", "armada-socks");
}

export const masterPath = (): string => join(storeDir(), "master.secret");
export const tableJsonPath = (): string => join(storeDir(), "socks.json");
export const tableMdPath = (): string => join(storeDir(), "socks.md");

/**
 * Resolve the master secret, preferring an explicit env override, then the
 * store file, creating and persisting a fresh one (mode 600) if neither exists.
 */
export function loadOrCreateMaster(): string {
  const env = process.env.SEED_MASTER_SECRET?.trim();
  if (env) {
    if (!HEX32.test(env)) throw new Error("SEED_MASTER_SECRET must be 64 hex chars");
    return env.toLowerCase();
  }
  const p = masterPath();
  if (existsSync(p)) {
    const s = readFileSync(p, "utf8").trim();
    if (!HEX32.test(s)) throw new Error(`master secret at ${p} is not 64 hex chars`);
    return s.toLowerCase();
  }
  mkdirSync(storeDir(), { recursive: true });
  const secret = bytesToHex(generateSecretKey());
  writeFileSync(p, `${secret}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
  console.warn(`* created new master secret at ${p}`);
  return secret;
}

export interface SockRow {
  id: string;
  handle: string;
  displayName: string;
  style: string;
  communities: string[];
  npub: string;
  nsec: string;
}

export function sockRow(p: Persona, master: string): SockRow {
  const sk = deriveSockSk(master, p.id);
  return {
    id: p.id,
    handle: p.handle,
    displayName: p.displayName ?? p.handle,
    style: p.style,
    communities: p.communities,
    npub: nip19.npubEncode(getPublicKey(sk)),
    nsec: nip19.nsecEncode(sk),
  };
}

/** Write socks.json + socks.md to the store dir; returns the rows. */
export function writeSockTable(personas: Persona[], master: string): SockRow[] {
  const rows = personas.map((p) => sockRow(p, master));
  mkdirSync(storeDir(), { recursive: true });

  writeFileSync(tableJsonPath(), `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tableJsonPath(), 0o600);

  const header = "| id | handle | display | style | communities | npub | nsec |";
  const sep = "|---|---|---|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.id} | @${r.handle} | ${r.displayName} | ${r.style} | ${r.communities.join(", ")} | \`${r.npub}\` | \`${r.nsec}\` |`)
    .join("\n");
  const md = `# Armada sock accounts\n\nGenerated from the master secret in this directory. Deterministic, regenerate any time with \`bun run scripts/seed/export-keys.ts\`.\n\nDo NOT commit this file. These are throwaway demo accounts.\n\n${header}\n${sep}\n${body}\n`;
  writeFileSync(tableMdPath(), md, { mode: 0o600 });
  chmodSync(tableMdPath(), 0o600);

  return rows;
}
