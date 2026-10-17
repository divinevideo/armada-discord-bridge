import type postgres from "postgres";
import type { RoomTarget } from "./contracts";
import { policyLock } from "./policyStore";
import type { PurgeDriver, RemovalIndex } from "./relayPurge";
// Match admission's SQL timeout and the local driver's existing command/batch
// bounds. Overflow is a failed purge, never a truncated successful deletion.
const SQL_TIMEOUT_MS = 1500, BARRIER_DB_MS = 30_000, MAX_CARRIERS = 128;
export class CarrierIndex implements RemovalIndex {
  constructor(private readonly sql: postgres.Sql) {}
  async underBarrier<T>(driver: PurgeDriver, work: (index: RemovalIndex, signal?: AbortSignal) => Promise<T>): Promise<T> {
    // Pool acquisition and session setup happen before taking the admission lock.
    // SET LOCAL and rollback keep these limits out of unrelated pool users.
    const session = await this.sql.reserve();
    let open = false;
    try {
      await session`BEGIN`;
      open = true;
      await session.unsafe(`SET LOCAL statement_timeout = '${SQL_TIMEOUT_MS}ms'`);
      await session.unsafe(`SET LOCAL lock_timeout = '${SQL_TIMEOUT_MS}ms'`);
      return await driver.barrier(async (signal) => {
        const deadline = Date.now() + BARRIER_DB_MS;
        const run = async <R extends postgres.Row[]>(query: postgres.PendingQuery<R>): Promise<R> => {
          const left = deadline - Date.now();
          if (left <= 0 || signal?.aborted) {
            query.cancel();
            await query.catch(() => {});
            throw new Error("Purge database deadline or barrier lost");
          }
          // Let the server enforce the bound and await its response, including
          // on barrier loss. A client cancel can arrive after statement_timeout
          // and cancel an unrelated query when this session returns to the pool.
          await session.unsafe(`SET LOCAL statement_timeout = '${Math.min(left, SQL_TIMEOUT_MS)}ms'`);
          const result = await query;
          if (signal?.aborted || Date.now() >= deadline) throw new Error("Purge database deadline or barrier lost");
          return result;
        };
        const index: RemovalIndex = {
          start: () => { throw new Error("Tombstone must precede barrier"); },
          ids: async (target) => {
            const legacy = await run(session`SELECT 1 FROM moderation.carriers WHERE community_id = ${target.communityId}
              AND channel_id = ${target.channelId} AND kind IN (3302, 7) AND NOT targets_indexed LIMIT 1`);
            if (legacy.length) throw new Error("Carrier references require verified reindexing");
            const rows = await run(session`SELECT event_id FROM moderation.carriers WHERE community_id = ${target.communityId}
              AND channel_id = ${target.channelId} AND (rumor_id = ${target.rumorId} OR target_rumor_ids @> ARRAY[${target.rumorId}]::text[]) ORDER BY event_id LIMIT ${MAX_CARRIERS + 1}`);
            if (rows.length > MAX_CARRIERS) throw new Error("Carrier index overflow");
            return rows.map((row) => row.event_id as string);
          },
          finish: async (decisionId, state) => {
            await run(session`UPDATE moderation.removals SET state = ${state}, verified_at = ${state === "verified" ? new Date() : null} WHERE decision_id = ${decisionId}`);
          },
        };
        try {
          const result = await work(index, signal);
          await run(session`COMMIT`);
          open = false;
          return result;
        } catch (error) {
          // Complete rollback while admission is still stopped, including when
          // statement_timeout/lock_timeout canceled a blocked query.
          await session`ROLLBACK`;
          open = false;
          throw error;
        }
      });
    } finally {
      try { if (open) await session`ROLLBACK`; }
      finally { session.release(); }
    }
  }
  async start(target: RoomTarget, decisionId: string): Promise<number> {
    return this.sql.begin(async (tx) => {
      await policyLock(tx, target.communityId);
      const [policy] = await tx`SELECT revision FROM moderation.community_policy WHERE community_id = ${target.communityId}`;
      if (!policy) throw new Error("Policy unavailable");
      const [existing] = await tx`SELECT * FROM moderation.removals WHERE decision_id = ${decisionId} FOR UPDATE`;
      if (existing && (existing.community_id !== target.communityId || existing.channel_id !== target.channelId || existing.rumor_id !== target.rumorId)) throw new Error("Decision target conflict");
      await tx`INSERT INTO moderation.tombstones (community_id, channel_id, rumor_id)
        VALUES (${target.communityId}, ${target.channelId}, ${target.rumorId}) ON CONFLICT DO NOTHING`;
      const [row] = await tx`UPDATE moderation.community_policy SET revision = revision + 1 WHERE community_id = ${target.communityId} RETURNING revision`;
      await tx`INSERT INTO moderation.removals (decision_id, community_id, channel_id, rumor_id, policy_revision)
        VALUES (${decisionId}, ${target.communityId}, ${target.channelId}, ${target.rumorId}, ${row.revision})
        ON CONFLICT (decision_id) DO UPDATE SET state = 'pending', attempts = moderation.removals.attempts + 1, policy_revision = EXCLUDED.policy_revision, verified_at = NULL`;
      return Number(row.revision);
    });
  }
  async ids(target: RoomTarget): Promise<string[]> {
    const legacy = await this.sql`SELECT 1 FROM moderation.carriers WHERE community_id = ${target.communityId}
      AND channel_id = ${target.channelId} AND kind IN (3302, 7) AND NOT targets_indexed LIMIT 1`;
    if (legacy.length) throw new Error("Carrier references require verified reindexing");
    const rows = await this.sql`SELECT event_id FROM moderation.carriers WHERE community_id = ${target.communityId}
      AND channel_id = ${target.channelId} AND (rumor_id = ${target.rumorId} OR target_rumor_ids @> ARRAY[${target.rumorId}]::text[]) ORDER BY event_id`;
    return rows.map((row) => row.event_id as string);
  }
  async finish(decisionId: string, state: "verified" | "failed"): Promise<void> {
    await this.sql`UPDATE moderation.removals SET state = ${state}, verified_at = ${state === "verified" ? new Date() : null} WHERE decision_id = ${decisionId}`;
  }
}
