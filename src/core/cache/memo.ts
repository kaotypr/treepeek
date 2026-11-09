import { GitError } from "../git/errors";
import { Lru } from "./lru";

interface Pending<V> {
  state: "pending";
  promise: Promise<V>;
  /** Aborts the computation once every caller waiting for it has given up. */
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

interface Done<V> {
  state: "done";
  value: V;
}

type Entry<V> = Pending<V> | Done<V>;

/**
 * Cached results of async computations (git queries), shared by every caller asking for
 * the same key, so two windows on the same repository run each query once.
 *
 * - A caller asking while the computation runs waits for the same one.
 * - Each caller's own signal only detaches that caller (it rejects with `cancelled`); the
 *   computation is aborted, and forgotten, once no caller is waiting for it.
 * - A failed computation is not cached; the next caller tries again.
 * - `delete` and `clear` forget results (invalidation). A computation still running keeps
 *   serving the callers already waiting, but its result is not stored.
 *
 * With `maxEntries`, the least recently used results are dropped past the limit.
 */
export class Memo<K, V> {
  readonly #entries: Lru<K, Entry<V>>;

  constructor(maxEntries: number = Infinity) {
    this.#entries = new Lru(maxEntries);
  }

  /** Results stored or being computed. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * The result for `key`: the stored one, the one being computed, or a new computation
   * started with `compute`, whose signal aborts when no caller waits any more.
   */
  get(key: K, compute: (signal: AbortSignal) => Promise<V>, signal: AbortSignal): Promise<V> {
    if (signal.aborted) return Promise.reject(cancelledError());
    const existing = this.#entries.get(key);
    if (existing?.state === "done") return Promise.resolve(existing.value);
    return this.#wait(key, existing ?? this.#start(key, compute), signal);
  }

  /** The stored result for `key`, without computing anything. */
  peek(key: K): V | undefined {
    const entry = this.#entries.peek(key);
    return entry?.state === "done" ? entry.value : undefined;
  }

  /** Stores a result computed elsewhere. */
  set(key: K, value: V): void {
    this.#entries.set(key, { state: "done", value });
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  keys(): K[] {
    return [...this.#entries.keys()];
  }

  #start(key: K, compute: (signal: AbortSignal) => Promise<V>): Pending<V> {
    const controller = new AbortController();
    let promise: Promise<V>;
    try {
      promise = compute(controller.signal);
    } catch (error) {
      promise = Promise.reject(error);
    }
    const entry: Pending<V> = { state: "pending", promise, controller, waiters: 0, settled: false };
    this.#entries.set(key, entry);
    promise.then(
      (value) => {
        entry.settled = true;
        if (this.#entries.peek(key) === entry) this.#entries.set(key, { state: "done", value });
      },
      () => {
        entry.settled = true;
        if (this.#entries.peek(key) === entry) this.#entries.delete(key);
      },
    );
    return entry;
  }

  #wait(key: K, entry: Pending<V>, signal: AbortSignal): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      entry.waiters += 1;
      let attached = true;
      const detach = (): boolean => {
        if (!attached) return false;
        attached = false;
        signal.removeEventListener("abort", onAbort);
        entry.waiters -= 1;
        return true;
      };
      const onAbort = () => {
        if (!detach()) return;
        reject(cancelledError());
        if (entry.waiters === 0 && !entry.settled) {
          if (this.#entries.peek(key) === entry) this.#entries.delete(key);
          entry.controller.abort();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => {
          if (detach()) resolve(value);
        },
        (error: unknown) => {
          if (detach()) reject(error);
        },
      );
    });
  }
}

function cancelledError(): GitError {
  return new GitError("cancelled", "The Git command was cancelled.");
}
