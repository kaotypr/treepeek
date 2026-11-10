/**
 * Gathers what changed per key (a checkout, a repository, a scan root) and hands it on
 * once things go quiet (live-refresh design, "From event to UI", step 2): `quietMs` after
 * the last event for that key, but never later than `maxWaitMs` after the first, so a
 * steady trickle of changes still refreshes.
 */
export class CheckoutDebouncer<T extends string = string> {
  readonly #quietMs: number;
  readonly #maxWaitMs: number;
  readonly #onFlush: (key: string, items: T[]) => void;
  readonly #now: () => number;
  readonly #pending = new Map<
    string,
    { items: Set<T>; firstAt: number; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    onFlush: (key: string, items: T[]) => void,
    quietMs = 400,
    maxWaitMs = 2_000,
    now: () => number = Date.now,
  ) {
    this.#onFlush = onFlush;
    this.#quietMs = quietMs;
    this.#maxWaitMs = maxWaitMs;
    this.#now = now;
  }

  /** Adds `items` to what `key` will report, and restarts its quiet window. */
  add(key: string, items: Iterable<T>): void {
    const now = this.#now();
    const entry = this.#pending.get(key);
    if (entry) clearTimeout(entry.timer);
    const gathered = entry?.items ?? new Set<T>();
    for (const item of items) gathered.add(item);
    const firstAt = entry?.firstAt ?? now;
    const delay = Math.max(0, Math.min(this.#quietMs, firstAt + this.#maxWaitMs - now));
    this.#pending.set(key, {
      items: gathered,
      firstAt,
      timer: setTimeout(() => this.flush(key), delay),
    });
  }

  /** Takes `item` out of what `key` will report; forgets the key when nothing is left. */
  drop(key: string, item: T): void {
    const entry = this.#pending.get(key);
    if (!entry) return;
    entry.items.delete(item);
    if (entry.items.size > 0) return;
    clearTimeout(entry.timer);
    this.#pending.delete(key);
  }

  /** Reports `key` now, if anything is pending for it. */
  flush(key: string): void {
    const entry = this.#pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(key);
    this.#onFlush(key, [...entry.items]);
  }

  /** Whether anything is waiting to be reported. */
  get pending(): number {
    return this.#pending.size;
  }

  /** Forgets everything pending without reporting it. */
  dispose(): void {
    for (const entry of this.#pending.values()) clearTimeout(entry.timer);
    this.#pending.clear();
  }
}
