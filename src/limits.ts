/**
 * Counts per key over a sliding window, in memory. One process serves this, and
 * a restart forgetting the counts costs at most one window.
 */
export class RateLimiter {
  readonly windowMs: number;
  readonly max: number;
  private hits = new Map<string, number[]>();

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs;
    this.max = max;
  }

  /** Records the attempt when it is allowed. A refused one costs nothing more. */
  take(key: string, now: number): boolean {
    if (this.max === 0) return true;
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  prune(now: number): void {
    const since = now - this.windowMs;
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => t > since);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
