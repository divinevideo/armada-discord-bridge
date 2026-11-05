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
  const state = () => ({ ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, version, activationFloor: 100, repairFloor, coverage: {}, legacyBoundaries: {} });
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
    deliverySnapshot: async () => ({ ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, version, activationFloor: 100, repairFloor, coverage, legacyBoundaries: {} }),
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
  expect(floors).toEqual([40, 280]);
  expect(repairFloor).toBeUndefined();
});

it('replays only deletions below each legacy carrier boundary', async () => {
  const snapshot = { ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, version: 0, activationFloor: 100, repairFloor: 40, coverage: {}, legacyBoundaries: { first: 100, second: 50 } };
  const store = { deliverySnapshot: async () => snapshot, certifyDelivery: async () => true };
  const channel = { streams: [{ epoch: 0n, group: { pk: 'first' } }, { epoch: 1n, group: { pk: 'second' } }] } as unknown as ChannelV2;
  const delivered: string[] = [];
  const chats = [
    { rumorId: 'old message', kind: 9, streamPk: 'first', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 0n },
    { rumorId: 'old deletion', kind: 5, streamPk: 'first', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 0n },
    { rumorId: 'second message', kind: 9, streamPk: 'second', sourceWrapCreatedAt: 75, createdAt: 75, epoch: 1n },
  ] as DeliveredChat[];
  const delivery = new LinkDelivery({ onError: () => {} });
  await delivery.repair({ store, channel: () => channel, deliver: async chat => { delivered.push(chat.rumorId); }, replay: async (_channel, _since, opts) => {
    await opts.onBatch!({ chats }, { signal: new AbortController().signal });
  } });
  expect(delivered).toEqual(['old deletion', 'second message']);
});

it('keeps a newer persisted gap when the final replay checkpoint is blocked', async () => {
  let version = 0, repairFloor: number | undefined = 100, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const snapshot = () => ({ ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, version, activationFloor: 100, repairFloor, coverage: {}, legacyBoundaries: {} });
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
