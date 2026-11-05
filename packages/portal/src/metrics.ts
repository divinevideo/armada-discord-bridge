import type postgres from "postgres";

/** Fixed aggregate series: paused/severed records remain operational failures
 * even after their in-memory bridge has stopped and sockets look healthy. */
export async function portalMetricsResponse(sql: postgres.Sql, discordConnected: boolean, relaySocketsDown: number): Promise<Response> {
  try {
    const [row] = await sql`SELECT count(*) FILTER (WHERE status = 'paused') AS paused,
      count(*) FILTER (WHERE status = 'severed') AS severed FROM bridges`;
    const paused = Number(row.paused), severed = Number(row.severed);
    if (![paused, severed, relaySocketsDown].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid aggregate");
    return new Response(`armada_discord_connected ${Number(discordConnected)}\narmada_relay_sockets_down ${relaySocketsDown}\narmada_bridges_paused ${paused}\narmada_bridges_severed ${severed}\n`, { headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
  } catch { return new Response("unavailable", { status: 503 }); }
}
