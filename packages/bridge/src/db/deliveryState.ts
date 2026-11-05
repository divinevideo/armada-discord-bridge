import type postgres from 'postgres';
import type { ChannelLink } from '../router';
import { deletionLinkKey } from '../router';
import { bridgeResource } from './leases';
import type { BridgeLease } from './leases';
export type DeliveryLeaseProof = Pick<BridgeLease,'resource'|'holder'|'token'>;
export interface DeliveryFence { ownerId: string; epoch: string; sessionId: string; sessionGeneration: number; lease: DeliveryLeaseProof; }
export interface DeliverySnapshot {
 ownerId: string; epoch: string; active: boolean; suspended: boolean; version: number; activationFloor: number; recoveryFloor: number; deletionFloor?: number; workerUncertain: boolean; sessionGeneration: number; sessionId?: string;
 certifiedUntil?: number; repairFloor?: number; coverage: Record<string,number>; ordinaryCoverage: Record<string,number>; relays?: string[]; legacyBoundaries: Record<string,number>;
}
export class StaleDeliveryFenceError extends Error {}
export const standaloneDeliveryOwner = (link: ChannelLink): string => `standalone:${link.discordGuildId}:${link.discordChannelId}:${link.communityId}:${link.concordChannelIdHex}`;
export function deliveryScope(sql: postgres.Sql | postgres.TransactionSql, tenant: string, link: ChannelLink) {
 return sql`tenant_id=${tenant} AND community_id=${link.communityId} AND concord_channel_id=${link.concordChannelIdHex}
 AND discord_guild_id=${link.discordGuildId} AND discord_channel_id=${link.discordChannelId}`;
}
export function deliverySnapshot(row: Record<string,any>): DeliverySnapshot {
 return { ownerId:row.owner_id, epoch:row.epoch, active:row.active,suspended:row.suspended,version:Number(row.version),activationFloor:Number(row.activation_floor),recoveryFloor:Number(row.recovery_floor),deletionFloor:Number(row.deletion_floor),workerUncertain:row.worker_uncertain,sessionGeneration:Number(row.worker_generation),...(row.worker_session ? {sessionId:row.worker_session}:{}),
 ...(row.certified_until == null ? {} : {certifiedUntil:Number(row.certified_until)}),
 ...(row.repair_floor == null ? {} : {repairFloor:Number(row.repair_floor)}),coverage:row.coverage,ordinaryCoverage:row.ordinary_coverage,...(row.relay_set ? {relays:row.relay_set}:{}),legacyBoundaries:row.legacy_boundaries };
}
/** Lock order is shared by control transitions, worker writes and lease takeover.
 * The row lock (not an MVCC EXISTS preflight) serializes the actual mutation. */
export async function lockDelivery(tx: postgres.TransactionSql, tenant: string, link: ChannelLink, fence?: DeliveryFence): Promise<Record<string,any> | undefined> {
 const resource=bridgeResource(link.discordGuildId,link.discordChannelId);
 await tx`SELECT 1 FROM bridge_leases WHERE resource=${resource} FOR UPDATE`;
 if(fence) {
   if(fence.lease.resource!==resource) throw new StaleDeliveryFenceError('Delivery lease scope mismatch');
   await assertLockedLease(tx,fence.lease);
 }
 await tx`SELECT pg_advisory_xact_lock(hashtextextended(${tenant + deletionLinkKey(link)},19306))`;
 const [row]=await tx`SELECT * FROM channel_delivery_lifecycles WHERE ${deliveryScope(tx,tenant,link)} FOR UPDATE`;
 if(fence && (!row?.active || row.suspended || row.owner_id !== fence.ownerId || row.epoch !== fence.epoch)) throw new StaleDeliveryFenceError('Delivery lifecycle is no longer current');
 if(fence && (!fence.sessionId || row.worker_session !== fence.sessionId || Number(row.worker_generation) !== fence.sessionGeneration)) throw new StaleDeliveryFenceError('Delivery worker session is no longer current');
 return row;
}

/** Called after acquiring the row lock and again immediately before commit;
 * waiting on a lock or a slow write must not extend a time-limited lease. */
export async function assertLockedLease(tx:postgres.TransactionSql,lease:DeliveryLeaseProof):Promise<void> {
 const rows=await tx`SELECT 1 FROM bridge_leases WHERE resource=${lease.resource} AND holder=${lease.holder}
   AND token=${lease.token.toString()} AND expires_at>clock_timestamp()`;
 if(!rows.length) throw new StaleDeliveryFenceError('Delivery lease is no longer current');
}
