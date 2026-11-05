import { describe, test, expect } from 'bun:test';
import { MemoryMappingStore, MAX_PENDING_DELETES_PER_ACTOR } from '../router';
import type { ChannelLink, PendingConcordDelete } from '../router';
const link: ChannelLink = { communityId:'a'.repeat(64), concordChannelIdHex:'b'.repeat(64),discordGuildId:'synthetic-policy',discordChannelId:'synthetic-policy',enabled:true };
const now = 1_800_000_000_000;
const row = (id: string, extra = {}): PendingConcordDelete => ({deleteRumorId:id,targetRumorId:id,author:'c'.repeat(64),createdAtMs:now,sourceWrapCreatedAt:now / 1000,...extra});
describe('deletion retention allocation', () => {
 test('unresolved expiry uses carrier time and replay never renews it', async () => {
   let clock = now;
   const store = new MemoryMappingStore(() => clock);
   await store.saveDeletes(link,[row('old',{sourceWrapCreatedAt:now/1000-6*86400})]);
   clock += 2*86400_000;
   expect(await store.dueDeletes(link)).toEqual([]);
   const outcome = await store.saveDeletes(link,[row('old',{createdAtMs:clock,sourceWrapCreatedAt:now/1000-6*86400})]);
   expect(outcome.disposedExpired).toBe(1);
   expect(await store.pendingDeletes(link)).toEqual([]);
 });
 test('unresolved capacity is an explicit policy disposition and actionable has a separate allocation', async () => {
   const store = new MemoryMappingStore(() => now);
   await store.saveDeletes(link,Array.from({length:MAX_PENDING_DELETES_PER_ACTOR},(_,i)=>row(`unresolved-${i}`)));
   expect((await store.saveDeletes(link,[row('excess')])).disposedCapacity).toBe(1);
   await store.saveDeletes(link,[row('action',{actionClass:'actionable'})]);
   expect((await store.pendingDeletes(link,'action'))[0].actionClass).toBe('actionable');
 });
 test('promotion keeps unresolved durable on actionable capacity refusal; actionable survives seven days', async () => {
   let clock = now;
   const store = new MemoryMappingStore(() => clock);
   await store.saveDeletes(link,Array.from({length:MAX_PENDING_DELETES_PER_ACTOR},(_,i)=>row(`action-${i}`,{actionClass:'actionable'})));
   await store.saveDeletes(link,[row('waiting')]);
   await expect(store.promoteDelete(link,row('waiting'))).rejects.toThrow('capacity');
   expect(await store.pendingDeletes(link,'waiting')).toHaveLength(1);
   clock += 8*86400_000;
   expect((await store.dueDeletes(link))).toHaveLength(128);
   expect((await store.pendingDeletes(link,'action-0'))[0].actionClass).toBe('actionable');
 });
 test('retries back off, due queries bound work, and targeted/fold wakeups bypass due time', async () => {
   let clock = now;
   const store = new MemoryMappingStore(() => clock);
   await store.saveDeletes(link,[row('action',{actionClass:'actionable'})]);
   await store.retryDelete(link,row('action'));
   expect(await store.dueDeletes(link)).toEqual([]);
   expect(await store.dueDeletes(link,'action')).toHaveLength(1);
   clock += 10_000;
   expect(await store.dueDeletes(link)).toHaveLength(1);
   await store.retryDelete(link,row('action'));
   clock += 10_000;
   expect(await store.dueDeletes(link)).toEqual([]);
   await store.wakeDeletes(link);
   expect(await store.dueDeletes(link)).toHaveLength(1);
 });
});
test('future unresolved carriers receive explicit finite disposition while actionable carriers remain durable',async()=>{
 const store=new MemoryMappingStore(()=>now);
 const future=row('future',{sourceWrapCreatedAt:now/1000+86400});
 expect((await store.saveDeletes(link,[future])).disposedFuture).toBe(1);
 expect(await store.pendingDeletes(link)).toEqual([]);
 expect((await store.saveDeletes(link,[{...future,actionClass:'actionable'}])).stored).toBe(1);
 expect((await store.pendingDeletes(link))[0].expiresAtMs).toBeUndefined();
});
