import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { migrate } from '@armada-bridge/bridge/src/db/migrate';
import { PostgresMappingStore } from '@armada-bridge/bridge/src/db/store';
import { BridgeLeases, bridgeResource } from '@armada-bridge/bridge/src/db/leases';
import type { ChannelLink } from '@armada-bridge/bridge/src/router';
import { BridgeManager } from './manager';
import type { PortalEnv } from './env';
const url=process.env.DATABASE_URL;
const sql=postgres(url??'postgres://unused:unused@127.0.0.1:1/unused',{max:5,connect_timeout:2,onnotice(){}});
const reachable=url?await sql`SELECT 1`.then(()=>true,error=>{if(['ECONNREFUSED','ETIMEDOUT','CONNECT_TIMEOUT','ENOTFOUND'].includes(error.code))return false;throw error;}):false;
const id=crypto.randomUUID(), suffix=crypto.randomUUID(), link:ChannelLink={communityId:'a'.repeat(64),concordChannelIdHex:'b'.repeat(64),discordGuildId:`guild-${suffix}`,discordChannelId:`channel-${suffix}`,enabled:true};
const store=new PostgresMappingStore(sql), manager=new BridgeManager(sql,{mode:'legacy'} as PortalEnv);
beforeAll(async()=>{if(!reachable)return;await migrate(url!);await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id) VALUES (${id},'synthetic','active',${link.communityId},${link.concordChannelIdHex},${link.discordGuildId},${link.discordChannelId})`;});
afterAll(async()=>{if(reachable){await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${link.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${id}`;await sql`DELETE FROM bridge_leases WHERE resource=${bridgeResource(link.discordGuildId,link.discordChannelId)}`;}await sql.end();});
test.skipIf(!reachable)('operator pause fences a remote worker without losing its lifecycle',async()=>{
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
 try {
  const state=await store.activateDelivery(link,id,[],1000), view=(await store.openDelivery(link,id,lease)).store;
  await manager.stop(id,'paused');
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${id}`)[0].status).toBe('paused');
  await expect(view.assertDeliveryCurrent()).rejects.toThrow();
  const paused=await store.inspectDelivery(link);expect(paused?.epoch).toBe(state.epoch);expect(paused?.suspended).toBe(true);
  (manager as any).startTracked=async()=>{};
  await manager.resume(id);
  const resumed=await store.inspectDelivery(link);expect(resumed?.epoch).toBe(state.epoch);expect(resumed?.suspended).toBe(false);
  await expect(view.assertDeliveryCurrent()).rejects.toThrow();
  await (await store.openDelivery(link,id,lease)).store.assertDeliveryCurrent();
 } finally {await lease.release();}
});

test.skipIf(!reachable)('unlinking an older paused owner cannot terminate a newer owner',async()=>{
 const old=crypto.randomUUID(), current=crypto.randomUUID(), scope={...link,discordChannelId:`other-${suffix}`};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
    VALUES (${old},'synthetic','paused',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId}),
           (${current},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const active=await store.activateDelivery(scope,current,[],1000);
  await manager.stop(old,'unlinked');
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${old}`)[0].status).toBe('unlinked');
  const state=await store.inspectDelivery(scope);expect(state?.ownerId).toBe(current);expect(state?.epoch).toBe(active.epoch);expect(state?.active).toBe(true);
 } finally {await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id IN (${old},${current})`;}
});
