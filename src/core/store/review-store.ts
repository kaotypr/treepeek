/**
 * The core service's local store (review-marks design, "Local store"): what Treepeek keeps
 * about worktrees between runs, outside every repository. Callers use this interface only,
 * so the engine (SQLite or JSON files) can change without touching them. Review marks and
 * snapshots extend it later.
 *
 * Every method is synchronous: both engines answer from the same process (SQLite through
 * `node:sqlite`, JSON from memory), and a synchronous store cannot interleave two
 * read-modify-write sequences.
 */

export type StoreEngine = "sqlite" | "json";

/** One worktree identity seen in a scan (the `worktree` table). */
export interface WorktreeRow {
  /** `worktreeId(commonDir, checkoutPath, startCommit)`. */
  worktreeId: string;
  commonDir: string;
  checkoutPath: string;
  /** The start commit the identity was made from, or `null` when the start was unknown. */
  startCommit: string | null;
  /**
   * When that start was observed in the reflog (ISO 8601 UTC), or `null` when unknown.
   * Kept so a start reused after the reflog expires keeps its place on the timeline.
   */
  startObservedAt: string | null;
  /** ISO 8601 UTC, to the second. */
  firstSeenAt: string;
  /** ISO 8601 UTC, to the second. */
  lastSeenAt: string;
}

/** A start the user entered for one identity (the `start_override` table). */
export interface StartOverride {
  worktreeId: string;
  /** Full commit id. */
  commit: string;
  /** ISO 8601 UTC, to the second. */
  setAt: string;
}

export interface ReviewStore {
  readonly engine: StoreEngine;
  /**
   * Records an identity seen in a scan. For an identity already stored, `lastSeenAt` moves
   * forward, `firstSeenAt` and the start stay as first recorded, and a missing
   * `startObservedAt` is filled in.
   */
  upsertWorktree(row: WorktreeRow): void;
  getWorktree(worktreeId: string): WorktreeRow | null;
  /** Every identity recorded for one checkout path of one repository, oldest first. */
  findWorktreesByPath(commonDir: string, checkoutPath: string): WorktreeRow[];
  /**
   * Sets (or with `null`, removes) the user's start for an identity. The identity must have
   * been recorded with `upsertWorktree` first; otherwise this throws a `StoreError`.
   */
  setStartOverride(worktreeId: string, commit: string | null, setAt?: string): void;
  getStartOverride(worktreeId: string): StartOverride | null;
  /** Writes anything pending and closes the store; it cannot be used afterwards. */
  close(): void;
}

/** A store that cannot be opened or used as asked. */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
  }
}

/** A time as the store keeps it: ISO 8601 UTC to the second, `2026-11-09T08:54:36Z`. */
export function storeTime(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The later of two store times (both `storeTime` form, so they sort as text). */
export function laterTime(a: string, b: string): string {
  return a >= b ? a : b;
}
