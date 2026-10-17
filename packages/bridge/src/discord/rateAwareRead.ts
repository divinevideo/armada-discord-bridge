/** A bounded, token-scoped lane for raw visibility GETs, not an authorization cache. */
export class DiscordReadScheduler {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private nextAt = 0;

  constructor(
    private readonly read: (path: string) => Promise<Response>,
    private readonly clock = {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
  ) {}

  get(path: string): Promise<unknown> {
    if (this.pending >= 64) return Promise.reject(new Error("Discord visibility queue full"));
    const deadline = this.clock.now() + 30_000;
    this.pending++;
    const work = this.tail.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = Math.max(0, this.nextAt - this.clock.now());
        // Never shorten Discord's wait and retry early. Fail closed instead.
        if (this.clock.now() + wait >= deadline) throw new Error("Discord visibility rate limit unavailable");
        if (wait) await this.clock.sleep(wait);
        const response = await this.read(path);
        const reset = Number(response.headers.get("X-RateLimit-Reset-After"));
        if (response.headers.get("X-RateLimit-Remaining") === "0" && Number.isFinite(reset) && reset > 0) {
          this.nextAt = Math.max(this.nextAt, this.clock.now() + reset * 1000);
        }
        if (response.status !== 429) {
          if (!response.ok) throw new Error("Discord visibility data unavailable");
          return response.json();
        }
        let seconds = Number(response.headers.get("Retry-After"));
        try {
          const body = await response.json() as { retry_after?: number };
          if (typeof body.retry_after === "number") seconds = body.retry_after;
        } catch { /* A non-JSON 429 still has its Retry-After header. */ }
        if (!Number.isFinite(seconds) || seconds <= 0) seconds = 1;
        // One serial lane also honors global 429s across different routes.
        this.nextAt = Math.max(this.nextAt, this.clock.now() + seconds * 1000);
      }
      throw new Error("Discord visibility rate limit unavailable");
    }).finally(() => { this.pending--; });
    this.tail = work.then(() => {}, () => {});
    return work;
  }
}
