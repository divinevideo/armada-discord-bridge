import type postgres from "postgres";

/** Durable outbox backlog is a delivery problem, not loss of the staff API.
 * Making it unready also removes Retry and status access during a Coop outage. */
export async function apiReadiness(sql: postgres.Sql, cleanupFailed: boolean): Promise<boolean> {
  try { await sql`SELECT 1`; return !cleanupFailed; }
  catch { return false; }
}
