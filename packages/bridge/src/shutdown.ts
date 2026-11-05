/** Coordinates early abort with resources that can arrive while startup awaits. */
export class Shutdown {
  private readonly controller = new AbortController();
  private readonly cleanup: Array<() => void | Promise<void>> = [];
  private finish!: () => void;
  private readonly startup = new Promise<void>(resolve => { this.finish = resolve; });
  private stopping?: Promise<void>;
  private drained = false;
  constructor(private readonly timeout: number) {}
  get signal(): AbortSignal { return this.controller.signal; }
  register(close: () => void | Promise<void>): void {
    if (this.drained) { void Promise.resolve().then(close).catch(() => {}); return; }
    this.cleanup.push(close);
  }
  finishStartup(): void { this.finish(); }
  begin(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.controller.abort();
    const deadline = Date.now() + this.timeout;
    const bounded = async (work: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([work.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
      if (timer) clearTimeout(timer);
    };
    this.stopping = (async () => {
      await bounded(this.startup);
      while (this.cleanup.length) await bounded(Promise.resolve().then(this.cleanup.pop()!));
      this.drained = true;
    })();
    return this.stopping;
  }
}
