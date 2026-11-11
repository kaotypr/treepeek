/**
 * The core service's local store (review-marks design, "Local store"): what Treepeek keeps
 * about worktrees between runs, outside every repository. Callers use this interface only,
 * so the engine (SQLite or JSON files) can change without touching them.
 *
 * Every method is synchronous: both engines answer from the same process (SQLite through
 * `node:sqlite`, JSON from files it re-reads only when they changed), so within one process
 * a synchronous store cannot interleave two read-modify-write sequences. Several processes
 * may share one store (a core service per window): SQLite serializes their writes itself,
 * and the JSON engine merges each process's own changes into the file under a lock
 * (`json-store.ts`).
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

/**
 * One review mark (the `mark` table): the version of a file a reviewer marked Viewed. One
 * current mark per `(worktreeId, path)`.
 */
export interface Mark {
  worktreeId: string;
  /** Repository-relative, `/`-separated. */
  path: string;
  /** The `resultHash` of the version marked. */
  resultHash: string;
  /** ISO 8601 UTC, to the second. */
  viewedAt: string;
  /**
   * The snapshot holding the content that was viewed (its `resultHash`, which names the
   * snapshot), or `null` when none was kept (too large, binary, a deletion, or pruned).
   */
  snapshotHash: string | null;
}

/** A mark as a caller sets it; the worktree is the call's. */
export type MarkInput = Omit<Mark, "worktreeId">;

/** What the snapshot store holds. */
export interface SnapshotUsage {
  count: number;
  bytes: number;
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

  /** Every mark of an identity, by path. */
  getMarks(worktreeId: string): Mark[];
  /**
   * Stores marks for an identity, each replacing the path's current mark. The identity must
   * have been recorded with `upsertWorktree` first; otherwise this throws a `StoreError`. A
   * snapshot a replaced mark leaves unreferenced stays until pruning, so an undo can bring
   * the mark back with it.
   */
  setMarks(worktreeId: string, marks: readonly MarkInput[]): void;
  /** Deletes an identity's marks for `paths`, or all of them without `paths`. */
  deleteMarks(worktreeId: string, paths?: readonly string[]): void;
  /**
   * Keeps `bytes` as the snapshot named `hash` (a `resultHash` that is an object id). A
   * snapshot already kept under that name is left as it is: the name is the content's.
   */
  putSnapshot(hash: string, bytes: Uint8Array): void;
  /** The snapshot's content, or `null` when it is not kept. */
  getSnapshot(hash: string): Buffer | null;
  /** Whether a snapshot is kept under `hash`, without reading it. */
  hasSnapshot(hash: string): boolean;
  snapshotUsage(): SnapshotUsage;
  /** Deletes every snapshot no mark references. Answers how many went. */
  deleteUnreferencedSnapshots(): number;
  /**
   * Brings the snapshot store under `capBytes`: the oldest unreferenced snapshots go first,
   * then the snapshots of the oldest marks, whose `snapshotHash` becomes `null`. Answers how
   * many snapshots went.
   */
  pruneSnapshots(capBytes: number): number;
  /**
   * The identities of one repository whose checkout path is not in `seenPaths` and which
   * were last seen before `olderThan` (a store time).
   */
  listStaleWorktrees(
    commonDir: string,
    seenPaths: ReadonlySet<string>,
    olderThan: string,
  ): WorktreeRow[];
  /**
   * Forgets an identity: its row, its start override and its marks, then the snapshots that
   * leaves unreferenced.
   */
  deleteWorktree(worktreeId: string): void;
  /** Deletes every mark and every snapshot; identities and start overrides stay. */
  clearReviewData(): void;

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

/** The earlier of two store times. */
export function earlierTime(a: string, b: string): string {
  return a <= b ? a : b;
}
