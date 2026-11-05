import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test';
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
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 const {seal}=await import('./seal');
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
 let attached=0,subscribed=0;
 const rb:any={id:owner,status:'pending_confirm',link:scope,channel:{streams:[]},lease,primary:{},
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
 } finally {release();await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
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
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;m.scheduleStartRetry=()=>{};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
    VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  await sql`UPDATE bridges SET options=${sql.json({startFailedAt:'2020-01-01T00:00:00.000Z'})} WHERE bridge_id=${owner}`;
  const [row]=await sql`SELECT * FROM bridges WHERE bridge_id=${owner}`;
  const old=await store.activateDelivery(scope,owner,[],1000);await store.terminateDelivery(scope,owner,old.epoch);
  const next=await store.activateDelivery(scope,owner,[],2000);
  await m.handleStartFailure(row,'synthetic old failure',0,old.epoch,lease);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect((await store.inspectDelivery(scope))?.epoch).toBe(next.epoch);
 } finally {await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
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
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 const {seal}=await import('./seal');let retries=0,subscriptions=0,effects=0;
 const log=spyOn(console,'warn').mockImplementation(()=>{});
 const rb:any={id:owner,status:'pending_confirm',link:scope,channel:{streams:[]},lease,primary:{},
  client:{folded:{roster:{}},community:{owner:'synthetic-owner'},sendChat:async()=>{effects++;}},assertMayForward:async()=>{},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{},pool:{close:async()=>{}}};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,master_secret_sealed)
    VALUES (${owner},'synthetic','pending_confirm',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},${seal(key,'cd'.repeat(32))})`;
  m.running.set(owner,rb);m.adapter=undefined;m.scheduleStartRetry=()=>{retries++;};m.subscribeChat=()=>{subscriptions++;return ()=>{};};
  await m.onConcordChat(rb,{kind:9,content:'/bridge confirm deadbeef',author:'synthetic-owner'},'deadbeef');
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect(rb.delivery).toBeUndefined();expect(subscriptions).toBe(0);expect(effects).toBe(0);expect(retries).toBe(1);expect(m.running.has(owner)).toBe(false);expect(log.mock.calls.some(call=>String(call[0]).includes('delivery deferred'))).toBe(true);
 } finally {log.mockRestore();await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('seven-day start failure suspends accepted deletions until resume or unlink',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`failure-retain-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,confirm_code)
    VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},'deadbeef')`;
  await sql`UPDATE bridges SET options=${sql.json({startFailedAt:'2020-01-01T00:00:00.000Z'})} WHERE bridge_id=${owner}`;
  const [row]=await sql`SELECT * FROM bridges WHERE bridge_id=${owner}`;
  const state=await store.activateDelivery(scope,owner,[],1000),opened=await store.openDelivery(scope,owner,lease);
  await opened.store.saveDeletes(scope,[{deleteRumorId:'d',targetRumorId:'t',author:'a',createdAtMs:Date.now(),sourceWrapCreatedAt:1,actionClass:'actionable'}]);
  await m.handleStartFailure(row,'synthetic seven-day outage',0,state.epoch,lease);
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
  const rb:any={id:owner,status:'active',link:scope,deliveryEpoch:state.epoch,deliveryStore:opened.store,lease:{release:async()=>{}},pool:{close:async()=>{}},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{}};m.running.set(owner,rb);
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
 m.scheduleStartRetry=()=>{};
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

test.skipIf(!reachable)('stale workers cannot claim permission or welcome announcements',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`notice-${suffix}`};
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 const m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;let sends=0;
 const log=spyOn(console,'warn').mockImplementation(()=>{});
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
   VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const state=await store.activateDelivery(scope,owner,[],1000), view=(await store.openDelivery(scope,owner,lease)).store;
  const rb:any={id:owner,link:scope,channel:{},primary:{},deliveryStore:view,client:{sendChat:async()=>{sends++;}},assertMayForward:()=>view.assertDeliveryCurrent()};
  m.adapter={notice:async()=>{sends++;},send:async()=>{sends++;}};
  await m.alertDiscordPermission(rb,'Manage Messages');await m.announceBridge(rb);
  expect(sends).toBe(4);expect(log.mock.calls.some(call=>String(call[0]).includes('Manage Messages'))).toBe(true);
  await sql`UPDATE bridges SET perm_alerted_at=NULL,announced_at=NULL,status_detail=NULL WHERE bridge_id=${owner}`;
  sends=0;
  await store.suspendDelivery(scope,owner,state.epoch);
  await expect(m.alertDiscordPermission(rb,'Manage Messages')).rejects.toThrow();
  await expect(m.announceBridge(rb)).rejects.toThrow();
  const [row]=await sql`SELECT perm_alerted_at,announced_at,status_detail FROM bridges WHERE bridge_id=${owner}`;
  expect(row.perm_alerted_at).toBeNull();expect(row.announced_at).toBeNull();expect(row.status_detail).toBeNull();expect(sends).toBe(0);
 } finally {log.mockRestore();await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('a stale worker cannot clear newer lifecycle metadata',async()=>{
 const owner=crypto.randomUUID(),scope={...link,communityId:`metadata-${suffix}`,discordChannelId:`metadata-${suffix}`};
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 const m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,options,status_detail)
   VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},${sql.json({startFailedAt:'2020-01-01T00:00:00.000Z'})},'new failure')`;
  const state=await store.activateDelivery(scope,owner,[],1000), view=(await store.openDelivery(scope,owner,lease)).store;
  const [row]=await sql`SELECT * FROM bridges WHERE bridge_id=${owner}`;
  const rb:any={id:owner,link:scope,status:'active',lease,deliveryStore:view};m.running.set(owner,rb);
  await sql`INSERT INTO communities(tenant_id,community_id,relays,severed_reason) VALUES ('default',${scope.communityId},ARRAY[]::text[],'banned')`;
  await m.clearSeveredReason(row,rb);
  expect((await sql`SELECT severed_reason FROM communities WHERE community_id=${scope.communityId}`)[0].severed_reason).toBeNull();
  await sql`UPDATE communities SET severed_reason='banned' WHERE community_id=${scope.communityId}`;
  await store.suspendDelivery(scope,owner,state.epoch);
  await expect(m.clearSeveredReason(row,rb)).rejects.toThrow();
  expect((await sql`SELECT severed_reason FROM communities WHERE community_id=${scope.communityId}`)[0].severed_reason).toBe('banned');
  await expect(m.clearStartFailure(row,rb)).rejects.toThrow();
  const [current]=await sql`SELECT options,status_detail FROM bridges WHERE bridge_id=${owner}`;
  expect(current.options.startFailedAt).toBeDefined();expect(current.status_detail).toBe('new failure');
 } finally {m.running.delete(owner);await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;await sql`DELETE FROM communities WHERE community_id=${scope.communityId}`;}
});

test.skipIf(!reachable)('a stale session cannot sever a replacement of the same lifecycle',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`session-sever-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 m.scheduleStartRetry=()=>{};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
   VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const state=await store.activateDelivery(scope,owner,[],1000),old=await store.openDelivery(scope,owner,lease);
  const rb:any={id:owner,status:'active',link:scope,deliveryEpoch:state.epoch,deliveryStore:old.store,lease,pool:{close:async()=>{}},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{}};
  m.running.set(owner,rb);const fresh=await store.openDelivery(scope,owner,lease);
  await expect(m.applySeverance(owner,{reason:'banned',pubkey:'c'.repeat(64),bannedAtMs:1000},{idHex:scope.communityId},rb)).rejects.toThrow();
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  await fresh.store.assertDeliveryCurrent();
 } finally {m.running.delete(owner);await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('an expired startup lease cannot alter a replacement failure streak',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`start-stale-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const leases=new BridgeLeases(sql),old=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;let fresh:any;
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
   VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const state=await store.activateDelivery(scope,owner,[],1000),[row]=await sql`SELECT * FROM bridges WHERE bridge_id=${owner}`;
  await old.release();fresh=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
  await expect(m.handleStartFailure(row,'old failure',0,state.epoch,old)).rejects.toThrow();
  const [current]=await sql`SELECT status,status_detail,options FROM bridges WHERE bridge_id=${owner}`;
  expect(current.status).toBe('active');expect(current.status_detail).toBeNull();expect(current.options.startFailedAt).toBeUndefined();
 } finally {await old.release();await fresh?.release();await sql`DELETE FROM bridge_leases WHERE resource=${old.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test('start bookkeeping never borrows a replacement worker',async()=>{
 const m=new BridgeManager({} as postgres.Sql,{} as PortalEnv) as any;
 const old={id:'owner'},replacement={id:'owner'};let cleared=0;
 m.start=async()=>{m.running.set('owner',replacement);return old;};
 m.clearStartFailure=async()=>{cleared++;};m.clearSeveredReason=async()=>{cleared++;};
 await m.startTracked({bridge_id:'owner',status:'active'});
 expect(cleared).toBe(0);expect(m.running.get('owner')).toBe(replacement);
});

test.skipIf(!reachable)('severance cannot commit after its captured lease expires',async()=>{
 const owner=crypto.randomUUID(),scope={...link,communityId:`lease-expiry-${suffix}`,discordChannelId:`lease-expiry-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{entered=resolve;});let blocker:Promise<unknown>|undefined;
 m.scheduleStartRetry=()=>{};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
   VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  await sql`INSERT INTO communities(tenant_id,community_id,relays) VALUES ('default',${scope.communityId},ARRAY[]::text[])`;
  const state=await store.activateDelivery(scope,owner,[],1000),opened=await store.openDelivery(scope,owner,lease);
  const rb:any={id:owner,status:'active',link:scope,deliveryEpoch:state.epoch,deliveryStore:opened.store,lease,pool:{close:async()=>{}},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{}};m.running.set(owner,rb);
  blocker=sql.begin(async tx=>{await tx`UPDATE communities SET name='held' WHERE community_id=${scope.communityId}`;entered();await held;});await locked;
  await sql`UPDATE bridge_leases SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE resource=${lease.resource}`;
  const sever=m.applySeverance(owner,{reason:'banned',pubkey:'c'.repeat(64),bannedAtMs:1000},{idHex:scope.communityId},rb);
  await new Promise(resolve=>setTimeout(resolve,250));release();await blocker;
  await expect(sever).rejects.toThrow();
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('active');
  expect((await store.inspectDelivery(scope))?.suspended).toBe(false);
 } finally {release();await blocker; m.running.delete(owner);await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;await sql`DELETE FROM communities WHERE community_id=${scope.communityId}`;}
});

test.skipIf(!reachable)('a stale confirmation cannot activate after lease takeover',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`confirm-race-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const leases=new BridgeLeases(sql),lease=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;let replacement:any, pending:Promise<unknown>|undefined;
 const rb:any={id:owner,status:'pending_confirm',link:scope,channel:{streams:[]},lease,primary:{},client:{folded:{roster:{}},community:{owner:'owner'},sendChat:async()=>{}},assertMayForward:async()=>{},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{},pool:{close:async()=>{}}};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id) VALUES (${owner},'synthetic','pending_confirm',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  m.running.set(owner,rb);m.adapter={};m.armDelivery=async()=>{throw new Error('stale arming');};m.scheduleStartRetry=()=>{};
  await sql.begin(async tx=>{
   await tx`SELECT 1 FROM bridge_leases WHERE resource=${lease.resource} FOR UPDATE`;
   pending=m.onConcordChat(rb,{kind:9,content:'/bridge confirm deadbeef',author:'owner'},'deadbeef').then(()=>undefined,(e:unknown)=>e);
   await new Promise(resolve=>setTimeout(resolve,30));
   await tx`UPDATE bridge_leases SET expires_at=clock_timestamp() WHERE resource=${lease.resource}`;
   replacement=await new BridgeLeases(tx as unknown as postgres.Sql).acquire(lease.resource);
  });
  await pending;expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('pending_confirm');
  expect(await store.inspectDelivery(scope)).toBeUndefined();
 } finally {m.running.delete(owner);await lease.release();await replacement?.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test('a failed severance write unregisters and retries the stopped worker',async()=>{
 const m=new BridgeManager({begin:async()=>{throw new Error('synthetic database outage');}} as unknown as postgres.Sql,{} as PortalEnv) as any;
 let released=0,closed=0,retries=0;const rb:any={id:'owner',status:'active',link:{discordChannelId:'channel'},lease:{release:async()=>{released++;}},delivery:{stop:()=>{}},pool:{close:async()=>{closed++;}},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{}};
 m.running.set(rb.id,rb);m.byDiscordChannel.set('channel',rb.id);m.scheduleStartRetry=()=>{retries++;};
 await expect(m.applySeverance(rb.id,{reason:'dissolved'},{idHex:'synthetic'},rb)).rejects.toThrow('synthetic database outage');
 expect(m.isLive(rb.id)).toBe(false);expect(released).toBe(1);expect(closed).toBe(1);expect(retries).toBe(1);
});

test.skipIf(!reachable)('queued pending signed payloads never bypass the armed lane',async()=>{
 const {moderationFixture}=await import('../../../scripts/fixtures/moderation-events');
 const {channelsView,controlGroups,foldControlState,openControlWraps}=await import('@armada-bridge/concord-core');
 const {ConcordClient}=await import('@armada-bridge/bridge/src/concord/client');
 const {localIdentity}=await import('@armada-bridge/bridge/src/concord/signer');
 const {LinkDelivery}=await import('@armada-bridge/bridge/src/concord/linkDelivery');
 const {PromotionDeletionIntakeError}=await import('@armada-bridge/bridge/src/deletionPolicy');
 const {generateSecretKey}=await import('nostr-tools/pure');const {seal}=await import('./seal');
 const f=await moderationFixture(),channel=channelsView(f.community,foldControlState(openControlWraps(f.policy.controlEvents,controlGroups(f.community)),f.community.id,f.owner.pk))[0];
 const scope={...link,communityId:f.community.idHex,concordChannelIdHex:channel.idHex,discordChannelId:`handoff-${suffix}`},owner=crypto.randomUUID(),key='ab'.repeat(32);
 let subscriptions:Array<(event:any)=>void>=[],retained:any[]=[];const originalNow=Date.now;
 const pool:any={urls:['wss://synthetic.example'],replayRelays:['wss://synthetic.example'],publish:async()=>{},subscribe:(_filters:any,h:any)=>{subscriptions.push(h.onEvent);return()=>{subscriptions=subscriptions.filter(x=>x!==h.onEvent);};},close:async()=>{},
  enumerateRelay:async(_url:string,filter:any)=>retained.filter(e=>e.created_at>=filter.since&&e.created_at<=filter.until).map(e=>e.id),fetchRelay:async(_url:string,ids:string[])=>retained.filter(e=>ids.includes(e.id))};
 const client=new ConcordClient(f.community,pool,localIdentity(generateSecretKey()));client.folded=foldControlState(openControlWraps(f.policy.controlEvents,controlGroups(f.community)),f.community.id,f.owner.pk);
 const lease=(await new BridgeLeases(sql).acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 const m=new BridgeManager(sql,{mode:'legacy',sealKeyHex:key} as PortalEnv) as any;let enter!:()=>void,release!:()=>void,armed!:()=>void;
 const blocked=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{enter=r;}),ready=new Promise<void>(r=>{armed=r;});const floors:number[]=[],seen:string[]=[];
 let armedStore:any;
 const lane=new LinkDelivery({onError:()=>{},onGap:async floor=>{floors.push(floor);await armedStore.markDeliveryGap(floor);}});
 const log=spyOn(console,'error').mockImplementation(()=>{});
 const rb:any={id:owner,status:'pending_confirm',link:scope,channel,lease,client,primary:localIdentity(generateSecretKey()),assertMayForward:async()=>{},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{},pool};
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id,master_secret_sealed) VALUES (${owner},'synthetic','pending_confirm',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId},${seal(key,'cd'.repeat(32))})`;
  m.running.set(owner,rb);m.adapter={};m.armDelivery=async()=>{const opened=await store.openDelivery(scope,owner,lease,channel.streams.map(s=>s.group.pk),Math.floor(Date.now()/1000),crypto.randomUUID(),pool.urls);armedStore=opened.store;rb.deliveryStore=opened.store;rb.delivery=lane;void lane.run(async()=>{enter();await blocked;});await entered;};
  m.attachRouting=()=>{rb.router={onConcordChat:async(chat:any)=>{seen.push(chat.content);if(chat.content==='active failure')throw new PromotionDeletionIntakeError({deleteRumorId:'d',targetRumorId:'t',author:'a',createdAtMs:1,sourceWrapCreatedAt:123},scope,new Error('synthetic'));return [];}};armed();};m.catchUpDiscord=async()=>{};
  rb.unsubChat=m.subscribeChat(rb,'deadbeef');
  const confirm=(await client.sendChat(channel,{content:'/bridge confirm deadbeef',author:f.owner as any})).wrap;
  Date.now=()=>confirm.created_at*1000;
  const queued=(await client.sendChat(channel,{content:'queued before activation',author:f.member as any})).wrap;
  const queuedDelete=(await client.sendChat(channel,{content:'',kind:5,tags:[['e','ab'.repeat(32)]],author:f.member as any})).wrap;
  subscriptions[0](confirm);subscriptions[0](queued);subscriptions[0](queuedDelete);await ready;await new Promise(r=>setTimeout(r,20));
  expect(seen).toEqual([]);
  const active=(await client.sendChat(channel,{content:'active failure',author:f.member as any})).wrap;subscriptions[0](active);
  await new Promise(r=>setTimeout(r,10));expect(seen).toEqual([]);release();
  await lane.run(async()=>{});await lane.flushGaps();expect(seen).toEqual(['active failure']);expect(floors).toContain(123);expect((await armedStore.deliverySnapshot()).repairFloor).toBe(123);expect(log.mock.calls.some(call=>String(call[0]).includes('chat subscription dispatch'))).toBe(true);
  // The retired control feeder did not acknowledge its queued durable carrier.
  // Once the frozen replay upper reaches that second, real relay inventory and
  // window certification recover it through the active lane.
  retained=[queued,queuedDelete];Date.now=()=> (queued.created_at+120)*1000;
  await lane.repair({discover: async () => () => {}, store:armedStore,channel:()=>channel,
   replay:(c,s,opts)=>client.backfillChannel(c,s,500,opts),deliver:chat=>m.deliverRoutedChat(rb,chat)});
  expect(seen[0]).toBe('active failure');expect(seen.slice(1).sort()).toEqual(['','queued before activation']);
  const completed=await armedStore.deliverySnapshot();expect(completed.repairFloor).toBeUndefined();expect(completed.certifiedUntil).toBe(queued.created_at+60);
 } finally {Date.now=originalNow;log.mockRestore();release();lane.stop();m.running.delete(owner);await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});

test.skipIf(!reachable)('a transient severance failure retries and preserves accepted deletion',async()=>{
 const owner=crypto.randomUUID(),scope={...link,discordChannelId:`sever-retry-${suffix}`},m=new BridgeManager(sql,{mode:'legacy'} as PortalEnv) as any;
 const leases=new BridgeLeases(sql),first=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;let second:any,retries=0;
 const make=(lease:any,view:any,epoch:string)=>({id:owner,status:'active',link:scope,deliveryEpoch:epoch,deliveryStore:view,lease,pool:{close:async()=>{}},unsubChat:()=>{},unsubControl:()=>{},unsubSeverance:()=>{}});
 try {
  await sql`INSERT INTO bridges(bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id) VALUES (${owner},'synthetic','active',${scope.communityId},${scope.concordChannelIdHex},${scope.discordGuildId},${scope.discordChannelId})`;
  const state=await store.activateDelivery(scope,owner,[],1000),view=(await store.openDelivery(scope,owner,first)).store;
  await view.saveDeletes(scope,[{deleteRumorId:'d',targetRumorId:'t',author:'a',createdAtMs:Date.now(),sourceWrapCreatedAt:1,actionClass:'actionable'}]);
  const old=make(first,view,state.epoch);m.running.set(owner,old);m.scheduleStartRetry=()=>{retries++;};
  m.sql=new Proxy(sql,{get(target,key){if(key==='begin')return async()=>{throw new Error('synthetic outage');};return Reflect.get(target,key,target);}});
  await expect(m.applySeverance(owner,{reason:'dissolved'},{idHex:scope.communityId},old)).rejects.toThrow('synthetic outage');
  expect(m.isLive(owner)).toBe(false);expect(retries).toBe(1);expect(await store.pendingDeletes(scope)).toHaveLength(1);
  m.sql=sql;second=(await leases.acquire(first.resource))!;const fresh=(await store.openDelivery(scope,owner,second)).store;
  const current=make(second,fresh,state.epoch);m.running.set(owner,current);
  await m.applySeverance(owner,{reason:'dissolved'},{idHex:scope.communityId},current);
  expect((await sql`SELECT status FROM bridges WHERE bridge_id=${owner}`)[0].status).toBe('severed');
  expect((await store.inspectDelivery(scope))?.suspended).toBe(true);expect(await store.pendingDeletes(scope)).toHaveLength(1);
 } finally {m.running.delete(owner);await first.release();await second?.release();await sql`DELETE FROM pending_concord_deletes WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridge_leases WHERE resource=${first.resource}`;await sql`DELETE FROM channel_delivery_lifecycles WHERE discord_channel_id=${scope.discordChannelId}`;await sql`DELETE FROM bridges WHERE bridge_id=${owner}`;}
});
