/**
 * Postgres-backed mapping store (single-tenant rows use tenant_id 'default';
 * the portal control plane sets real tenant ids later).
 */

import type postgres from "postgres";
import { randomUUID } from "node:crypto";

import { deletionLinkKey } from "../router";
import type { PendingConcordDelete, ChannelLink, MappingStore, MessageMappingRow, ReactionMappingRow } from "../router";
import { planDeletionIntake, observeDeletionDisposition, DeletionIntakeError, ActionableDeletionCapacityError, MAX_PENDING_DELETE_REPLAY_BATCH } from "../deletionPolicy";
import type { DeletionIntakeOutcome } from "../deletionPolicy";
import { deliveryScope, deliverySnapshot, lockDelivery, assertLockedLease, standaloneDeliveryOwner, StaleDeliveryFenceError } from "./deliveryState";
import type { DeliveryFence, DeliveryLeaseProof, DeliverySnapshot } from "./deliveryState";
export type { DeliveryFence, DeliveryLeaseProof, DeliverySnapshot } from "./deliveryState";
export { standaloneDeliveryOwner, StaleDeliveryFenceError } from "./deliveryState";

export class PostgresMappingStore implements MappingStore {
  constructor(private readonly sql: postgres.Sql, private readonly tenantId = "default",
    private readonly bound?: { link: ChannelLink; fence: DeliveryFence }) {}

  /** A singleton store never changes its fence. Each worker gets its own view. */
  forDelivery(link: ChannelLink, fence: DeliveryFence): PostgresMappingStore {
    return new PostgresMappingStore(this.sql, this.tenantId, Object.freeze({link:Object.freeze({...link}),
      fence:Object.freeze({...fence,lease:Object.freeze({...fence.lease})})}));
  }
  private checkLink(link: ChannelLink): void {
    if(this.bound && deletionLinkKey(link)!==deletionLinkKey(this.bound.link)) throw new StaleDeliveryFenceError('Delivery scope mismatch');
  }
  private async write<T>(work: (tx: postgres.TransactionSql) => Promise<T>, link?: ChannelLink): Promise<T> {
    if(link) this.checkLink(link);
    return this.sql.begin(async tx => {
      if(this.bound) {
        // Bound worker operations so shutdown can fence and release a stalled
        // callback without changing timeouts for unrelated portal imports.
        await tx`SET LOCAL statement_timeout = '15s'`;
        await tx`SET LOCAL lock_timeout = '5s'`;
        await lockDelivery(tx,this.tenantId,this.bound.link,this.bound.fence);
      }
      else if(link) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.tenantId + deletionLinkKey(link)},19306))`;
      const result=await work(tx);
      if(this.bound) await assertLockedLease(tx,this.bound.fence.lease);
      return result;
    }) as Promise<T>;
  }
  private scope(tx: postgres.Sql | postgres.TransactionSql, link: ChannelLink) {
    this.checkLink(link); return deliveryScope(tx,this.tenantId,link);
  }
  private deletion(row: Record<string,any>): PendingConcordDelete {
    return {deleteRumorId:row.delete_rumor_id,targetRumorId:row.target_rumor_id,author:row.author,
      ...(row.citation ? {citation:row.citation}:{}),createdAtMs:Number(row.created_at_ms),actionClass:row.action_class,
      sourceWrapCreatedAt:Number(row.source_wrap_created_at),firstObservedAtMs:Number(row.first_observed_at_ms),
      ...(row.inner_created_at == null ? {} : {innerCreatedAt:Number(row.inner_created_at)}),
      ...(row.inner_epoch == null ? {} : {innerEpoch:row.inner_epoch}),
      ...(row.expires_at_ms == null ? {} : {expiresAtMs:Number(row.expires_at_ms)}),
      nextAttemptAtMs:Number(row.next_attempt_at_ms),attempts:row.attempts};
  }
  private async expire(tx: postgres.TransactionSql,link:ChannelLink): Promise<number> {
    const rows=await tx`DELETE FROM pending_concord_deletes WHERE ${this.scope(tx,link)}
      AND action_class='unresolved' AND expires_at_ms <= floor(extract(epoch FROM clock_timestamp())*1000) RETURNING 1`;
    return rows.length;
  }
  async saveDeletes(link: ChannelLink, rows: PendingConcordDelete[]): Promise<DeletionIntakeOutcome> {
    try {
      if(this.bound && rows.some(row=>row.sourceWrapCreatedAt==null)) throw new DeletionIntakeError('Verified carrier timestamp required for delivery intake');
      const outcome=await this.write(async tx=>{
        const expired=await this.expire(tx,link);
        const held=await tx`SELECT * FROM pending_concord_deletes WHERE ${this.scope(tx,link)}`;
        const [clock]=await tx`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`;
        const plan=planDeletionIntake(held.map(row=>this.deletion(row)),rows,Number(clock.ms));
        for(const row of plan.writes) await tx`INSERT INTO pending_concord_deletes
          (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,delete_rumor_id,target_rumor_id,
           author,citation,created_at_ms,action_class,source_wrap_created_at,first_observed_at_ms,expires_at_ms,next_attempt_at_ms,attempts,inner_created_at,inner_epoch)
          VALUES (${this.tenantId},${link.communityId},${link.concordChannelIdHex},${link.discordGuildId},${link.discordChannelId},
          ${row.deleteRumorId},${row.targetRumorId},${row.author},${row.citation?tx.json(row.citation):null},${row.createdAtMs},
          ${row.actionClass!},${row.sourceWrapCreatedAt!},${row.firstObservedAtMs!},${row.expiresAtMs??null},${row.nextAttemptAtMs!},${row.attempts!},${row.innerCreatedAt??null},${row.innerEpoch??null})
          ON CONFLICT (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,delete_rumor_id,target_rumor_id)
          DO UPDATE SET action_class='actionable',expires_at_ms=NULL`;
        plan.outcome.disposedExpired+=expired; return plan.outcome;
      },link);
      observeDeletionDisposition(outcome);return outcome;
    } catch(error) { if(error instanceof ActionableDeletionCapacityError) error.link={...link};
      if(error instanceof DeletionIntakeError || error instanceof StaleDeliveryFenceError) throw error;
      throw new DeletionIntakeError('Concord deletion storage failed',{cause:error}); }
  }
  /** Inventory for diagnostics/tests. Scheduler uses the directly bounded due query. */
  async pendingDeletes(link:ChannelLink,target?:string):Promise<PendingConcordDelete[]> {
    const rows=await this.sql`SELECT * FROM pending_concord_deletes WHERE ${this.scope(this.sql,link)}
      ${target?this.sql`AND target_rumor_id=${target}`:this.sql``} ORDER BY created_at_ms,delete_rumor_id,target_rumor_id`;
    return rows.map(row=>this.deletion(row));
  }
  async dueDeletes(link:ChannelLink,target?:string):Promise<PendingConcordDelete[]> {
    const result=await this.write(async tx=>{
      const expired=await this.expire(tx,link);
      const rows=await tx`SELECT * FROM pending_concord_deletes WHERE ${this.scope(tx,link)}
        ${target?tx`AND target_rumor_id=${target}`:tx`AND next_attempt_at_ms <= floor(extract(epoch FROM clock_timestamp())*1000)`}
        ORDER BY next_attempt_at_ms,created_at_ms,delete_rumor_id,target_rumor_id LIMIT ${MAX_PENDING_DELETE_REPLAY_BATCH}`;
      return {expired,rows};
    },link);
    observeDeletionDisposition({stored:0,disposedExpired:result.expired,disposedCapacity:0});
    return result.rows.map(row=>this.deletion(row));
  }
  async promoteDelete(link:ChannelLink,row:PendingConcordDelete):Promise<void> {
    await this.saveDeletes(link,[{...row,actionClass:'actionable'}]);
  }
  async retryDelete(link:ChannelLink,row:PendingConcordDelete):Promise<void> {
    await this.write(async tx=>{await tx`UPDATE pending_concord_deletes SET
      next_attempt_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)+least(3600000,10000*power(2,least(attempts,9))),attempts=least(attempts+1,1000000)
      WHERE ${this.scope(tx,link)} AND delete_rumor_id=${row.deleteRumorId} AND target_rumor_id=${row.targetRumorId}`;},link);
  }
  async wakeDeletes(link:ChannelLink):Promise<void> {
    // A fold may wake repeatedly: accepted work must be able to free capacity
    // even when more than one batch of older promotions is blocked.
    await this.write(async tx=>{await tx`UPDATE pending_concord_deletes SET next_attempt_at_ms=CASE WHEN action_class='actionable' THEN 0 ELSE 1 END WHERE ${this.scope(tx,link)}`;},link);
  }
  async completeDelete(link: ChannelLink, deletion: string, target: string): Promise<void> {
    await this.write(async tx=>{await tx`DELETE FROM pending_concord_deletes WHERE ${this.scope(tx,link)}
      AND delete_rumor_id=${deletion} AND target_rumor_id=${target}`;},link);
  }

  async insert(row: MessageMappingRow): Promise<void> {
    if(this.bound && (row.communityId!==this.bound.link.communityId || row.concordChannelId!==this.bound.link.concordChannelIdHex || row.discordChannelId!==this.bound.link.discordChannelId)) throw new StaleDeliveryFenceError("Mapping scope mismatch");
    await this.write(async tx => {
    await tx`
      INSERT INTO messages (
        tenant_id, discord_message_id, discord_channel_id,
        concord_rumor_id, concord_channel_id, community_id,
        origin, author_ref, part_index
      ) VALUES (
        ${this.tenantId}, ${row.discordMessageId}, ${row.discordChannelId},
        ${row.concordRumorId}, ${row.concordChannelId}, ${row.communityId},
        ${row.origin}, ${row.authorRef}, ${row.partIndex}
      )
      ON CONFLICT DO NOTHING`;
    });
  }

  async byRumorId(rumorId: string): Promise<MessageMappingRow[]> {
    const rows = await this.sql`
      SELECT discord_message_id, discord_channel_id, concord_rumor_id,
             concord_channel_id, community_id, origin, author_ref, part_index
      FROM messages
      WHERE tenant_id = ${this.tenantId} AND concord_rumor_id = ${rumorId}`;
    return rows.map((r) => this.toRow(r));
  }

  async byDiscordId(discordMessageId: string): Promise<MessageMappingRow[]> {
    const rows = await this.sql`
      SELECT discord_message_id, discord_channel_id, concord_rumor_id,
             concord_channel_id, community_id, origin, author_ref, part_index
      FROM messages
      WHERE tenant_id = ${this.tenantId} AND discord_message_id = ${discordMessageId}`;
    return rows.map((r) => this.toRow(r));
  }

  async insertReaction(row: ReactionMappingRow): Promise<void> {
    await this.write(async tx => {
    await tx`
      INSERT INTO reaction_mappings (tenant_id, rumor_id, discord_message_id, emoji, origin, author_ref)
      VALUES (${this.tenantId}, ${row.rumorId}, ${row.discordMessageId}, ${row.emoji}, ${row.origin}, ${row.authorRef})
      ON CONFLICT DO NOTHING`;
    });
  }

  async reactionByDiscord(messageId: string, userId: string, emoji: string): Promise<ReactionMappingRow | undefined> {
    const rows = await this.sql`
      SELECT rumor_id, discord_message_id, emoji, origin, author_ref
      FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND discord_message_id = ${messageId}
        AND author_ref = ${userId} AND emoji = ${emoji}
      LIMIT 1`;
    return rows[0] ? this.toReactionRow(rows[0]) : undefined;
  }

  async reactionByRumorId(rumorId: string): Promise<ReactionMappingRow | undefined> {
    const rows = await this.sql`
      SELECT rumor_id, discord_message_id, emoji, origin, author_ref
      FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND rumor_id = ${rumorId}
      LIMIT 1`;
    return rows[0] ? this.toReactionRow(rows[0]) : undefined;
  }

  async retiredReaction(link: ChannelLink, rumorId: string): Promise<ReactionMappingRow | undefined> {
    const rows = await this.sql`SELECT rumor_id, discord_message_id, emoji, origin, author_ref
      FROM retired_concord_reactions WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId}
      AND concord_channel_id = ${link.concordChannelIdHex} AND discord_guild_id = ${link.discordGuildId}
      AND discord_channel_id = ${link.discordChannelId} AND rumor_id = ${rumorId}`;
    return rows[0] ? this.toReactionRow(rows[0]) : undefined;
  }

  async retireReaction(link: ChannelLink, row: ReactionMappingRow): Promise<void> {
    // A later distinct deletion still needs target evidence. Retire atomically
    // with active removal, rather than leaving a crash gap or deduping re-adds.
    await this.write(async tx => {
      await tx`INSERT INTO retired_concord_reactions
        (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id,
         rumor_id, discord_message_id, emoji, origin, author_ref)
        VALUES (${this.tenantId}, ${link.communityId}, ${link.concordChannelIdHex}, ${link.discordGuildId}, ${link.discordChannelId},
          ${row.rumorId}, ${row.discordMessageId}, ${row.emoji}, ${row.origin}, ${row.authorRef}) ON CONFLICT DO NOTHING`;
      await tx`DELETE FROM reaction_mappings WHERE tenant_id = ${this.tenantId} AND rumor_id = ${row.rumorId}`;
    },link);
  }

  async deleteReaction(rumorId: string): Promise<void> {
    await this.write(async tx => {
    await tx`
      DELETE FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND rumor_id = ${rumorId}`;
    });
  }

  async countConcordReactions(messageId: string, emoji: string): Promise<number> {
    const [row] = await this.sql`
      SELECT count(*)::int AS n FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND discord_message_id = ${messageId}
        AND emoji = ${emoji} AND origin = 'concord'`;
    return (row?.n as number) ?? 0;
  }

  /**
   * Newest processed wrap timestamp across a channel's stream addresses, or
   * undefined when this channel has never been tailed (fresh bridges do NOT
   * backfill: restored delivery must not replay history into Discord).
   * The pool merges relays, so cursors live under one sentinel relay_url.
   */
  async cursorGet(communityId: string, streamPks: string[]): Promise<number | undefined> {
    if (streamPks.length === 0) return undefined;
    const [row] = await this.sql`
      SELECT max(last_seen_at)::bigint AS at FROM cursors
      WHERE tenant_id = ${this.tenantId} AND community_id = ${communityId}
        AND stream_pk IN ${this.sql(streamPks)} AND relay_url = 'pool'`;
    return row?.at == null ? undefined : Number(row.at);
  }

  /** Full-link checkpoint: one bridge must never acknowledge another link's gap. */
  async channelCursorStart(link: ChannelLink, streamPks: string[]): Promise<number> {
    return this.write(async tx=>{
    const legacy = streamPks.length ? await tx`SELECT min(last_seen_at)::bigint AS at FROM cursors
      WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId}
        AND stream_pk IN ${tx(streamPks)} AND relay_url = 'pool'` : [];
    const floor = legacy[0]?.at == null ? Math.floor(Date.now() / 1000) : Number(legacy[0].at);
    await tx`INSERT INTO channel_delivery_checkpoints
      (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id, last_seen_at)
      VALUES (${this.tenantId}, ${link.communityId}, ${link.concordChannelIdHex}, ${link.discordGuildId}, ${link.discordChannelId}, ${floor})
      ON CONFLICT DO NOTHING`;
    const [row] = await tx`SELECT last_seen_at FROM channel_delivery_checkpoints
      WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId} AND concord_channel_id = ${link.concordChannelIdHex}
      AND discord_guild_id = ${link.discordGuildId} AND discord_channel_id = ${link.discordChannelId}`;
    return Number(row.last_seen_at);
    },link);
  }
  async channelCursorSet(link: ChannelLink, at: number): Promise<void> {
    return this.write(async tx=>{
    const rows = await tx`UPDATE channel_delivery_checkpoints SET last_seen_at = GREATEST(last_seen_at, ${at})
      WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId} AND concord_channel_id = ${link.concordChannelIdHex}
      AND discord_guild_id = ${link.discordGuildId} AND discord_channel_id = ${link.discordChannelId} RETURNING last_seen_at`;
    if (!rows.length) throw new Error("Channel delivery checkpoint must be established before admission");
    },link);
  }

  /** Advance (never rewind) the high-water mark for one stream address. */
  async cursorSet(communityId: string, streamPk: string, lastSeenAt: number): Promise<void> {
    await this.write(async tx => {
    await tx`
      INSERT INTO cursors (tenant_id, community_id, stream_pk, relay_url, last_seen_at)
      VALUES (${this.tenantId}, ${communityId}, ${streamPk}, 'pool', ${lastSeenAt})
      ON CONFLICT (tenant_id, community_id, stream_pk, relay_url)
      DO UPDATE SET last_seen_at = GREATEST(cursors.last_seen_at, EXCLUDED.last_seen_at)`;
    });
  }

  /** Control-plane observation; mutation must still compare the returned epoch. */
  async inspectDelivery(link:ChannelLink,transaction?:postgres.TransactionSql):Promise<DeliverySnapshot|undefined> {
    const sql=transaction ?? this.sql;
    const [row]=await sql`SELECT * FROM channel_delivery_lifecycles WHERE ${deliveryScope(sql,this.tenantId,link)}`;
    return row?deliverySnapshot(row):undefined;
  }

  /** Attach under a live lease, never reactivate from a stale control-plane row.
   * Only the migration's unconsumed eligibility may initialize missing state;
   * current persisted status and full scope must still authorize that upgrade. */
  async openDelivery(link:ChannelLink,ownerId:string,lease:DeliveryLeaseProof,streamPks:string[]=[],at=Math.floor(Date.now()/1000),sessionId=randomUUID(),relays:string[]=[]):
    Promise<{store:PostgresMappingStore;snapshot:DeliverySnapshot}> {
    const relaySet=[...new Set(relays)].sort();
    const snapshot=await this.sql.begin(async tx=>{
      await tx`SET LOCAL statement_timeout = '15s'`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      const row=await lockDelivery(tx,this.tenantId,link);
      if(lease.resource!==`discord:${link.discordGuildId}:${link.discordChannelId}`) throw new StaleDeliveryFenceError('Delivery lease scope mismatch');
      await assertLockedLease(tx,lease);
      if(row) {
        if(!row.active || row.suspended || row.owner_id!==ownerId) throw new StaleDeliveryFenceError('Delivery lifecycle is no longer current');
        if(row.worker_session===sessionId && row.worker_lease_holder===lease.holder && BigInt(row.worker_lease_token ?? -1)===lease.token && JSON.stringify(row.relay_set)===JSON.stringify(relaySet)) { await assertLockedLease(tx,lease); return deliverySnapshot(row); }
        const changed=row.relay_set!==null && JSON.stringify(row.relay_set)!==JSON.stringify(relaySet);
        const [armed]=await tx`UPDATE channel_delivery_lifecycles SET worker_session=${sessionId},worker_lease_holder=${lease.holder},worker_lease_token=${lease.token.toString()},worker_uncertain=true,worker_generation=worker_generation+1,
          repair_floor=CASE WHEN worker_uncertain OR ${changed} THEN 0 ELSE repair_floor END,
          ordinary_coverage=CASE WHEN ${changed} THEN COALESCE((SELECT jsonb_object_agg(key, max_value) FROM (SELECT key, max(value::bigint) AS max_value FROM (SELECT * FROM jsonb_each_text(ordinary_coverage) UNION ALL SELECT * FROM jsonb_each_text(coverage)) AS boundaries GROUP BY key) AS maxima), '{}'::jsonb) ELSE ordinary_coverage END,
          coverage=CASE WHEN ${changed} THEN '{}'::jsonb ELSE coverage END,relay_set=${tx.json(relaySet)},version=version+1
          WHERE ${deliveryScope(tx,this.tenantId,link)} RETURNING *`;
        await assertLockedLease(tx,lease);
        return deliverySnapshot(armed);
      }
      const eligible=await tx`SELECT 1 FROM channel_delivery_upgrade_eligibility
        WHERE ${deliveryScope(tx,this.tenantId,link)} AND owner_id=${ownerId} AND NOT consumed`;
      const status=ownerId===standaloneDeliveryOwner(link)
        ? await tx`SELECT 1 FROM channel_links WHERE ${deliveryScope(tx,this.tenantId,link)} AND enabled FOR SHARE`
        : await tx`SELECT 1 FROM bridges WHERE ${deliveryScope(tx,this.tenantId,link)} AND bridge_id::text=${ownerId} AND status='active' FOR SHARE`;
      if(!eligible.length || !status.length) throw new StaleDeliveryFenceError('Delivery lifecycle requires explicit activation');
      await this.activateDelivery(link,ownerId,streamPks,at,tx);
      // An upgraded owner has no proof that its prior worker stopped cleanly.
      const [armed]=await tx`UPDATE channel_delivery_lifecycles SET worker_session=${sessionId},worker_lease_holder=${lease.holder},worker_lease_token=${lease.token.toString()},worker_uncertain=true,worker_generation=worker_generation+1,
        repair_floor=0,relay_set=${tx.json(relaySet)},version=version+1 WHERE ${deliveryScope(tx,this.tenantId,link)} RETURNING *`;
      await assertLockedLease(tx,lease);
      return deliverySnapshot(armed);
    });
    return {snapshot,store:this.forDelivery(link,{ownerId,epoch:snapshot.epoch,sessionId,sessionGeneration:snapshot.sessionGeneration,lease})};
  }

  /** Authorized control-plane transition; pass tx to commit status and lifecycle together.
   * Worker attachment with the same active owner preserves the lifecycle. */
  async activateDelivery(link:ChannelLink,ownerId:string,streamPks:string[],at:number,transaction?:postgres.TransactionSql):Promise<DeliverySnapshot> {
    const run=async(tx:postgres.TransactionSql)=>{
      const old=await lockDelivery(tx,this.tenantId,link);
      if(old?.active && old.owner_id===ownerId) {
        if(!old.suspended) return deliverySnapshot(old);
        const [resumed]=await tx`UPDATE channel_delivery_lifecycles SET suspended=false,worker_session=NULL,worker_lease_holder=NULL,worker_lease_token=NULL,version=version+1
          WHERE ${deliveryScope(tx,this.tenantId,link)} RETURNING *`;
        return deliverySnapshot(resumed);
      }
      const eligible=await tx`SELECT legacy_boundaries FROM channel_delivery_upgrade_eligibility
        WHERE ${deliveryScope(tx,this.tenantId,link)} AND owner_id=${ownerId} AND NOT consumed FOR UPDATE`;
      const legacy:Record<string,number>={};
      if(!old && eligible.length) for(const [pk,value] of Object.entries(eligible[0].legacy_boundaries)) {
        legacy[pk]=Number(value)>at ? Math.max(0,at-1) : Number(value);
      }
      const unsafe=(!old && eligible.length)?await tx`SELECT last_seen_at FROM channel_delivery_checkpoints WHERE ${deliveryScope(tx,this.tenantId,link)}`:[];
      const floors=[at,...streamPks.flatMap(pk => legacy[pk] === undefined ? [] : [legacy[pk]]),...unsafe.map(row=>Number(row.last_seen_at))];
      // Keep the upgrade floor for future stream discovery after repair clears.
      // A fresh lifecycle has no legacy values, so its floor remains at.
      const floor=Math.min(...floors);
      await tx`UPDATE channel_delivery_upgrade_eligibility SET consumed=true WHERE ${deliveryScope(tx,this.tenantId,link)}`;
      if(old) {
        await tx`DELETE FROM pending_concord_deletes WHERE ${deliveryScope(tx,this.tenantId,link)}`;
        await tx`DELETE FROM retired_concord_reactions WHERE ${deliveryScope(tx,this.tenantId,link)}`;
        await tx`DELETE FROM channel_delivery_checkpoints WHERE ${deliveryScope(tx,this.tenantId,link)}`;
      }
      const [row]=await tx`INSERT INTO channel_delivery_lifecycles
        (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,owner_id,activation_floor,recovery_floor,repair_floor,legacy_boundaries,worker_uncertain,deletion_floor)
        VALUES (${this.tenantId},${link.communityId},${link.concordChannelIdHex},${link.discordGuildId},${link.discordChannelId},${ownerId},${at},${floor},${floor},${tx.json(legacy)},${eligible.length>0},${!old && eligible.length>0 ? 0 : at})
        ON CONFLICT (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id) DO UPDATE SET
        owner_id=EXCLUDED.owner_id,epoch=gen_random_uuid(),active=true,suspended=false,activation_floor=EXCLUDED.activation_floor,recovery_floor=EXCLUDED.recovery_floor,deletion_floor=EXCLUDED.deletion_floor,
        version=0,certified_until=NULL,repair_floor=EXCLUDED.repair_floor,coverage='{}',legacy_boundaries=EXCLUDED.legacy_boundaries,worker_uncertain=EXCLUDED.worker_uncertain,worker_session=NULL,worker_lease_holder=NULL,worker_lease_token=NULL,worker_generation=channel_delivery_lifecycles.worker_generation+1,relay_set=NULL,ordinary_coverage='{}' RETURNING *`;
      return deliverySnapshot(row);
    };
    return transaction?run(transaction):this.sql.begin(run) as Promise<DeliverySnapshot>;
  }
  /** Absent/different-owner/inactive returns false. A stale epoch for the same
   * owner throws, preventing an old severance callback from changing its relink's status. */
  async terminateDelivery(link:ChannelLink,ownerId:string,epoch:string|undefined,transaction?:postgres.TransactionSql):Promise<boolean> {
    const run=async(tx:postgres.TransactionSql)=>{
      const old=await lockDelivery(tx,this.tenantId,link);
      if(!old) {
        await tx`UPDATE channel_delivery_upgrade_eligibility SET consumed=true
          WHERE ${deliveryScope(tx,this.tenantId,link)} AND owner_id=${ownerId}`;
        return false;
      }
      if(old.owner_id!==ownerId) return false;
      if(old.epoch!==epoch) throw new StaleDeliveryFenceError('Control transition lifecycle epoch changed');
      if(!old.active) return false;
      await tx`UPDATE channel_delivery_lifecycles SET active=false,version=version+1 WHERE ${deliveryScope(tx,this.tenantId,link)}`;
      await tx`DELETE FROM pending_concord_deletes WHERE ${deliveryScope(tx,this.tenantId,link)}`;
      await tx`DELETE FROM retired_concord_reactions WHERE ${deliveryScope(tx,this.tenantId,link)}`;
      await tx`DELETE FROM channel_delivery_checkpoints WHERE ${deliveryScope(tx,this.tenantId,link)}`;
      return true;
    };
    return transaction?run(transaction):this.sql.begin(run) as Promise<boolean>;
  }
  /** Control-plane pause shares the epoch but revokes all current worker views. */
  async suspendDelivery(link:ChannelLink,ownerId:string,epoch:string,transaction?:postgres.TransactionSql):Promise<boolean> {
    const run=async(tx:postgres.TransactionSql)=>{
      const old=await lockDelivery(tx,this.tenantId,link);
      if(!old || old.owner_id!==ownerId) return false;
      if(old.epoch!==epoch) throw new StaleDeliveryFenceError('Control transition lifecycle epoch changed');
      if(!old.active) return false;
      await tx`UPDATE channel_delivery_lifecycles SET suspended=true,worker_session=NULL,worker_lease_holder=NULL,worker_lease_token=NULL,worker_generation=worker_generation+1,version=version+1
        WHERE ${deliveryScope(tx,this.tenantId,link)}`;
      return true;
    };
    return transaction?run(transaction):this.sql.begin(run) as Promise<boolean>;
  }
  async deliverySnapshot():Promise<DeliverySnapshot> {
    if(!this.bound) throw new Error('Delivery view required');
    return this.write(async tx=>{
      const [row]=await tx`SELECT * FROM channel_delivery_lifecycles WHERE ${this.scope(tx,this.bound!.link)}`;
      return deliverySnapshot(row);
    });
  }
  /** Lock this worker's immutable fence inside a caller-owned transaction. */
  async lockDeliveryFence(tx: postgres.TransactionSql): Promise<void> {
    if (!this.bound) throw new Error('Delivery view required');
    await lockDelivery(tx,this.tenantId,this.bound.link,this.bound.fence);
  }
  /** Recheck the locked lease after an intentional lifecycle transition. */
  async assertDeliveryLease(tx: postgres.TransactionSql): Promise<void> {
    if (!this.bound) throw new Error('Delivery view required');
    await assertLockedLease(tx,this.bound.fence.lease);
  }
  /** Serialize a worker-owned portal mutation with lifecycle and lease changes. */
  async withDeliveryFence<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    if (!this.bound) throw new Error('Delivery view required');
    return this.write(work);
  }
  /** Operational guards call this again immediately before external dispatch. */
  async assertDeliveryCurrent():Promise<void> { await this.deliverySnapshot(); }
  async markDeliveryGap(floor:number):Promise<DeliverySnapshot> {
    if(!this.bound) throw new Error('Delivery view required');
    return this.write(async tx=>{
      const [row]=await tx`UPDATE channel_delivery_lifecycles SET version=version+1,
        repair_floor=least(COALESCE(repair_floor,${floor}),${floor}) WHERE ${this.scope(tx,this.bound!.link)} RETURNING *`;
      return deliverySnapshot(row);
    });
  }
  async setDeliveryRelays(relays:string[]):Promise<DeliverySnapshot> {
    if(!this.bound) throw new Error('Delivery view required');
    const relaySet=[...new Set(relays)].sort();
    return this.write(async tx=>{
      const [current]=await tx`SELECT * FROM channel_delivery_lifecycles WHERE ${this.scope(tx,this.bound!.link)}`;
      if(JSON.stringify(current.relay_set)===JSON.stringify(relaySet)) return deliverySnapshot(current);
      const [row]=await tx`UPDATE channel_delivery_lifecycles SET relay_set=${tx.json(relaySet)},
        ordinary_coverage=COALESCE((SELECT jsonb_object_agg(key, max_value) FROM (SELECT key, max(value::bigint) AS max_value FROM (SELECT * FROM jsonb_each_text(ordinary_coverage) UNION ALL SELECT * FROM jsonb_each_text(coverage)) AS boundaries GROUP BY key) AS maxima), '{}'::jsonb),coverage='{}'::jsonb,repair_floor=0,version=version+1
        WHERE ${this.scope(tx,this.bound!.link)} RETURNING *`;
      return deliverySnapshot(row);
    });
  }
  async certifyDelivery(expectedVersion:number,until:number,coverage:Record<string,number>,complete=false):Promise<boolean> {
    if(!this.bound) throw new Error('Delivery view required');
    return this.write(async tx=>{
      const rows=await tx`UPDATE channel_delivery_lifecycles SET version=version+1,certified_until=greatest(certified_until,${until}),
        repair_floor=${complete?null:until+1},coverage=coverage || ${tx.json(coverage)} WHERE ${this.scope(tx,this.bound!.link)} AND version=${expectedVersion}
        AND (repair_floor IS NULL OR repair_floor<=${until}) RETURNING 1`;
      return rows.length===1;
    });
  }
  async dueDeletionLinks(limit=128,ownerIds?:readonly string[]):Promise<Array<{link:ChannelLink;ownerId:string;epoch:string}>> {
    if(ownerIds && !ownerIds.length) return [];
    const rows=await this.sql`SELECT l.community_id,l.concord_channel_id,l.discord_guild_id,l.discord_channel_id,l.owner_id,l.epoch
      FROM channel_delivery_lifecycles l WHERE l.tenant_id=${this.tenantId} AND l.active AND NOT l.suspended
      ${ownerIds?this.sql`AND l.owner_id IN ${this.sql([...ownerIds])}`:this.sql``}
      ${this.bound?this.sql`AND l.owner_id=${this.bound.fence.ownerId} AND l.epoch=${this.bound.fence.epoch}`:this.sql``}
      AND EXISTS
      (SELECT 1 FROM pending_concord_deletes p WHERE p.tenant_id=l.tenant_id AND p.community_id=l.community_id
      AND p.concord_channel_id=l.concord_channel_id AND p.discord_guild_id=l.discord_guild_id AND p.discord_channel_id=l.discord_channel_id
      AND p.next_attempt_at_ms<=floor(extract(epoch FROM clock_timestamp())*1000))
      ORDER BY (SELECT min(p.next_attempt_at_ms) FROM pending_concord_deletes p WHERE p.tenant_id=l.tenant_id AND p.community_id=l.community_id
      AND p.concord_channel_id=l.concord_channel_id AND p.discord_guild_id=l.discord_guild_id AND p.discord_channel_id=l.discord_channel_id)
      LIMIT ${Math.max(1,Math.min(128,limit))}`;
    return rows.map(row=>({link:{communityId:row.community_id,concordChannelIdHex:row.concord_channel_id,discordGuildId:row.discord_guild_id,discordChannelId:row.discord_channel_id,enabled:true},ownerId:row.owner_id,epoch:row.epoch}));
  }

  private toReactionRow(r: Record<string, unknown>): ReactionMappingRow {
    return {
      rumorId: r.rumor_id as string,
      discordMessageId: r.discord_message_id as string,
      emoji: r.emoji as string,
      origin: r.origin as "discord" | "concord",
      authorRef: r.author_ref as string,
    };
  }

  private toRow(r: Record<string, unknown>): MessageMappingRow {
    return {
      discordMessageId: r.discord_message_id as string,
      discordChannelId: r.discord_channel_id as string,
      concordRumorId: r.concord_rumor_id as string,
      concordChannelId: r.concord_channel_id as string,
      communityId: r.community_id as string,
      origin: r.origin as "discord" | "concord",
      authorRef: r.author_ref as string,
      partIndex: r.part_index as number,
    };
  }
}

/** Upsert the community + link rows for env-provisioned (MVP) bridges. */
export async function ensureLink(
  sql: postgres.Sql,
  link: ChannelLink,
  community: { idHex: string; relays: string[]; name?: string },
  tenantId = "default",
): Promise<void> {
  await sql`
    INSERT INTO communities (tenant_id, community_id, relays, name)
    VALUES (${tenantId}, ${community.idHex}, ${community.relays}, ${community.name ?? null})
    ON CONFLICT (tenant_id, community_id)
    DO UPDATE SET relays = EXCLUDED.relays, name = EXCLUDED.name`;
  await sql`
    INSERT INTO channel_links (
      tenant_id, discord_guild_id, discord_channel_id,
      community_id, concord_channel_id, enabled
    ) VALUES (
      ${tenantId}, ${link.discordGuildId}, ${link.discordChannelId},
      ${link.communityId}, ${link.concordChannelIdHex}, ${link.enabled}
    )
    ON CONFLICT (tenant_id, discord_channel_id, concord_channel_id)
    DO UPDATE SET enabled = EXCLUDED.enabled`;
}

/** The environment is an explicit first provision, but an existing row is
 * attach-only: a restart cannot revive a stopped lifecycle or disabled link. */
export async function provisionStandalone(sql: postgres.Sql, link: ChannelLink,
  community: { idHex: string; relays: string[]; name?: string }, streams: string[], at: number, tenant = 'default'): Promise<boolean> {
  const store = new PostgresMappingStore(sql, tenant);
  return sql.begin(async tx => {
    await tx`INSERT INTO communities (tenant_id,community_id,relays,name)
      VALUES (${tenant},${community.idHex},${community.relays},${community.name ?? null})
      ON CONFLICT (tenant_id,community_id) DO UPDATE SET relays=EXCLUDED.relays,name=EXCLUDED.name`;
    const inserted = await tx`INSERT INTO channel_links
      (tenant_id,discord_guild_id,discord_channel_id,community_id,concord_channel_id,enabled)
      VALUES (${tenant},${link.discordGuildId},${link.discordChannelId},${link.communityId},${link.concordChannelIdHex},true)
      ON CONFLICT (tenant_id,discord_channel_id,concord_channel_id) DO NOTHING RETURNING 1`;
    if (inserted.length) {
      // Lock before checking: a concurrent control transition must not be
      // replaced by an activation based on a stale empty observation.
      if (await lockDelivery(tx, tenant, link)) throw new Error('Standalone lifecycle already exists');
      await store.activateDelivery(link, standaloneDeliveryOwner(link), streams, at, tx);
      return true;
    }
    const [existing] = await tx`SELECT enabled FROM channel_links WHERE ${deliveryScope(tx,tenant,link)} FOR SHARE`;
    if (!existing) throw new Error('Standalone link scope changed');
    if (!existing.enabled) throw new Error('Standalone link is disabled');
    return false;
  }) as Promise<boolean>;
}
