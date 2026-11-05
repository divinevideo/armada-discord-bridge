import { expect, it } from 'bun:test';
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
