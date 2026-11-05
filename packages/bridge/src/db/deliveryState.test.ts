import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { migrate } from './migrate';
import { PostgresMappingStore } from './store';
import { BridgeLeases, bridgeResource } from './leases';
import type { ChannelLink } from '../router';
const url = process.env.DATABASE_URL;
const sql = postgres(url ?? 'postgres://unused:unused@127.0.0.1:1/unused', { max:8, connect_timeout:2,onnotice(){} });
const reachable = url ? await sql`SELECT 1`.then(()=>true,error=>{ if (['ECONNREFUSED','ETIMEDOUT','CONNECT_TIMEOUT','ENOTFOUND'].includes(error.code)) return false; throw error; }) : false;
const tenant = `lifecycle-${crypto.randomUUID()}`;
const link: ChannelLink = { communityId:'a'.repeat(64),concordChannelIdHex:'b'.repeat(64),discordGuildId:tenant,discordChannelId:tenant,enabled:true };
const store = new PostgresMappingStore(sql,tenant);
const leases = new BridgeLeases(sql);
const input = { deleteRumorId:'c'.repeat(64),targetRumorId:'d'.repeat(64),author:'e'.repeat(64),createdAtMs:Date.now(),sourceWrapCreatedAt:Math.floor(Date.now()/1000) };
beforeAll(async()=>{ if(reachable) await migrate(url!); });
afterAll(async()=>{ if(reachable) { for(const table of ['pending_concord_deletes','retired_concord_reactions','channel_delivery_checkpoints','channel_delivery_lifecycles','channel_delivery_upgrade_eligibility','messages','cursors']) await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1`,[tenant]); await sql`DELETE FROM bridge_leases WHERE resource = ${bridgeResource(link.discordGuildId,link.discordChannelId)}`; } await sql.end(); });
describe.skipIf(!reachable)('atomic delivery lifecycle fencing',()=>{
 test('fresh activation ignores legacy progress; restart preserves snapshot; CAS cannot heal newer gap',async()=>{
   const lease=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
   try {
     await store.cursorSet(link.communityId,'legacy',10);
     const snapshot=await store.activateDelivery(link,'synthetic-owner',['legacy'],1000);
     expect(snapshot.activationFloor).toBe(1000); expect(snapshot.repairFloor).toBe(1000);
     const view=(await store.openDelivery(link,'synthetic-owner',lease)).store;
     await view.saveDeletes(link,[input]);
     expect((await store.activateDelivery(link,'synthetic-owner',['legacy'],2000)).epoch).toBe(snapshot.epoch);
     const gap=await view.markDeliveryGap(900);
     expect(await view.certifyDelivery(snapshot.version,1100,{legacy:1100})).toBe(false);
     expect((await view.deliverySnapshot()).repairFloor).toBe(900);
     expect(await view.certifyDelivery(gap.version,1100,{legacy:1100})).toBe(true);
   } finally {await lease.release();}
 });
 test('replaced lease rejects every old mutation and old paused unlink cannot touch new owner',async()=>{
   const first=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
   const before=await store.activateDelivery(link,'synthetic-owner',[],1000);
   const stale=(await store.openDelivery(link,'synthetic-owner',first)).store;
   await first.release();
   const second=(await leases.acquire(first.resource))!;
   try {
     const next=await store.activateDelivery(link,'synthetic-new-owner',[],3000);
     const current=(await store.openDelivery(link,'synthetic-new-owner',second)).store;
     await current.saveDeletes(link,[input]);
     await expect(stale.saveDeletes(link,[input])).rejects.toThrow();
     await expect(stale.completeDelete(link,input.deleteRumorId,input.targetRumorId)).rejects.toThrow();
     await expect(stale.markDeliveryGap(1)).rejects.toThrow();
     expect(await store.terminateDelivery(link,'synthetic-owner',before.epoch)).toBe(false);
     expect(await current.pendingDeletes(link)).toHaveLength(1);
     expect(await store.terminateDelivery(link,'synthetic-new-owner',next.epoch)).toBe(true);
     await expect(current.saveDeletes(link,[input])).rejects.toThrow();
     const restart=await store.activateDelivery(link,'synthetic-new-owner',[],4000);
     expect(restart.epoch).not.toBe(next.epoch); expect(restart.activationFloor).toBe(4000);
   } finally {await second.release();}
 });
});

async function waitForLock(connection:postgres.Sql,application:string):Promise<void> {
  for(let i=0;i<200;i++) {
    const [row]=await connection`SELECT 1 FROM pg_stat_activity WHERE application_name=${application} AND wait_event_type='Lock'`;
    if(row) return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('worker did not reach the contested database lock');
}
test.skipIf(!reachable)('real concurrent lease takeover serializes before a queued stale write',async()=>{
  const lease=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
  const snap=await store.activateDelivery(link,'race-owner',[],Math.floor(Date.now()/1000));
  const application=`delivery-race-${crypto.randomUUID()}`;
  const worker=postgres(url!,{max:1,connection:{application_name:application}});
  const view=(await new PostgresMappingStore(worker,tenant).openDelivery(link,'race-owner',lease)).store;
  let pending:Promise<unknown>|undefined, replacement:Awaited<ReturnType<BridgeLeases['acquire']>>;
  try {
    await sql.begin(async tx=>{
      await tx`SELECT 1 FROM bridge_leases WHERE resource=${lease.resource} FOR UPDATE`;
      pending=view.saveDeletes(link,[input]).then(()=> 'accepted',error=>error);
      await waitForLock(sql,application);
      await tx`UPDATE bridge_leases SET expires_at=clock_timestamp() WHERE resource=${lease.resource}`;
      replacement=await new BridgeLeases(tx as unknown as postgres.Sql).acquire(lease.resource);
      expect(replacement?.token).toBe(lease.token+1n);
    });
    expect(await pending).toBeInstanceOf(Error);
    expect(await store.pendingDeletes(link)).toEqual([]);
  } finally { await lease.release(); await replacement?.release(); await worker.end(); }
});
test.skipIf(!reachable)('control revocation atomically fences queued callbacks even without live lease ownership',async()=>{
 const lease=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
 const snap=await store.activateDelivery(link,'termination-race',[],1000);
 const application=`delivery-revoke-${crypto.randomUUID()}`;
 const worker=postgres(url!,{max:1,connection:{application_name:application}});
 const view=(await new PostgresMappingStore(worker,tenant).openDelivery(link,'termination-race',lease)).store;
 let pending:Promise<unknown>|undefined;
 try {
   await sql.begin(async tx=>{
     await tx`SELECT 1 FROM bridge_leases WHERE resource=${lease.resource} FOR UPDATE`;
     pending=view.saveDeletes(link,[input]).then(()=> 'accepted',error=>error);
     await waitForLock(sql,application);
     expect(await store.terminateDelivery(link,'termination-race',snap.epoch,tx)).toBe(true);
   });
   expect(await pending).toBeInstanceOf(Error);
   expect(await store.pendingDeletes(link)).toEqual([]);
 } finally {await lease.release();await worker.end();}
});
test.skipIf(!reachable)('partial certification resumes after restart and a concurrent earlier gap rejects its CAS',async()=>{
 const lease=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
 try {
   const snap=await store.activateDelivery(link,'partial-repair',[],1000);
   const opened=await store.openDelivery(link,'partial-repair',lease); const view=opened.store;
   expect(await view.certifyDelivery(opened.snapshot.version,1299,{stream:1299})).toBe(true);
   const restart=await store.activateDelivery(link,'partial-repair',[],5000);
   expect(restart.repairFloor).toBe(1300); expect(restart.certifiedUntil).toBe(1299);
   const gap=await view.markDeliveryGap(1100);
   expect(await view.certifyDelivery(restart.version,1599,{stream:1599})).toBe(false);
   expect((await view.deliverySnapshot()).repairFloor).toBe(1100);
   expect(await view.certifyDelivery(gap.version,1599,{stream:1599},true)).toBe(true);
   expect((await view.deliverySnapshot()).repairFloor).toBeUndefined();
 } finally {await lease.release();}
});
test.skipIf(!reachable)('a lease expiring during a blocked write rolls the mutation back',async()=>{
 const lease=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
 const snap=await store.activateDelivery(link,'expiry-during-write',[],1000);
 const view=(await store.openDelivery(link,'expiry-during-write',lease)).store;
 try {
   await sql`UPDATE bridge_leases SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE resource=${lease.resource}`;
   await expect((view as any).write(async(tx:postgres.TransactionSql)=>{
     await tx`SELECT pg_sleep(0.15)`;
     await tx`UPDATE channel_delivery_lifecycles SET repair_floor=1 WHERE tenant_id=${tenant}`;
   })).rejects.toThrow('lease');
   expect((await sql`SELECT repair_floor FROM channel_delivery_lifecycles WHERE tenant_id=${tenant}`)[0].repair_floor).toBe('1000');
 } finally {await lease.release();}
});
test.skipIf(!reachable)('worker attachment never resurrects a terminated lifecycle from a stale active row',async()=>{
 const lease=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
 try {
  const snap=await store.activateDelivery(link,'stale-attachment',[],1000);
  expect((await store.openDelivery(link,'stale-attachment',lease)).snapshot.epoch).toBe(snap.epoch);
  await store.terminateDelivery(link,'stale-attachment',snap.epoch);
  await expect(store.openDelivery(link,'stale-attachment',lease)).rejects.toThrow('lifecycle');
  expect((await sql`SELECT active FROM channel_delivery_lifecycles WHERE tenant_id=${tenant}`)[0].active).toBe(false);
 } finally {await lease.release();}
});
test.skipIf(!reachable)('pause fences a different worker while preserving epoch and queued effects for resume',async()=>{
 const lease=(await leases.acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
 try {
  const snap=await store.activateDelivery(link,'pause-owner',[],1000);
  const view=(await store.openDelivery(link,'pause-owner',lease)).store;
  await view.saveDeletes(link,[input]);
  await store.suspendDelivery(link,'pause-owner',snap.epoch);
  await expect(view.assertDeliveryCurrent()).rejects.toThrow('lifecycle');
  await expect(view.completeDelete(link,input.deleteRumorId,input.targetRumorId)).rejects.toThrow('lifecycle');
  expect(await store.pendingDeletes(link)).toHaveLength(1);
  expect((await store.activateDelivery(link,'pause-owner',[],2000)).epoch).toBe(snap.epoch);
  await expect(view.assertDeliveryCurrent()).rejects.toThrow('session');
  const resumed=(await store.openDelivery(link,'pause-owner',lease)).store;
  await resumed.assertDeliveryCurrent();
  expect(await resumed.pendingDeletes(link)).toHaveLength(1);
 } finally {await lease.release();}
});
test.skipIf(!reachable)('same-owner stale control callbacks cannot terminate a relink or commit its status update',async()=>{
 const before=await store.activateDelivery(link,'control-race',[],1000);
 await store.terminateDelivery(link,'control-race',before.epoch);
 const next=await store.activateDelivery(link,'control-race',[],2000);
 await expect(sql.begin(async tx=>{
  await store.terminateDelivery(link,'control-race',before.epoch,tx);
  throw new Error('status update should never be reached');
 })).rejects.toThrow('epoch changed');
 expect((await store.inspectDelivery(link))?.epoch).toBe(next.epoch);
 expect((await store.inspectDelivery(link))?.active).toBe(true);
});
test.skipIf(!reachable)('due link selection filters eligible owners before its limit',async()=>{
 const paused={...link,discordChannelId:'synthetic-paused'};
 await store.activateDelivery(paused,'paused-owner',[],1000);
 await store.saveDeletes(paused,[{...input,nextAttemptAtMs:0}]);
 await store.activateDelivery(link,'eligible-owner',[],1000);
 await store.saveDeletes(link,[{...input,nextAttemptAtMs:1}]);
 expect((await store.dueDeletionLinks(1,['eligible-owner'])).map(value=>value.ownerId)).toEqual(['eligible-owner']);
 expect(await store.dueDeletionLinks(1,[])).toEqual([]);
});

test.skipIf(!reachable)('worker attachment arms a durable uncertainty marker and fences earlier sessions', async()=>{
 const scope={...link,discordChannelId:`${tenant}-session`};
 const lease=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 const owner='session-owner', firstSession=crypto.randomUUID(), secondSession=crypto.randomUUID();
 try {
  await store.activateDelivery(scope,owner,[],1000);
  const first=await store.openDelivery(scope,owner,lease,[],1000,firstSession);
  expect(first.snapshot.repairFloor).toBe(1000);
  expect(first.snapshot.workerUncertain).toBe(true);
  expect(first.snapshot.sessionId).toBe(firstSession);
  expect(await first.store.certifyDelivery(first.snapshot.version,1200,{},true)).toBe(true);
  const same=await store.openDelivery(scope,owner,lease,[],1000,firstSession);
  expect(same.snapshot.repairFloor).toBeUndefined();
  const second=await store.openDelivery(scope,owner,lease,[],1000,secondSession);
  expect(second.snapshot.repairFloor).toBe(0);
  await expect(first.store.assertDeliveryCurrent()).rejects.toThrow('session');
  await second.store.assertDeliveryCurrent();
 } finally {await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;}
});

test.skipIf(!reachable)('resuming with the same session id never revives a stale pre-pause view', async()=>{
 const scope={...link,discordChannelId:`${tenant}-reuse-session`};
 const lease=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 const owner='resume-session', sessionId=crypto.randomUUID();
 try {
  const state=await store.activateDelivery(scope,owner,[],1000);
  const old=await store.openDelivery(scope,owner,lease,[],1000,sessionId);
  await store.suspendDelivery(scope,owner,state.epoch);
  await store.activateDelivery(scope,owner,[],2000);
  const fresh=await store.openDelivery(scope,owner,lease,[],2000,sessionId);
  await fresh.store.assertDeliveryCurrent();
  await expect(old.store.assertDeliveryCurrent()).rejects.toThrow('session');
 } finally {await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;}
});

test.skipIf(!reachable)('same session id with a successor lease still starts conservative recovery', async()=>{
 const scope={...link,discordChannelId:`${tenant}-successor-session`};
 const owner='lease-session', sessionId=crypto.randomUUID();
 const first=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 let second:Awaited<ReturnType<BridgeLeases['acquire']>>;
 try {
  await store.activateDelivery(scope,owner,[],1000);
  const old=await store.openDelivery(scope,owner,first,[],1000,sessionId);
  expect(await old.store.certifyDelivery(old.snapshot.version,1200,{},true)).toBe(true);
  await first.release();
  second=(await leases.acquire(first.resource))!;
  const fresh=await store.openDelivery(scope,owner,second,[],2000,sessionId);
  expect(fresh.snapshot.repairFloor).toBe(0);
  await expect(old.store.assertDeliveryCurrent()).rejects.toThrow();
 } finally {await first.release();await second?.release();await sql`DELETE FROM bridge_leases WHERE resource=${first.resource}`;}
});

test.skipIf(!reachable)('changed relay set invalidates coverage without erasing ordinary stream boundaries', async()=>{
 const scope={...link,discordChannelId:`${tenant}-relay-set`};
 const owner='relay-set-owner', sessionId=crypto.randomUUID();
 const lease=(await leases.acquire(bridgeResource(scope.discordGuildId,scope.discordChannelId)))!;
 try {
  await store.activateDelivery(scope,owner,[],1000);
  const opened=await store.openDelivery(scope,owner,lease,[],1000,sessionId,['wss://relay-a.example']);
  expect(opened.snapshot.relays).toEqual(['wss://relay-a.example']);
  expect(await opened.store.certifyDelivery(opened.snapshot.version,1200,{stream:1200},true)).toBe(true);
  const before=await opened.store.deliverySnapshot();
  const changed=await opened.store.setDeliveryRelays(['wss://relay-a.example','wss://relay-b.example']);
  expect(changed.repairFloor).toBe(0);
  expect(changed.coverage).toEqual({});
  expect(changed.ordinaryCoverage).toEqual({stream:1200});
  expect(await opened.store.certifyDelivery(before.version,1300,{stream:1300},true)).toBe(false);
  expect(await opened.store.certifyDelivery(changed.version,300,{stream:300},false)).toBe(true);
  const changedAgain=await opened.store.setDeliveryRelays(['wss://relay-c.example']);
  expect(changedAgain.ordinaryCoverage).toEqual({stream:1200});
 } finally {await lease.release();await sql`DELETE FROM bridge_leases WHERE resource=${lease.resource}`;}
});
