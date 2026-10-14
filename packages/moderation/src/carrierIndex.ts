import type postgres from "postgres";
import type { RoomTarget } from "./contracts";
import { policyLock } from "./policyStore";
import type { RemovalIndex } from "./relayPurge";
export class CarrierIndex implements RemovalIndex {
  constructor(private readonly sql: postgres.Sql) {}
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
    const rows = await this.sql`SELECT event_id FROM moderation.carriers WHERE community_id = ${target.communityId}
      AND channel_id = ${target.channelId} AND rumor_id = ${target.rumorId} ORDER BY event_id`;
    return rows.map((row) => row.event_id as string);
  }
  async finish(decisionId: string, state: "verified" | "failed"): Promise<void> {
    await this.sql`UPDATE moderation.removals SET state = ${state}, verified_at = ${state === "verified" ? new Date() : null} WHERE decision_id = ${decisionId}`;
  }
}
