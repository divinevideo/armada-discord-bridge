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
     const view=store.forDelivery(link,{ownerId:'synthetic-owner',epoch:snapshot.epoch,lease});
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
   const stale=store.forDelivery(link,{ownerId:'synthetic-owner',epoch:before.epoch,lease:first});
   await first.release();
   const second=(await leases.acquire(first.resource))!;
   try {
     const next=await store.activateDelivery(link,'synthetic-new-owner',[],3000);
     const current=store.forDelivery(link,{ownerId:'synthetic-new-owner',epoch:next.epoch,lease:second});
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
  const view=new PostgresMappingStore(worker,tenant).forDelivery(link,{ownerId:'race-owner',epoch:snap.epoch,lease});
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
 const view=new PostgresMappingStore(worker,tenant).forDelivery(link,{ownerId:'termination-race',epoch:snap.epoch,lease});
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
   const view=store.forDelivery(link,{ownerId:'partial-repair',epoch:snap.epoch,lease});
   expect(await view.certifyDelivery(snap.version,1299,{stream:1299})).toBe(true);
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
 const view=store.forDelivery(link,{ownerId:'expiry-during-write',epoch:snap.epoch,lease});
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
  const view=store.forDelivery(link,{ownerId:'pause-owner',epoch:snap.epoch,lease});
  await view.saveDeletes(link,[input]);
  await store.suspendDelivery(link,'pause-owner',snap.epoch);
  await expect(view.assertDeliveryCurrent()).rejects.toThrow('lifecycle');
  await expect(view.completeDelete(link,input.deleteRumorId,input.targetRumorId)).rejects.toThrow('lifecycle');
  expect(await store.pendingDeletes(link)).toHaveLength(1);
  expect((await store.activateDelivery(link,'pause-owner',[],2000)).epoch).toBe(snap.epoch);
  await view.assertDeliveryCurrent();
  expect(await view.pendingDeletes(link)).toHaveLength(1);
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
