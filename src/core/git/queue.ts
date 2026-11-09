import { GIT_CONCURRENCY } from "../../shared/constants";
import { GitError } from "./errors";

/**
 * `normal` is work a person is waiting for (a scan, a diff they opened). `low` is
 * background work (prefetching, hashing for marks); it starts only when no normal task is
 * waiting.
 */
export type GitPriority = "normal" | "low";

interface Waiting {
  start: () => void;
  cancel: () => void;
}

/**
 * Limits how many git processes run at once across every session, so a scan of fifty
 * worktrees cannot start hundreds of processes.
 */
export class GitQueue {
  readonly #concurrency: number;
  readonly #lanes: Record<GitPriority, Waiting[]> = { normal: [], low: [] };
  #active = 0;

  constructor(concurrency: number = GIT_CONCURRENCY) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    this.#concurrency = concurrency;
  }

  /** Tasks waiting for a slot. */
  get size(): number {
    return this.#lanes.normal.length + this.#lanes.low.length;
  }

  /** Tasks running now. */
  get active(): number {
    return this.#active;
  }

  /**
   * Runs `task` once a slot is free. A task still waiting when `signal` aborts never
   * starts and rejects with `cancelled`; a running task is the caller's to stop.
   */
  run<T>(
    task: () => Promise<T>,
    priority: GitPriority = "normal",
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise<T>((resolve, reject) => {
      const lane = this.#lanes[priority];
      const onAbort = () => entry.cancel();
      const entry: Waiting = {
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          this.#active += 1;
          let settled: Promise<T>;
          try {
            settled = task();
          } catch (error) {
            settled = Promise.reject(error);
          }
          // Free the slot before settling, so a caller that awaits the result sees it free.
          const release = () => {
            this.#active -= 1;
            this.#next();
          };
          settled.then(
            (value) => {
              release();
              resolve(value);
            },
            (error: unknown) => {
              release();
              reject(error);
            },
          );
        },
        cancel: () => {
          const index = lane.indexOf(entry);
          if (index === -1) return;
          lane.splice(index, 1);
          reject(cancelled());
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      lane.push(entry);
      this.#next();
    });
  }

  #next(): void {
    while (this.#active < this.#concurrency) {
      const entry = this.#lanes.normal.shift() ?? this.#lanes.low.shift();
      if (!entry) return;
      entry.start();
    }
  }
}

function cancelled(): GitError {
  return new GitError("cancelled", "The Git command was cancelled.");
}
