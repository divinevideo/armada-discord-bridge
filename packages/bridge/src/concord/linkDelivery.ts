/** One lane remains owned by the link when its stream subscription changes. */
export class LinkDelivery {
  private readonly controller = new AbortController();
  private lane: Promise<void> = Promise.resolve();
  private gaps: Promise<void> = Promise.resolve();
  private gapWriter?: Promise<void>;
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
  stop(): void { this.controller.abort(); }
  run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const result = this.lane.then(() => { this.controller.signal.throwIfAborted(); return work(this.controller.signal); });
    this.lane = result.catch(error => { this.options.onError(error); });
    return result;
  }
  markGap(floor: number): void {
    this.generation++;
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
        this.options.onError(error);
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
}
