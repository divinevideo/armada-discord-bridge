import { filterEpochCutoff, KIND_DELETE } from '@armada-bridge/concord-core';
import type { ChannelV2 } from '@armada-bridge/concord-core';
import { ActionableDeletionCapacityError, PromotionDeletionIntakeError } from '../deletionPolicy';
import type { DeliverySnapshot } from '../db/deliveryState';
import type { DeliveredChat, ReplayOptions } from './replay';

type RepairStore = {
  deliverySnapshot(): Promise<DeliverySnapshot>;
  certifyDelivery(version: number, until: number, coverage: Record<string, number>, complete: boolean): Promise<boolean>;
  setDeliveryRelays?(relays: string[]): Promise<DeliverySnapshot>;
};
type RepairOptions = {
  store: RepairStore;
  channel: () => ChannelV2;
  relays?: () => readonly string[];
  replay: (channel: ChannelV2, since: number, options: ReplayOptions) => Promise<unknown>;
  deliver: (chat: DeliveredChat, signal: AbortSignal) => Promise<unknown>;
};

/** One lane remains owned by the link when its stream subscription changes. */
export class LinkDelivery {
  private readonly controller = new AbortController();
  private lane: Promise<void> = Promise.resolve();
  private gaps: Promise<void> = Promise.resolve();
  private gapWriter?: Promise<void>;
  private repairPending?: Promise<void>;
  private retryPending?: Promise<void>;
  private retryWake = false;
  private attempt?: AbortController;
  private queued = 0;
  private typingQueued = false;
  private generation = 0;
  private readonly seen = new Set<string>();
  gapFloor?: number;
  constructor(private readonly options: { onError: (error: unknown) => void; onGap?: (floor: number) => Promise<unknown>; capacity?: number }) {}
  hasSeen(id: string): boolean { return this.seen.has(id); }
  remember(id: string): void {
    if (this.seen.size >= 65_536) this.seen.clear();
    this.seen.add(id);
  }
  stop(): void { this.controller.abort(); this.attempt?.abort(); }
  run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const result = this.lane.then(() => { this.controller.signal.throwIfAborted(); return work(this.controller.signal); });
    this.lane = result.catch(error => { try { this.options.onError(error); } catch {} });
    return result;
  }
  subscriptionError(source: string, now = Math.floor(Date.now() / 1000)): void {
    if (source !== 'dispatch' && !this.controller.signal.aborted) this.markGap(Math.max(0, now - 60));
  }
  markGap(floor: number): void {
    this.generation++;
    this.attempt?.abort();
    this.gapFloor = Math.min(this.gapFloor ?? floor, floor);
    if (!this.gapWriter) {
      const pending = Promise.resolve().then(async () => {
        for (;;) {
          const generation = this.generation;
          await this.options.onGap?.(this.gapFloor!);
          if (generation === this.generation) return;
        }
      });
      this.gapWriter = pending;
      this.gaps = pending;
      void pending.then(() => { if (this.gapWriter === pending) this.gapWriter = undefined; }, error => {
        if (this.gapWriter === pending) this.gapWriter = undefined;
        try { this.options.onError(error); } catch {}
      });
    }
  }
  flushGaps(): Promise<void> { return this.gaps; }
  async certify(write: () => Promise<boolean>, complete: boolean): Promise<boolean> {
    const generation = this.generation;
    await this.flushGaps();
    this.controller.signal.throwIfAborted();
    if (generation !== this.generation) return false;
    const committed = await write();
    this.controller.signal.throwIfAborted();
    if (generation !== this.generation) { await this.flushGaps(); return false; }
    if (committed && complete) this.gapFloor = undefined;
    return committed;
  }
  requestRetry(wake: boolean, work: (wake: boolean, signal: AbortSignal) => Promise<void>): Promise<void> {
    this.retryWake ||= wake;
    if (this.retryPending) return this.retryPending;
    const pending = this.run(async signal => {
      const shouldWake = this.retryWake;
      this.retryWake = false;
      await work(shouldWake, signal);
    }).finally(() => {
      if (this.retryPending === pending) this.retryPending = undefined;
      if (this.retryWake && !this.controller.signal.aborted) void this.requestRetry(false, work).catch(() => {});
    });
    this.retryPending = pending;
    return pending;
  }
  typing(work: (signal: AbortSignal) => Promise<void>): void {
    if (this.typingQueued) return;
    this.typingQueued = true;
    void this.run(work).finally(() => { this.typingQueued = false; }).catch(() => {});
  }
  admit(floor: number, work: (signal: AbortSignal) => Promise<void>): Promise<void> | undefined {
    if (this.queued >= (this.options.capacity ?? 200)) { this.markGap(floor); return; }
    this.queued++;
    return this.run(work).finally(() => { this.queued--; });
  }
  repair(options: RepairOptions): Promise<void> {
    if (this.repairPending) return this.repairPending;
    const pending = this.performRepair(options).finally(() => {
      if (this.repairPending === pending) this.repairPending = undefined;
    });
    this.repairPending = pending;
    return pending;
  }

  private async performRepair(options: RepairOptions): Promise<void> {
    if (this.gapFloor !== undefined && !this.gapWriter) this.markGap(this.gapFloor);
    await this.flushGaps();
    this.controller.signal.throwIfAborted();
    const generation = this.generation;
    const capturedRelays = options.relays ? [...new Set(options.relays())].sort() : undefined;
    if (capturedRelays) {
      if (!options.store.setDeliveryRelays) throw new Error('Delivery store cannot fence relay context');
      await options.store.setDeliveryRelays(capturedRelays);
    }
    let snapshot = await options.store.deliverySnapshot();
    this.controller.signal.throwIfAborted();
    if (generation !== this.generation) throw new Error('Delivery gap changed during replay startup');
    const assertRelays = () => {
      if (capturedRelays && JSON.stringify([...new Set(options.relays!())].sort()) !== JSON.stringify(capturedRelays)) {
        this.markGap(0);
        throw new Error('Configured relay set changed during replay');
      }
    };
    assertRelays();
    const channel = options.channel();
    const streams = channel.streams.map(stream => stream.group.pk);
    const missing = streams.filter(pk => snapshot.coverage[pk] === undefined);
    // An incomplete historical prefix resumes at the exact next second;
    // overlap applies only to a settled tail or newly discovered stream.
    const tail = snapshot.repairFloor ?? Math.max(0, (snapshot.certifiedUntil ?? snapshot.activationFloor) - 60);
    const introductions = missing.length ? [snapshot.recoveryFloor, ...missing.flatMap(pk => snapshot.legacyBoundaries[pk] === undefined ? [] : [snapshot.legacyBoundaries[pk]])].map(at => snapshot.repairFloor === undefined ? Math.max(0, at - 60) : at) : [];
    const floor = Math.min(tail, ...introductions);
    const attempt = new AbortController();
    this.attempt = attempt;
    const signal = AbortSignal.any([this.controller.signal, attempt.signal]);
    try {
      await options.replay(channel, floor, {
        signal,
        onBatch: async ({ chats }, context) => this.run(async () => {
          for (const chat of chats) {
            signal.throwIfAborted(); context.signal.throwIfAborted(); assertRelays();
            if (generation !== this.generation) throw new Error('Delivery gap changed during replay');
            if (!filterEpochCutoff([chat], options.channel()).length) continue;
            const known = [snapshot.legacyBoundaries[chat.streamPk], snapshot.ordinaryCoverage[chat.streamPk], snapshot.coverage[chat.streamPk]].filter((at): at is number => at !== undefined);
            const boundary = known.length ? Math.max(...known) : undefined;
            // A legacy cursor completed its boundary second. A recovery floor
            // instead begins with that second and must retain equal timestamps.
            const oldHistory = boundary === undefined ? chat.sourceWrapCreatedAt < snapshot.recoveryFloor : chat.sourceWrapCreatedAt <= boundary;
            if (oldHistory && chat.kind !== KIND_DELETE) continue;
            try { await options.deliver(chat, signal); }
            catch (error) {
              if (!signal.aborted) this.markGap(error instanceof ActionableDeletionCapacityError || error instanceof PromotionDeletionIntakeError
                ? Math.min(chat.sourceWrapCreatedAt, error.repairFloor) : chat.sourceWrapCreatedAt);
              throw error;
            }
          }
        }),
        onWindowComplete: async (window, context) => this.run(async () => {
          signal.throwIfAborted(); context.signal.throwIfAborted(); assertRelays();
          if (generation !== this.generation) throw new Error('Delivery gap changed during replay');
          if (snapshot.repairFloor !== undefined && snapshot.repairFloor > window.until) return;
          const coverage = { ...snapshot.coverage };
          for (const pk of streams) coverage[pk] = Math.max(coverage[pk] ?? 0, window.until);
          const committed = await this.certify(async () => {
            signal.throwIfAborted(); context.signal.throwIfAborted(); assertRelays();
            return options.store.certifyDelivery(snapshot.version, window.until, coverage, window.until === window.runUntil);
          }, window.until === window.runUntil);
          signal.throwIfAborted(); context.signal.throwIfAborted(); assertRelays();
          if (!committed || generation !== this.generation) throw new Error('Delivery checkpoint lost its fence');
          if (this.gapFloor !== undefined) this.gapFloor = window.until === window.runUntil ? undefined : window.until + 1;
          snapshot = await options.store.deliverySnapshot();
          signal.throwIfAborted(); context.signal.throwIfAborted(); assertRelays();
          if (generation !== this.generation) throw new Error('Delivery gap changed after checkpoint');
        }),
      });
      signal.throwIfAborted(); assertRelays();
    } finally {
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }

}
