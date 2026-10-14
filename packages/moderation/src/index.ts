import { collectMetrics } from "./metrics";
import { CoopHandoff } from "./coopHandoff";
import postgres from "postgres";
import { rehydrateCommunity } from "@armada-bridge/concord-core";
import { localIdentity } from "../../bridge/src/concord/signer";
import { RelayPool } from "../../bridge/src/concord/pool";
import { parsePublicChannelRules } from "../../bridge/src/discord/publicChannelPolicy";
import { loadModerationConfig, loadCommunityOrgs } from "./config";
import { createModerationApi } from "./api";
import { EvidenceCipher, RelayEvidenceResolver } from "./evidence";
import { Decisions } from "./decisions";
import { Reports } from "./reports";
import { migrateModeration } from "./policyStore";
import { runModerationWorker, type WorkerHealth } from "./runtime";
async function main() {
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  const sql = postgres(required("MODERATION_DATABASE_URL"), { max: 10, connect_timeout: 5, idle_timeout: 30, onnotice: () => {} });
  const mode = required("MODERATION_MODE");
  if (mode === "migrate") { try { await migrateModeration(sql); } finally { await sql.end(); } return; }
  if (!["api", "worker"].includes(mode)) throw new Error("Invalid service mode");
  const communities = loadCommunityOrgs(process.env);
  const relayUrl = required("MODERATION_LOCAL_RELAY_URL");
  const parsedRelay = new URL(relayUrl);
  if (parsedRelay.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedRelay.hostname)) throw new Error("Local relay required");
  const port = Number(required("MODERATION_PORT"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid service port");
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
  if (mode === "worker") {
    const decisions = new Decisions(sql, undefined, communities);
    const community = rehydrateCommunity(await Bun.file(required("MODERATION_COMMUNITY_ENTRY_FILE")).json());
    const key = required("MODERATION_MEMBER_KEY");
    if (!community || !/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid moderation member provisioning");
    const publicAuthors = JSON.parse(required("MODERATION_PUBLIC_AUTHORS"));
    if (!Array.isArray(publicAuthors) || publicAuthors.some((pk) => typeof pk !== "string" || !/^[0-9a-f]{64}$/.test(pk))) throw new Error("Invalid public authors");
    const health: WorkerHealth = { ready: false, code: "starting", checkedAt: 0 };
    const server = Bun.serve({ hostname: "0.0.0.0", port, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") return new Response("ok");
      if (path !== "/readyz") return new Response(null, { status: 404 });
      return Response.json({ code: health.code }, { status: health.ready && Date.now() - health.checkedAt < 30_000 ? 200 : 503, headers: { "cache-control": "no-store" } });
    } });
    try { await runModerationWorker({ sql, decisions, community, identity: localIdentity(Buffer.from(key, "hex")), communities, relayUrl, bridgeTenantId: required("MODERATION_BRIDGE_TENANT_ID"), puppetMaster: required("BRIDGE_MASTER_SECRET"), discordToken: required("DISCORD_TOKEN"), publicChannels: parsePublicChannelRules(required("BRIDGE_PUBLIC_CHANNELS")), publicAuthors, signal: stop.signal, health }); }
    finally { await server.stop(true); await sql.end(); }
  } else {
    const config = loadModerationConfig(process.env);
    const cipher = new EvidenceCipher(config.evidenceKey, config.evidenceRetentionSeconds, config.evidenceMaxBytes);
    const decisions = new Decisions(sql, cipher, communities);
    const handoff = new CoopHandoff(sql, { origin: required("MODERATION_COOP_ORIGIN"), apiKey: required("MODERATION_COOP_API_KEY"), orgId: required("MODERATION_COOP_ORG_ID"), accessClientId: process.env.MODERATION_COOP_ACCESS_CLIENT_ID, accessClientSecret: process.env.MODERATION_COOP_ACCESS_CLIENT_SECRET });
    if (config.communities.size !== 1 || ![...config.communities.values()].includes(required("MODERATION_COOP_ORG_ID"))) throw new Error("Coop organization mismatch");
    const pool = new RelayPool([relayUrl]);
    const reports = new Reports(sql, cipher, new RelayEvidenceResolver(sql, (ids) => pool.queryStrict([{ ids }])), config.communities, config.evidenceMaxCases);
    const api = createModerationApi({ ...config, orgs: new Set(config.communities.values()), reports, decisions });
    let cleanupFailed = false, handoffRunning = false;
    const dispatch = setInterval(() => { if (handoffRunning) return; handoffRunning = true; void handoff.tick().catch(() => {}).finally(() => { handoffRunning = false; }); }, 1000);
    const cleanup = setInterval(() => { void reports.expire().then(() => { cleanupFailed = false; }, () => { cleanupFailed = true; }); }, 30_000);
    const server = Bun.serve({ hostname: "0.0.0.0", port, maxRequestBodySize: 65_536, idleTimeout: 30, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") return new Response("ok");
      if (path === "/metrics") { try { return new Response(await collectMetrics(sql), { headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } }); } catch { return new Response("unavailable", { status: 503 }); } }
      if (path === "/readyz") { try { await sql`SELECT 1`; if (cleanupFailed || !await handoff.healthy()) throw new Error(); return new Response("ok"); } catch { return new Response("unavailable", { status: 503 }); } }
      try { return await api(request); } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
    } });
    try { await new Promise<void>((resolve) => { if (stop.signal.aborted) resolve(); else stop.signal.addEventListener("abort", () => resolve(), { once: true }); }); }
    finally { clearInterval(dispatch); clearInterval(cleanup); await server.stop(true); await pool.close(); await sql.end(); }
  }
}
if (import.meta.main) await main().catch(() => { console.error("moderation: service startup or ownership failed; check configuration and readiness"); process.exit(1); });
