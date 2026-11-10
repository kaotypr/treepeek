/**
 * Notices an event storm in a checkout's working tree (live-refresh design, "Floods,
 * sleep and failure"): more than `threshold` events within `windowMs`, as a build writing
 * thousands of files or `npm install` into a folder the skip list does not cover. The
 * checkout's working-tree refresh then stays paused until `resume`; its git-dir signals
 * are not counted here and keep working.
 */
export class StormGuard {
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  /** Recent event counts per checkout, oldest first. */
  readonly #recent = new Map<string, { at: number; count: number }[]>();
  /** When each paused checkout paused. */
  readonly #paused = new Map<string, number>();

  constructor(threshold = 2_000, windowMs = 2_000, now: () => number = Date.now) {
    this.#threshold = threshold;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Counts `count` working-tree events for `checkoutPath`. Returns `true` when this pushes
   * it over the threshold: the checkout is paused from now on.
   */
  record(checkoutPath: string, count = 1): boolean {
    if (this.#paused.has(checkoutPath)) return false;
    const now = this.#now();
    const recent = (this.#recent.get(checkoutPath) ?? []).filter(
      (entry) => now - entry.at < this.#windowMs,
    );
    recent.push({ at: now, count });
    const total = recent.reduce((sum, entry) => sum + entry.count, 0);
    if (total <= this.#threshold) {
      this.#recent.set(checkoutPath, recent);
      return false;
    }
    this.#recent.delete(checkoutPath);
    this.#paused.set(checkoutPath, now);
    return true;
  }

  isPaused(checkoutPath: string): boolean {
    return this.#paused.has(checkoutPath);
  }

  /** The paused checkouts and when each paused. */
  paused(): ReadonlyMap<string, number> {
    return this.#paused;
  }

  /** Lets the checkout's working-tree refresh run again; `true` when it was paused. */
  resume(checkoutPath: string): boolean {
    this.#recent.delete(checkoutPath);
    return this.#paused.delete(checkoutPath);
  }

  /** Forgets a checkout no longer watched. */
  forget(checkoutPath: string): void {
    this.#recent.delete(checkoutPath);
    this.#paused.delete(checkoutPath);
  }
}
