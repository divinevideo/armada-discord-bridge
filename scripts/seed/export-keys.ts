/**
 * Export the sock keystore.
 *
 *   bun run scripts/seed/export-keys.ts
 *
 * Ensures a master secret exists (creates one on first run), then writes
 * socks.json + socks.md to the store dir (default ~/Projects/armada-socks,
 * override with SOCK_STORE_DIR). Deterministic: re-run any time to refresh the
 * table after adding personas. These are throwaway demo accounts, do not
 * commit the store dir.
 */

import { PERSONAS } from "./personas";
import { loadOrCreateMaster, storeDir, tableJsonPath, tableMdPath, writeSockTable } from "./keystore";

function main() {
  const master = loadOrCreateMaster();
  const rows = writeSockTable(PERSONAS, master);
  console.log(`Store dir: ${storeDir()}`);
  console.log(`Wrote ${rows.length} sock accounts:`);
  console.log(`  ${tableJsonPath()}`);
  console.log(`  ${tableMdPath()}`);
  console.log("");
  for (const r of rows) {
    console.log(`  @${r.handle.padEnd(16)} ${r.npub}`);
  }
}

main();
