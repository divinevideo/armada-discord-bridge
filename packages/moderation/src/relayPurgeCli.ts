import postgres from "postgres";
import { CarrierIndex } from "./carrierIndex";
import { RelayPurger } from "./relayPurge";
import { LocalRelayDriver } from "./localRelayDriver";
// Local worker entrypoint, never an HTTP or caller-supplied command endpoint.
if (import.meta.main) {
  let sql: postgres.Sql | undefined;
  try {
    if (!process.env.MODERATION_DATABASE_URL) throw new Error("Missing database configuration");
    const [decisionId, communityId, channelId, rumorId] = process.argv.slice(2);
    if (!decisionId || !communityId || !channelId || !rumorId || process.argv.length !== 6) throw new Error("Invalid removal arguments");
    sql = postgres(process.env.MODERATION_DATABASE_URL, { max: 2, onnotice: () => {} });
    const result = await new RelayPurger(new CarrierIndex(sql), new LocalRelayDriver("ws://127.0.0.1:7777")).removeFromRelay({ communityId, channelId, rumorId }, decisionId);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.state !== "verified") process.exitCode = 1;
  } catch { process.stderr.write("Relay removal failed\n"); process.exitCode = 1; }
  finally { if (sql) await sql.end(); }
}
