import type postgres from "postgres";
import { deletionPolicyCounters } from "@armada-bridge/bridge/src/deletionPolicy";

/** Fixed aggregate series from persisted state: a paused or severed bridge has
 * no in-memory bridge, so the socket gauges stay healthy while it forwards
 * nothing. Only severed is the community cutting a bridge off. Paused is the
 * owner's own Pause (POST /api/bridges/:id/pause) or migration 017's
 * duplicate resolution, so a nonzero paused count is not itself a failure. */
export async function portalMetricsResponse(sql: postgres.Sql, discordConnected: boolean, relaySocketsDown: number): Promise<Response> {
  try {
    const [row] = await sql`SELECT count(*) FILTER (WHERE status = 'paused') AS paused,
      count(*) FILTER (WHERE status = 'severed') AS severed FROM bridges`;
    const paused = Number(row.paused), severed = Number(row.severed);
    if (![paused, severed, relaySocketsDown].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid aggregate");
    const series = { armada_discord_connected: Number(discordConnected), armada_relay_sockets_down: relaySocketsDown, armada_bridges_paused: paused, armada_bridges_severed: severed };
    const counters = { armada_deletion_unresolved_expired_total: deletionPolicyCounters.expired,
      armada_deletion_unresolved_capacity_total: deletionPolicyCounters.capacity,
      armada_deletion_unresolved_future_total: deletionPolicyCounters.future };
    const counterText = Object.entries(counters).map(([name,value]) => `# TYPE ${name} counter\n${name} ${value}\n`).join("");
    return new Response(Object.entries(series).map(([name, value]) => `# TYPE ${name} gauge\n${name} ${value}\n`).join("") + counterText, { headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
  } catch { return new Response("unavailable", { status: 503 }); }
}
