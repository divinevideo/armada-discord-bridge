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

test.skipIf(!reachable)('active delivery does not install a coordinator until session arming commits',async()=>{
 const scope={...link,discordChannelId:`arm-${suffix}`}, owner=crypto.randomUUID();
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 let release!:()=>void, entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}), locked=new Promise<void>(resolve=>{entered=resolve;});
 const rb:any={id:owner,link:scope,lease,channel:{streams:[]},pool:{urls:['wss://synthetic.example']},status:'active'};
 let blocker:Promise<unknown>|undefined;
 try {
  await store.activateDelivery(scope,owner,[],1000);
  blocker=sql.begin(async tx=>{await tx`SELECT 1 FROM bridge_leases WHERE resource=${lease.resource} FOR UPDATE`;entered();await held;});
  await locked;
  const arming=(manager as any).armDelivery(rb);
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(rb.delivery).toBeUndefined();expect(rb.deliveryStore).toBeUndefined();
  release();await blocker;await arming;
  expect(rb.delivery).toBeDefined();expect((await rb.deliveryStore.deliverySnapshot()).workerUncertain).toBe(true);
 } finally {release();await blocker;await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;}
});

test('one bounded scheduler query filters running owners before selecting due work',async()=>{
 const local=new BridgeManager({} as postgres.Sql,{} as PortalEnv) as any;
 const running=new Map<string,any>();for(let i=0;i<1100;i++)running.set(`owner-${i}`,{id:`owner-${i}`,status:'active',router:{},delivery:{},deliveryEpoch:'epoch',stopped:false});
 local.running=running;let queries=0, repairs=0, selected:string[]=[];
 local.store={dueDeletionLinks:async(limit:number,owners:string[])=>{queries++;expect(limit).toBe(128);expect(owners).toHaveLength(1100);return [{ownerId:'owner-1099',epoch:'epoch'}];}};
 local.retryDeletes=async(rb:any)=>{selected.push(rb.id);};
 local.backfillMissed=()=>{repairs++;return new Promise<void>(()=>{});};
 await local.tickDeliveries();
 expect(queries).toBe(1);expect(repairs).toBe(4);expect(selected).toEqual(['owner-1099']);
});

test.skipIf(!reachable)('confirmation installs no active handlers until worker arming succeeds',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`confirm-${suffix}`},key='ab'.repeat(32);
 const m=new BridgeManager(sql,{mode:'legacy',sealKeyHex:key} as PortalEnv) as any;
 const {seal}=await import('./seal');
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
 let attached=0,subscribed=0;
 const rb:any={id:owner,status:'pending_confirm',link:scope,channel:{streams:[]},lease:{release:async()=>{}},primary:{},
  client:{folded:{roster:{}},community:{owner:'synthetic-owner'},sendChat:async()=>{}},assertMayForward:async()=>{},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{},pool:{close:async()=>{}}};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,master_secret_sealed)
    VALUES (${owner},'synthetic','pending_confirm',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},${seal(key,'cd'.repeat(32))})`;
  m.running.set(owner,rb);m.adapter={};
  m.armDelivery=async()=>{entered();await blocked;};m.attachRouting=()=>{attached++;};m.subscribeChat=()=>{subscribed++;return ()=>{};};m.catchUpDiscord=async()=>{};
  const confirming=m.onConcordChat(rb,{kind:9,content:'/bridge confirm deadbeef',author:'synthetic-owner'},'deadbeef');
  await started;
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect(attached).toBe(0);expect(subscribed).toBe(0);
  release();await confirming;expect(attached).toBe(1);expect(subscribed).toBe(1);
 } finally {release();await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test('manager shutdown aborts delivery and bounds a stuck cleanup',async()=>{
 const local=new BridgeManager({} as postgres.Sql,{} as PortalEnv) as any;
 let stopped=false,released=false;const rb={id:'owner',status:'active',link:{discordChannelId:'channel'},delivery:{stop:()=>{stopped=true;}},
  lease:{release:async()=>{released=true;await new Promise<void>(()=>{});}},router:{},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{},pool:{close:async()=>{}}};
 local.running.set(rb.id,rb);local.byDiscordChannel.set('channel',rb.id);
 const completed=await Promise.race([local.shutdown(20).then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),200))]);
 expect(completed).toBe(true);expect(stopped).toBe(true);expect(released).toBe(true);expect(local.running.size).toBe(0);
});

test.skipIf(!reachable)('a stale severance callback cannot stop or mark a replacement',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`sever-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const close=()=>{};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
    VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const oldState=await store.activateDelivery(scope,owner,[],1000);await store.terminateDelivery(scope,owner,oldState.epoch);
  const nextState=await store.activateDelivery(scope,owner,[],2000);
  const old:any={id:owner,link:scope,deliveryEpoch:oldState.epoch,lease:{release:async()=>{}},pool:{close:async()=>{}},unsubChat:close,unsubControl:close,unsubSeverance:close};
  const replacement:any={...old,deliveryEpoch:nextState.epoch};m.running.set(owner,replacement);
  await m.applySeverance(owner,{reason:'banned',pubkey:'c'.repeat(64),bannedAtMs:1000},{idHex:scope.communityId},old);
  expect(m.running.get(owner)).toBe(replacement);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect((await store.inspectDelivery(scope))?.epoch).toBe(nextState.epoch);
 } finally {await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test('Discord-origin promotion failure trips the original repair floor',async()=>{
 const {LinkDelivery}=await import('@armada-bridge/bridge/src/concord/linkDelivery');
 const {PromotionDeletionIntakeError}=await import('@armada-bridge/bridge/src/deletionPolicy');
 const floors:number[]=[],lane=new LinkDelivery({onError:()=>{},onGap:async floor=>{floors.push(floor);}});
 const rb:any={delivery:lane,stopped:false}, local=new BridgeManager({} as postgres.Sql,{} as PortalEnv) as any;
 const error=new PromotionDeletionIntakeError({deleteRumorId:'d',targetRumorId:'t',author:'a',createdAtMs:100_000,sourceWrapCreatedAt:42},link,new Error('storage'));
 await expect(local.routeDiscord(rb,async()=>{throw error;})).rejects.toBe(error);
 await lane.flushGaps();expect(floors).toEqual([42]);
});

test.skipIf(!reachable)('a stale boot severance cannot terminate a replacement with the same bridge id',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`boot-sever-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
    VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const [row]=await sql`SELECT * FROM bridges WHERE bridge_id=${owner}`;
  const old=await store.activateDelivery(scope,owner,[],1000);await store.terminateDelivery(scope,owner,old.epoch);
  const next=await store.activateDelivery(scope,owner,[],2000);
  await m.applySeverance(owner,{reason:'banned',pubkey:'c'.repeat(64),bannedAtMs:1000},{idHex:scope.communityId},undefined,row,old.epoch);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect((await store.inspectDelivery(scope))?.epoch).toBe(next.epoch);
 } finally {await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('a stale seven-day failure cannot sever a replacement lifecycle',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`failure-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
    VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const [row]=await sql`SELECT * FROM bridges WHERE bridge_id=${owner}`;
  const old=await store.activateDelivery(scope,owner,[],1000);await store.terminateDelivery(scope,owner,old.epoch);
  const next=await store.activateDelivery(scope,owner,[],2000);
  await m.markSevered(owner,'synthetic old failure',row,old.epoch);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect((await store.inspectDelivery(scope))?.epoch).toBe(next.epoch);
 } finally {await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test('shutdown prevents a new worker arming transaction from starting',async()=>{
 const local=new BridgeManager({} as postgres.Sql,{} as PortalEnv) as any;
 let opened=0;local.shuttingDown=true;
 local.store={openDelivery:async()=>{opened++;return {store:{},snapshot:{epoch:'e',recoveryFloor:0}};}};
 const rb={id:'owner',link,lease:{},channel:{streams:[]},pool:{urls:['wss://synthetic.example']}};
 await expect(local.armDelivery(rb)).rejects.toThrow('stopped');expect(opened).toBe(0);
});

test.skipIf(!reachable)('confirmation with gateway down stays active but starts no delivery and schedules retry',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`gateway-${suffix}`},key='ab'.repeat(32);
 const m=new BridgeManager(sql,{mode:'legacy',sealKeyHex:key} as PortalEnv) as any;
 const {seal}=await import('./seal');let retries=0,subscriptions=0,effects=0;
 const rb:any={id:owner,status:'pending_confirm',link:scope,channel:{streams:[]},lease:{release:async()=>{}},primary:{},
  client:{folded:{roster:{}},community:{owner:'synthetic-owner'},sendChat:async()=>{effects++;}},assertMayForward:async()=>{},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{},pool:{close:async()=>{}}};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,master_secret_sealed)
    VALUES (${owner},'synthetic','pending_confirm',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},${seal(key,'cd'.repeat(32))})`;
  m.running.set(owner,rb);m.adapter=undefined;m.scheduleStartRetry=()=>{retries++;};m.subscribeChat=()=>{subscriptions++;return ()=>{};};
  await m.onConcordChat(rb,{kind:9,content:'/bridge confirm deadbeef',author:'synthetic-owner'},'deadbeef');
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect(rb.delivery).toBeUndefined();expect(subscriptions).toBe(0);expect(effects).toBe(0);expect(retries).toBe(1);expect(m.running.has(owner)).toBe(false);
 } finally {await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('seven-day start failure suspends accepted deletions until resume or unlink',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`failure-retain-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,confirm_code)
    VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},'deadbeef')`;
  const [row]=await sql`SELECT * FROM bridges WHERE bridge_id=${owner}`;
  const state=await store.activateDelivery(scope,owner,[],1000),opened=await store.openDelivery(scope,owner,lease);
  await opened.store.saveDeletes(scope,[{deleteRumorId:'d',targetRumorId:'t',author:'a',createdAtMs:Date.now(),sourceWrapCreatedAt:1,actionClass:'actionable'}]);
  await m.markSevered(owner,'synthetic seven-day outage',row,state.epoch);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('severed');
  expect((await store.inspectDelivery(scope))?.suspended).toBe(true);expect(await store.pendingDeletes(scope)).toHaveLength(1);
  await expect(opened.store.assertDeliveryCurrent()).rejects.toThrow();
  m.startTracked=async()=>{};await m.resume(owner);
  expect((await store.inspectDelivery(scope))?.epoch).toBe(state.epoch);expect(await store.pendingDeletes(scope)).toHaveLength(1);
  const resumed=await store.openDelivery(scope,owner,lease);expect(resumed.snapshot.repairFloor).toBe(0);
  await m.stop(owner,'unlinked');expect(await store.pendingDeletes(scope)).toHaveLength(0);
 } finally {await lease.release();await sql`DELETE FROM pending_concord_deletes WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('a bridge ban suspends accepted deletions and authorized resume preserves them',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`ban-retain-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,confirm_code)
    VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},'deadbeef')`;
  const state=await store.activateDelivery(scope,owner,[],1000),opened=await store.openDelivery(scope,owner,lease);
  await opened.store.saveDeletes(scope,[{deleteRumorId:'d',targetRumorId:'t',author:'a',createdAtMs:Date.now(),sourceWrapCreatedAt:1,actionClass:'actionable'}]);
  const rb:any={id:owner,status:'active',link:scope,deliveryEpoch:state.epoch,lease:{release:async()=>{}},pool:{close:async()=>{}},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{}};m.running.set(owner,rb);
  await m.applySeverance(owner,{reason:'banned',pubkey:'c'.repeat(64),bannedAtMs:1000},{idHex:scope.communityId},rb);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('severed');
  expect((await store.inspectDelivery(scope))?.suspended).toBe(true);expect(await store.pendingDeletes(scope)).toHaveLength(1);
  await expect(opened.store.assertDeliveryCurrent()).rejects.toThrow();
  m.startTracked=async()=>{};await m.resume(owner);
  expect((await store.inspectDelivery(scope))?.epoch).toBe(state.epoch);expect(await store.pendingDeletes(scope)).toHaveLength(1);
  expect((await store.openDelivery(scope,owner,lease)).snapshot.repairFloor).toBe(0);
  await m.stop(owner,'unlinked');expect(await store.pendingDeletes(scope)).toHaveLength(0);
 } finally {await lease.release();await sql`DELETE FROM pending_concord_deletes WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('a delayed severance cannot overwrite an operator pause',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`paused-verdict-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
    VALUES (${owner},'synthetic','paused',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const state=await store.activateDelivery(scope,owner,[],1000);await store.suspendDelivery(scope,owner,state.epoch);
  const rb:any={id:owner,status:'active',link:scope,deliveryEpoch:state.epoch,lease:{release:async()=>{}},pool:{close:async()=>{}},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{}};m.running.set(owner,rb);
  await m.applySeverance(owner,{reason:'banned',pubkey:'c'.repeat(64),bannedAtMs:1000},{idHex:scope.communityId},rb);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('paused');
  expect((await store.inspectDelivery(scope))?.suspended).toBe(true);
 } finally {await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});
