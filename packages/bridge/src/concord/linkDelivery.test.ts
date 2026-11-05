import { expect, it } from 'bun:test';
import type { DeliveredChat, ReplayOptions } from './replay';
import type { ChannelV2 } from '@armada-bridge/concord-core';
import { LinkDelivery } from './linkDelivery';

it('keeps the same effect lane while a subscription is replaced', async () => {
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const delivery = new LinkDelivery({ onError: () => {} });
  const first = delivery.run(async () => { order.push('old start'); await blocked; order.push('old end'); });
  const second = delivery.run(async () => { order.push('new'); });
  await Promise.resolve();
  expect(order).toEqual(['old start']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['old start', 'old end', 'new']);
});

it('records the earliest overflow immediately while a durable effect is blocked', async () => {
  const floors: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const delivery = new LinkDelivery({ onError: () => {}, onGap: async floor => { floors.push(floor); }, capacity: 1 });
  const first = delivery.admit(100, () => blocked);
  expect(delivery.admit(120, async () => {})).toBeUndefined();
  expect(delivery.admit(110, async () => {})).toBeUndefined();
  expect(delivery.gapFloor).toBe(110);
  release();
  await first;
  await delivery.flushGaps();
  expect(Math.min(...floors)).toBe(110);
});

it('retries the earliest gap after its first persistence attempt fails', async () => {
  const floors: number[] = [];
  let fail = true;
  const delivery = new LinkDelivery({ onError: () => {}, onGap: async floor => {
    if (fail) { fail = false; throw new Error('database unavailable'); }
    floors.push(floor);
  } });
  delivery.markGap(100);
  await expect(delivery.flushGaps()).rejects.toThrow('database unavailable');
  delivery.markGap(200);
  await delivery.flushGaps();
  expect(floors).toEqual([100]);
});

it('retains an aborted callback in the lane and refuses later queued effects', async () => {
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const delivery = new LinkDelivery({ onError: () => {} });
  const first = delivery.run(async signal => {
    order.push('entered'); await blocked; signal.throwIfAborted(); order.push('late effect');
  });
  await Promise.resolve();
  const second = delivery.run(async () => { order.push('next effect'); });
  delivery.stop();
  release();
  await Promise.allSettled([first, second]);
  expect(order).toEqual(['entered']);
});

it('does not heal a gap that arrives while a checkpoint write is pending', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const persisted: number[] = [];
  const delivery = new LinkDelivery({ onError: () => {}, onGap: async floor => { persisted.push(floor); } });
  delivery.markGap(100);
  await delivery.flushGaps();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const checkpoint = delivery.certify(async () => { started(); await blocked; return true; }, true);
  await entered;
  delivery.markGap(80);
  release();
  expect(await checkpoint).toBe(false);
  await delivery.flushGaps();
  expect(delivery.gapFloor).toBe(80);
  expect(persisted).toContain(80);
});

it('coalesces typing outside durable admission while a deletion is blocked', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const delivery = new LinkDelivery({ onError: () => {}, capacity: 2 });
  const first = delivery.admit(100, async () => { order.push('delete'); await blocked; });
  for (let i = 0; i < 1000; i++) delivery.typing(async () => { order.push('typing'); });
  const second = delivery.admit(101, async () => { order.push('durable'); });
  expect(second).toBeDefined();
  expect(delivery.gapFloor).toBeUndefined();
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['delete', 'typing', 'durable']);
});

it('coalesces overflow persistence while its database write is blocked', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const floors: number[] = [];
  const delivery = new LinkDelivery({ onError: () => {}, onGap: async floor => {
    floors.push(floor);
    if (floors.length === 1) await blocked;
  } });
  delivery.markGap(2000);
  await Promise.resolve(); await Promise.resolve();
  for (let floor = 1999; floor >= 1000; floor--) delivery.markGap(floor);
  release();
  await delivery.flushGaps();
  expect(floors).toEqual([2000, 1000]);
});

it('commits completed replay windows and clears only the frozen final window', async () => {
  const calls: Array<[number, boolean]> = [];
  let version = 0, repairFloor: number | undefined = 100;
  const state = () => ({ ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, ordinaryCoverage: {}, version, activationFloor: 100, recoveryFloor: 100, repairFloor, coverage: {}, legacyBoundaries: {} });
  const store = {
    deliverySnapshot: async () => state(),
    certifyDelivery: async (expected: number, until: number, _coverage: Record<string, number>, complete: boolean) => {
      if (expected !== version) return false;
      calls.push([until, complete]); version++; repairFloor = complete ? undefined : until + 1; return true;
    },
  };
  const channel = { streams: [{ group: { pk: 'stream' } }] } as unknown as ChannelV2;
  const delivery = new LinkDelivery({ onError: () => {} });
  await delivery.repair({ store, channel: () => channel, deliver: async () => {}, replay: async (_channel, _since, opts) => {
    await opts.onWindowComplete!({ since: 40, until: 299, runUntil: 500 }, { signal: new AbortController().signal });
    await opts.onWindowComplete!({ since: 300, until: 500, runUntil: 500 }, { signal: new AbortController().signal });
  } });
  expect(calls).toEqual([[299, false], [500, true]]);
  expect(repairFloor).toBeUndefined();
});

it('resumes a certified prefix after an interrupted replay', async () => {
  let version = 0, repairFloor: number | undefined = 100, coverage: Record<string, number> = {};
  const store = {
    deliverySnapshot: async () => ({ ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, ordinaryCoverage: {}, version, activationFloor: 100, recoveryFloor: 100, repairFloor, coverage, legacyBoundaries: {} }),
    certifyDelivery: async (expected: number, until: number, next: Record<string, number>, complete: boolean) => {
      if (expected !== version) return false;
      version++; coverage = next; repairFloor = complete ? undefined : until + 1; return true;
    },
  };
  const channel = { streams: [{ group: { pk: 'stream' } }] } as unknown as ChannelV2;
  const delivery = new LinkDelivery({ onError: () => {}, onGap: async floor => { version++; repairFloor = Math.min(repairFloor ?? floor, floor); } });
  delivery.markGap(100);
  await delivery.flushGaps();
  const floors: number[] = [];
  const options = { store, channel: () => channel, deliver: async () => {}, replay: async (_channel: ChannelV2, since: number, opts: ReplayOptions) => {
    floors.push(since);
    if (floors.length === 1) {
      await opts.onWindowComplete!({ since, until: 339, runUntil: 800 }, { signal: new AbortController().signal });
      throw new Error('attempt deadline');
    }
    await opts.onWindowComplete!({ since, until: 800, runUntil: 800 }, { signal: new AbortController().signal });
  } };
  await expect(delivery.repair(options)).rejects.toThrow('attempt deadline');
  await delivery.repair(options);
  expect(floors).toEqual([100, 340]);
  expect(repairFloor).toBeUndefined();
});

it('replays only deletions below each legacy carrier boundary', async () => {
  const snapshot = { ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, ordinaryCoverage: {}, version: 0, activationFloor: 1000, recoveryFloor: 100, repairFloor: 40, coverage: {}, legacyBoundaries: { first: 100, second: 50, future: 999 } };
  const store = { deliverySnapshot: async () => snapshot, certifyDelivery: async () => true };
  const channel = { streams: [{ epoch: 0n, group: { pk: 'first' } }, { epoch: 1n, group: { pk: 'second' } }, { epoch: 2n, group: { pk: 'third' } }, { epoch: 3n, group: { pk: 'future' } }] } as unknown as ChannelV2;
  const delivered: string[] = [];
  const chats = [
    { rumorId: 'old message', kind: 9, streamPk: 'first', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 0n },
    { rumorId: 'old deletion', kind: 5, streamPk: 'first', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 0n },
    { rumorId: 'second message', kind: 9, streamPk: 'second', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 1n },
    { rumorId: 'pre-link message', kind: 9, streamPk: 'third', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 2n },
    { rumorId: 'pre-link deletion', kind: 5, streamPk: 'third', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 2n },
    { rumorId: 'unknown downtime', kind: 9, streamPk: 'third', sourceWrapCreatedAt: 150, createdAt: 150, epoch: 2n },
    { rumorId: 'own boundary', kind: 9, streamPk: 'first', sourceWrapCreatedAt: 100, createdAt: 100, epoch: 0n },
    { rumorId: 'new boundary', kind: 9, streamPk: 'third', sourceWrapCreatedAt: 100, createdAt: 100, epoch: 2n },
    { rumorId: 'activation second', kind: 9, streamPk: 'future', sourceWrapCreatedAt: 1000, createdAt: 1000, epoch: 3n },
  ] as DeliveredChat[];
  const delivery = new LinkDelivery({ onError: () => {} });
  await delivery.repair({ store, channel: () => channel, deliver: async chat => { delivered.push(chat.rumorId); }, replay: async (_channel, _since, opts) => {
    await opts.onBatch!({ chats }, { signal: new AbortController().signal });
  } });
  expect(delivered).toEqual(['old deletion', 'second message', 'pre-link deletion', 'unknown downtime', 'new boundary', 'activation second']);
});

it('keeps a newer persisted gap when the final replay checkpoint is blocked', async () => {
  let version = 0, repairFloor: number | undefined = 100, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const snapshot = () => ({ ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, ordinaryCoverage: {}, version, activationFloor: 100, recoveryFloor: 100, repairFloor, coverage: {}, legacyBoundaries: {} });
  const store = {
    deliverySnapshot: async () => snapshot(),
    certifyDelivery: async (expected: number, _until: number, _coverage: Record<string, number>, complete: boolean) => {
      entered(); await blocked;
      if (expected !== version) return false;
      version++; if (complete) repairFloor = undefined; return true;
    },
  };
  const delivery = new LinkDelivery({ onError: () => {}, onGap: async floor => { version++; repairFloor = Math.min(repairFloor ?? floor, floor); } });
  const channel = { streams: [{ group: { pk: 'stream' } }] } as unknown as ChannelV2;
  const running = delivery.repair({ store, channel: () => channel, deliver: async () => {}, replay: async (_channel, since, opts) => {
    await opts.onWindowComplete!({ since, until: 500, runUntil: 500 }, { signal: opts.signal! });
  } });
  await started;
  delivery.markGap(80);
  await delivery.flushGaps();
  release();
  await expect(running).rejects.toThrow();
  expect(repairFloor).toBe(80);
});

it('starts a newly discovered stream at the preserved upgrade floor', async () => {
  const snapshot = { ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, ordinaryCoverage: {}, version: 1, activationFloor: 1000, recoveryFloor: 80, certifiedUntil: 1200, coverage: { known: 1200 }, legacyBoundaries: { new: 50 } };
  const store = { deliverySnapshot: async () => snapshot, certifyDelivery: async () => true };
  const channel = { streams: [{ group: { pk: 'known' } }, { group: { pk: 'new' } }] } as unknown as ChannelV2;
  let floor = -1;
  const delivery = new LinkDelivery({ onError: () => {} });
  await delivery.repair({ store, channel: () => channel, deliver: async () => {}, replay: async (_channel, since) => { floor = since; } });
  expect(floor).toBe(0);
});

it('coalesces retry notifications while the effect lane is blocked', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const wakes: boolean[] = [];
  const delivery = new LinkDelivery({ onError: () => {} });
  const first = delivery.run(async () => blocked);
  const retry = async (wake: boolean) => { wakes.push(wake); };
  for (let i = 0; i < 1000; i++) delivery.requestRetry(i === 500, retry);
  release(); await first;
  await delivery.run(async () => {});
  expect(wakes).toEqual([true]);
});

it('keeps a fold wake that arrives while a normal retry is running', async () => {
  let release!: () => void, entered!: () => void, awakened!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const done = new Promise<void>(resolve => { awakened = resolve; });
  const wakes: boolean[] = [];
  const delivery = new LinkDelivery({ onError: () => {} });
  const retry = async (wake: boolean) => { wakes.push(wake); if (!wake) { entered(); await blocked; } else awakened(); };
  const first = delivery.requestRetry(false, retry);
  await started;
  void delivery.requestRetry(true, retry);
  release(); await first;
  expect(await Promise.race([done.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 20))])).toBe(true);
  expect(wakes).toEqual([false, true]);
});

it('pins a replay gap when a live relay subscription fails', async () => {
  const floors: number[] = [];
  const delivery = new LinkDelivery({ onError: () => {}, onGap: async floor => { floors.push(floor); } });
  delivery.subscriptionError('synthetic-relay', 1000);
  await delivery.flushGaps();
  expect(floors).toEqual([940]);
  delivery.subscriptionError('dispatch', 1100);
  await delivery.flushGaps();
  expect(floors).toEqual([940]);
});

it('does not let a broken error observer poison the delivery lane', async () => {
  const delivery = new LinkDelivery({ onError: () => { throw new Error('observer failed'); } });
  await expect(delivery.run(async () => { throw new Error('effect failed'); })).rejects.toThrow('effect failed');
  let ran = false;
  await delivery.run(async () => { ran = true; });
  expect(ran).toBe(true);
});

it('suppresses ordinary historical carriers below previously completed stream coverage', async () => {
  const snapshot = { ownerId:'owner',epoch:'epoch',active:true,suspended:false,workerUncertain:true,sessionGeneration:1,version:2,activationFloor:100,recoveryFloor:100,repairFloor:0,coverage:{stream:500},ordinaryCoverage:{},legacyBoundaries:{} };
  const store = { deliverySnapshot: async () => snapshot, certifyDelivery: async () => true };
  const channel = { streams:[{epoch:0n,group:{pk:'stream'}}] } as unknown as ChannelV2;
  const chats = [
    {rumorId:'old ordinary',kind:9,streamPk:'stream',sourceWrapCreatedAt:400,createdAt:400,epoch:0n},
    {rumorId:'old deletion',kind:5,streamPk:'stream',sourceWrapCreatedAt:400,createdAt:400,epoch:0n},
    {rumorId:'new ordinary',kind:9,streamPk:'stream',sourceWrapCreatedAt:501,createdAt:501,epoch:0n},
  ] as DeliveredChat[];
  const delivered:string[]=[]; const delivery=new LinkDelivery({onError:()=>{}});
  await delivery.repair({store,channel:()=>channel,deliver:async chat=>{delivered.push(chat.rumorId);},replay:async(_channel,_since,opts)=>{
    await opts.onBatch!({chats},{signal:new AbortController().signal});
  }});
  expect(delivered).toEqual(['old deletion','new ordinary']);
});

it('advances a dense one-second historical prefix across repeated short attempts', async () => {
  let version=0, repairFloor:number|undefined=100, coverage:Record<string,number>={};
  const store={deliverySnapshot:async()=>({ownerId:'owner',epoch:'epoch',active:true,suspended:false,workerUncertain:true,sessionGeneration:1,version,activationFloor:100,recoveryFloor:100,repairFloor,coverage,ordinaryCoverage:{},legacyBoundaries:{}}),
    certifyDelivery:async(expected:number,until:number,next:Record<string,number>)=>{if(expected!==version)return false;version++;coverage=next;repairFloor=until+1;return true;}};
  const channel={streams:[{group:{pk:'stream'}}]} as unknown as ChannelV2, floors:number[]=[];
  const delivery=new LinkDelivery({onError:()=>{}});
  const options={store,channel:()=>channel,deliver:async()=>{},replay:async(_channel:ChannelV2,since:number,opts:ReplayOptions)=>{
    floors.push(since); await opts.onWindowComplete!({since,until:since,runUntil:1000},{signal:new AbortController().signal}); throw new Error('budget');
  }};
  for(let i=0;i<3;i++) await expect(delivery.repair(options)).rejects.toThrow('budget');
  expect(floors).toEqual([100,101,102]);
});

it('invalidates a replay whose configured relay set changes during the run', async () => {
  let relays=['wss://a.example'],writes=0; const floors:number[]=[];
  const snapshot={ownerId:'owner',epoch:'epoch',active:true,suspended:false,workerUncertain:true,sessionGeneration:1,version:0,activationFloor:100,recoveryFloor:100,repairFloor:100,coverage:{},ordinaryCoverage:{},legacyBoundaries:{},relays:['wss://a.example']};
  const store={deliverySnapshot:async()=>snapshot,certifyDelivery:async()=>{writes++;return true;},setDeliveryRelays:async()=>snapshot};
  const channel={streams:[{group:{pk:'stream'}}]} as unknown as ChannelV2;
  const lane=new LinkDelivery({onError:()=>{},onGap:async floor=>{floors.push(floor);}});
  await expect(lane.repair({store,channel:()=>channel,relays:()=>relays,deliver:async()=>{},replay:async(_channel,since,opts)=>{
    relays=['wss://a.example','wss://b.example'];
    await opts.onWindowComplete!({since,until:500,runUntil:500},{signal:opts.signal!});
  }})).rejects.toThrow('relay');
  await lane.flushGaps();
  expect(writes).toBe(0); expect(floors).toEqual([0]);
});

it('rechecks the relay set after an awaited checkpoint', async () => {
  let relays=['wss://a.example'],entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}), blocked=new Promise<void>(resolve=>{release=resolve;});
  const snapshot={ownerId:'owner',epoch:'epoch',active:true,suspended:false,workerUncertain:true,sessionGeneration:1,version:0,activationFloor:100,recoveryFloor:100,repairFloor:100,coverage:{},ordinaryCoverage:{},legacyBoundaries:{},relays:['wss://a.example']};
  const store={deliverySnapshot:async()=>snapshot,setDeliveryRelays:async()=>snapshot,certifyDelivery:async()=>{entered();await blocked;return true;}};
  const channel={streams:[{group:{pk:'stream'}}]} as unknown as ChannelV2, floors:number[]=[];
  const lane=new LinkDelivery({onError:()=>{},onGap:async floor=>{floors.push(floor);}});
  const repair=lane.repair({store,channel:()=>channel,relays:()=>relays,deliver:async()=>{},replay:async(_channel,since,opts)=>{
    await opts.onWindowComplete!({since,until:500,runUntil:500},{signal:opts.signal!});
  }});
  await started;relays=['wss://b.example'];release();
  await expect(repair).rejects.toThrow('relay');await lane.flushGaps();expect(floors).toEqual([0]);
});
