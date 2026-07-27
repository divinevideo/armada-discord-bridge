/**
 * Bridge service entry point. Phase 1 wiring lands next: for now this
 * validates config, runs migrations, and exits cleanly so the Docker
 * healthcheck story can be built early.
 */

import { loadConfig } from "./config";
import { migrate } from "./db/migrate";

const config = loadConfig();
const applied = await migrate(config.databaseUrl);
console.log(
  applied.length ? `migrations applied: ${applied.join(", ")}` : "schema up to date",
);
console.log("bridge: config OK; concord/discord adapters not wired yet (phase 1/2)");
