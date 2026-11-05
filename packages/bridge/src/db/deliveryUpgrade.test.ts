import { afterAll, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { PostgresMappingStore, standaloneDeliveryOwner } from './store';
import { BridgeLeases, bridgeResource } from './leases';
import type { ChannelLink } from '../router';
const url=process.env.DATABASE_URL;
const admin=postgres(url??'postgres://unused:unused@127.0.0.1:1/unused',{max:2,connect_timeout:2,onnotice(){}});
const reachable=url?await admin`SELECT 1`.then(()=>true,error=>{if(['ECONNREFUSED','ETIMEDOUT','CONNECT_TIMEOUT','ENOTFOUND'].includes(error.code))return false;throw error;}):false;
afterAll(()=>admin.end());
test.skipIf(!reachable)('upgrade snapshots existing portal and standalone eligibility once and runtime DML grants cover every new table',async()=>{
 const suffix=crypto.randomUUID().replaceAll('-',''), schema=`delivery_upgrade_${suffix}`, role=`delivery_runtime_${suffix}`;
 await admin.unsafe(`CREATE SCHEMA ${schema}`);
 await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
 const db=postgres(url!,{max:2,connection:{search_path:schema},onnotice(){}});
 let runtime:postgres.Sql|undefined;
 const tenant='synthetic-upgrade';
 const link:ChannelLink={communityId:'a'.repeat(64),concordChannelIdHex:'b'.repeat(64),discordGuildId:'synthetic-guild',discordChannelId:'synthetic-channel',enabled:true};
 const owner=crypto.randomUUID(),old=Date.now()-8*86400_000;
 try {
   const directory=new URL('./',import.meta.url);
   await db.unsafe(await readFile(new URL('schema.sql',directory),'utf8'));
   for(const file of (await readdir(new URL('migrations/',directory))).filter(file=>file.endsWith('.sql') && file<'022').sort()) await db.unsafe(await readFile(new URL('migrations/'+file,directory),'utf8'));
   await db`INSERT INTO bridges(tenant_id,bridge_id,owner_discord_id,status,community_id,concord_channel_id,discord_guild_id,discord_channel_id)
     VALUES (${tenant},${owner},'synthetic-owner','paused',${link.communityId},${link.concordChannelIdHex},${link.discordGuildId},${link.discordChannelId})`;
   await db`INSERT INTO communities(tenant_id,community_id,relays) VALUES (${tenant},${link.communityId},ARRAY[]::text[])`;
   await db`INSERT INTO channel_links(tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,enabled)
     VALUES (${tenant},${link.communityId},${link.concordChannelIdHex},${link.discordGuildId},'standalone-channel',true)`;
   await db`INSERT INTO cursors(tenant_id,community_id,stream_pk,relay_url,last_seen_at) VALUES (${tenant},${link.communityId},'old','pool',100),(${tenant},${link.communityId},'new','pool',200)`;
   await db`INSERT INTO messages(tenant_id,community_id,concord_channel_id,discord_channel_id,discord_message_id,concord_rumor_id,origin,author_ref)
     VALUES (${tenant},${link.communityId},${link.concordChannelIdHex},${link.discordChannelId},'synthetic-message',${'c'.repeat(64)},'concord',${'d'.repeat(64)})`;
   for(const target of ['c'.repeat(64),'e'.repeat(64)]) await db`INSERT INTO pending_concord_deletes
     (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,delete_rumor_id,target_rumor_id,author,created_at_ms)
     VALUES (${tenant},${link.communityId},${link.concordChannelIdHex},${link.discordGuildId},${link.discordChannelId},${'f'.repeat(64)},${target},${'1'.repeat(64)},${old})`;
   await db.unsafe(await readFile(new URL('migrations/022_delivery_lifecycle.sql',directory),'utf8'));
   await db.unsafe(await readFile(new URL('migrations/023_delivery_pause.sql',directory),'utf8'));
   // Match the deployment migration hook: explicit DML grants after migrations,
   // not superuser tests or a dependency on unspecified default privileges.
   await admin.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
   await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
   await admin.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
   const runtimeUrl=new URL(url!);runtimeUrl.username=role;
   runtime=postgres(runtimeUrl.toString(),{max:2,connection:{search_path:schema},onnotice(){}});
   expect((await runtime`SELECT rolsuper FROM pg_roles WHERE rolname=current_user`)[0].rolsuper).toBe(false);
   const store=new PostgresMappingStore(runtime,tenant);
   const lease=(await new BridgeLeases(runtime).acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
   try {
     const snapshot=await store.activateDelivery(link,owner,['old','new'],1000);
     expect(snapshot.repairFloor).toBe(100);expect(snapshot.legacyBoundaries).toEqual({old:100,new:200});
     const view=store.forDelivery(link,{ownerId:owner,epoch:snapshot.epoch,lease});
     const held=await view.pendingDeletes(link);
     expect(held.find(row=>row.targetRumorId==='c'.repeat(64))?.actionClass).toBe('actionable');
     expect(held.find(row=>row.targetRumorId==='e'.repeat(64))?.actionClass).toBe('unresolved');
     expect((await view.dueDeletes(link)).map(row=>row.targetRumorId)).toEqual(['c'.repeat(64)]);
     expect(await view.dueDeletionLinks()).toHaveLength(1);
     await view.retryDelete(link,held[0]);await view.wakeDeletes(link);
     const gap=await view.markDeliveryGap(90);expect(await view.certifyDelivery(gap.version,1100,{old:1100,new:1100},true)).toBe(true);
     await view.retireReaction(link,{rumorId:'2'.repeat(64),discordMessageId:'synthetic-message',emoji:'x',origin:'concord',authorRef:'d'.repeat(64)});
     await view.completeDelete(link,'f'.repeat(64),'c'.repeat(64));
     // Restart and later cursors never replace the frozen legacy boundaries.
     await store.cursorSet(link.communityId,'old',900);
     expect((await store.activateDelivery(link,owner,['old','new'],2000)).legacyBoundaries).toEqual({old:100,new:200});
     await store.terminateDelivery(link,owner,snapshot.epoch);
     const relink=await store.activateDelivery(link,owner,['old','new'],3000);
     expect(relink.repairFloor).toBe(3000);expect(relink.legacyBoundaries).toEqual({});
   } finally {await lease.release();}
   const standalone={...link,discordChannelId:'standalone-channel'};
   expect((await store.activateDelivery(standalone,standaloneDeliveryOwner(standalone),['old','new'],1000)).repairFloor).toBe(100);
   const fresh={...link,discordChannelId:'new-after-migration'};
   expect((await store.activateDelivery(fresh,'fresh-owner',['old','new'],1000)).repairFloor).toBe(1000);
 } finally {await runtime?.end();await db.end();await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);await admin.unsafe(`DROP ROLE ${role}`);}
},15000);
