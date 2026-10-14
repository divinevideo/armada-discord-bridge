import type postgres from 'postgres';
export type HandoffTransport = (url: string, options: RequestInit) => Promise<Response>;
export interface CoopHandoffConfig { origin: string; apiKey: string; orgId: string; accessClientId?: string; accessClientSecret?: string }
/** At-least-once delivery. Coop commits an idempotency receipt before acknowledging. */
export class CoopHandoff {
  constructor(private readonly sql: postgres.Sql, private readonly config: CoopHandoffConfig, private readonly transport: HandoffTransport = fetch) {
    const url = new URL(config.origin);
    if (url.protocol !== 'https:' || url.origin !== config.origin || !config.apiKey || !config.orgId || Boolean(config.accessClientId) !== Boolean(config.accessClientSecret)) throw new Error('Invalid Coop handoff configuration');
  }
  async tick(): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await tx`INSERT INTO moderation.coop_handoffs (case_id) SELECT case_id FROM moderation.cases WHERE org_id = ${this.config.orgId} AND expires_at > clock_timestamp() ON CONFLICT DO NOTHING`;
      const [row] = await tx`SELECT h.case_id, h.attempts FROM moderation.coop_handoffs h JOIN moderation.cases c USING (case_id)
        WHERE c.org_id = ${this.config.orgId} AND c.expires_at > clock_timestamp() AND h.state = 'pending' AND h.available_at <= clock_timestamp()
        ORDER BY h.available_at FOR UPDATE OF h SKIP LOCKED LIMIT 1`;
      if (!row) return false;
      let queued = false;
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': this.config.apiKey };
        if (this.config.accessClientId) { headers['CF-Access-Client-Id'] = this.config.accessClientId; headers['CF-Access-Client-Secret'] = this.config.accessClientSecret!; }
        const response = await this.transport(this.config.origin + '/api/v1/concord/cases', { method: 'POST', redirect: 'error', headers, body: JSON.stringify({ caseId: row.case_id }), signal: AbortSignal.timeout(5000) });
        if (response.status === 202) {
          const reader = response.body?.getReader();
          if (reader) {
            let size = 0; const chunks: Uint8Array[] = [];
            try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1024) { await reader.cancel(); throw new Error('Oversized acknowledgement'); } chunks.push(next.value); } }
            finally { reader.releaseLock(); }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); queued = value.caseId === row.case_id && value.state === 'queued';
          }
        } else await response.body?.cancel();
      } catch { /* Persist a retry without logging credentials or report data. */ }
      await tx`UPDATE moderation.coop_handoffs SET state = ${queued ? 'queued' : 'pending'}, attempts = attempts + 1, updated_at = clock_timestamp(),
        available_at = clock_timestamp() + (${Math.min(300, 2 ** Math.min(row.attempts + 1, 9))} * interval '1 second') WHERE case_id = ${row.case_id}`;
      return true;
    });
  }
  async healthy(): Promise<boolean> {
    const [row] = await this.sql`SELECT count(*)::int AS count FROM moderation.coop_handoffs h JOIN moderation.cases c USING (case_id)
      WHERE c.org_id = ${this.config.orgId} AND h.state = 'pending' AND c.created_at < clock_timestamp() - interval '1 minute'`;
    return row.count === 0;
  }
}
