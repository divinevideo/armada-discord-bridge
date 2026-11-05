import type postgres from "postgres";

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
    return new Response(`armada_discord_connected ${Number(discordConnected)}\narmada_relay_sockets_down ${relaySocketsDown}\narmada_bridges_paused ${paused}\narmada_bridges_severed ${severed}\n`, { headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
  } catch { return new Response("unavailable", { status: 503 }); }
}
