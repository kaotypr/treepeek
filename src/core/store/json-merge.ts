import { earlierTime, laterTime } from "./review-store";

/**
 * How one process's changes to a repository's JSON document are laid onto the document
 * another process left on disk (core-reuse design, change 6). Each process writes only the
 * keys it changed, so whatever else the file holds stays as the other process wrote it.
 *
 * Every pending change carries its base: the value this process last saw on disk for that
 * key. A key whose disk value still equals the base has no conflict and takes the change,
 * so one writer alone is never judged by clocks. A key another process changed meanwhile
 * is decided by time: `viewedAt` for marks, `setAt` for start overrides, with a tie going
 * to the change being laid on. A removal leaves no trace on disk (the schema has no
 * tombstones), so a mark set after a removal was written always wins over it.
 */

/** One worktree row as a document keeps it (the identity is the key). */
export interface StoredWorktree {
  checkoutPath: string;
  startCommit: string | null;
  startObservedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface StoredOverride {
  commit: string;
  setAt: string;
}

export interface StoredMark {
  resultHash: string;
  viewedAt: string;
  snapshotHash: string | null;
}

/** One repository's document (`<sha256 of common dir>.json`). */
export interface RepositoryDocument {
  schemaVersion: number;
  commonDir: string;
  worktrees: Record<string, StoredWorktree>;
  startOverrides: Record<string, StoredOverride>;
  /** worktreeId → path → mark. */
  marks: Record<string, Record<string, StoredMark>>;
}

/** A change to one `(worktree, path)` mark. */
export type MarkChange =
  | { kind: "set"; mark: StoredMark; base: StoredMark | null }
  /** Removed at `at` (a store time). */
  | { kind: "remove"; at: string; base: StoredMark | null }
  /** The mark's snapshot was pruned: it keeps its version and loses `snapshotHash`. */
  | { kind: "unlink"; snapshotHash: string; base: StoredMark };

/** A change to one worktree's start override; a removal is timed by its `setAt`. */
export type OverrideChange =
  | { kind: "set"; override: StoredOverride; base: StoredOverride | null }
  | { kind: "remove"; at: string; base: StoredOverride | null };

/** What a worktree delete takes away: its row, its override and its marks. */
export interface WorktreeState {
  row: StoredWorktree | null;
  override: StoredOverride | null;
  marks: Record<string, StoredMark>;
}

/** Forgetting a worktree (pruning), guarded by everything it would take away. */
export interface WorktreeDelete {
  base: WorktreeState;
}

/** What one process changed in one repository since it last read or wrote the file. */
export class PendingChanges {
  /** Worktree rows seen in scans, merged field by field; they never conflict. */
  readonly upserts = new Map<string, StoredWorktree>();
  readonly overrides = new Map<string, OverrideChange>();
  /** worktreeId → path → change. */
  readonly marks = new Map<string, Map<string, MarkChange>>();
  readonly deletes = new Map<string, WorktreeDelete>();

  get isEmpty(): boolean {
    return (
      this.upserts.size === 0 &&
      this.overrides.size === 0 &&
      this.marks.size === 0 &&
      this.deletes.size === 0
    );
  }

  markChange(worktreeId: string, path: string): MarkChange | undefined {
    return this.marks.get(worktreeId)?.get(path);
  }

  setMark(worktreeId: string, path: string, change: MarkChange): void {
    let changes = this.marks.get(worktreeId);
    if (!changes) {
      changes = new Map();
      this.marks.set(worktreeId, changes);
    }
    changes.set(path, change);
  }

  /** Drops every change to `worktreeId` but its delete. */
  forgetWorktree(worktreeId: string): void {
    this.upserts.delete(worktreeId);
    this.overrides.delete(worktreeId);
    this.marks.delete(worktreeId);
  }
}

export interface MergeResult {
  /** The document on disk with the changes that won laid on top: what gets written. */
  document: RepositoryDocument;
  /**
   * The changes that won, each with the disk value as its new base. Kept as pending when
   * the merge only refreshes what a process reads; done once the document is written.
   */
  pending: PendingChanges;
}

/**
 * Lays `pending` onto `theirs`, the document as it is on disk now. Neither argument is
 * changed. Deletes go first, so changes made after a delete in the same process apply to
 * what it left; then rows, overrides and marks.
 */
export function mergeDocument(theirs: RepositoryDocument, pending: PendingChanges): MergeResult {
  const document = structuredClone(theirs);
  const survivors = new PendingChanges();

  for (const [worktreeId, change] of pending.deletes) {
    // Anyone touching the worktree since this process read it (a newer scan, a mark, an
    // override) keeps it.
    if (!sameState(worktreeState(theirs, worktreeId), change.base)) continue;
    delete document.worktrees[worktreeId];
    delete document.startOverrides[worktreeId];
    delete document.marks[worktreeId];
    survivors.deletes.set(worktreeId, change);
  }

  for (const [worktreeId, row] of pending.upserts) {
    const disk = document.worktrees[worktreeId];
    document.worktrees[worktreeId] = disk ? mergeRows(disk, row) : { ...row };
    survivors.upserts.set(worktreeId, row);
  }

  for (const [worktreeId, change] of pending.overrides) {
    const disk = theirs.startOverrides[worktreeId] ?? null;
    const { value, wins } = decideOverride(disk, change);
    if (value) document.startOverrides[worktreeId] = { ...value };
    else delete document.startOverrides[worktreeId];
    if (wins) survivors.overrides.set(worktreeId, { ...change, base: disk });
  }

  for (const [worktreeId, changes] of pending.marks) {
    const diskMarks = theirs.marks[worktreeId] ?? {};
    const marks = { ...(document.marks[worktreeId] ?? {}) };
    for (const [path, change] of changes) {
      const disk = diskMarks[path] ?? null;
      const { value, wins } = decideMark(disk, change);
      if (value) marks[path] = { ...value };
      else delete marks[path];
      if (!wins) continue;
      if (change.kind === "unlink") {
        if (disk) survivors.setMark(worktreeId, path, { ...change, base: disk });
      } else {
        survivors.setMark(worktreeId, path, { ...change, base: disk });
      }
    }
    if (Object.keys(marks).length > 0) document.marks[worktreeId] = marks;
    else delete document.marks[worktreeId];
  }

  return { document, pending: survivors };
}

/** What a document holds for one worktree, as a delete compares it. */
export function worktreeState(document: RepositoryDocument, worktreeId: string): WorktreeState {
  return {
    row: document.worktrees[worktreeId] ?? null,
    override: document.startOverrides[worktreeId] ?? null,
    marks: document.marks[worktreeId] ?? {},
  };
}

/** Two sightings of one row: the earliest first sighting, the latest last one. */
export function mergeRows(disk: StoredWorktree, mine: StoredWorktree): StoredWorktree {
  return {
    checkoutPath: disk.checkoutPath,
    startCommit: disk.startCommit,
    startObservedAt: disk.startObservedAt ?? mine.startObservedAt,
    firstSeenAt: earlierTime(disk.firstSeenAt, mine.firstSeenAt),
    lastSeenAt: laterTime(disk.lastSeenAt, mine.lastSeenAt),
  };
}

interface Decision<T> {
  /** What the key holds after the merge; `null` for nothing. */
  value: T | null;
  /** Whether the pending change took effect (and stays pending until written). */
  wins: boolean;
}

function decideMark(disk: StoredMark | null, change: MarkChange): Decision<StoredMark> {
  const unchanged = sameMark(disk, change.base);
  switch (change.kind) {
    case "set":
      if (unchanged || disk === null || change.mark.viewedAt >= disk.viewedAt) {
        return { value: change.mark, wins: true };
      }
      return { value: disk, wins: false };
    case "remove":
      // Nothing left to remove: the change has nothing more to do.
      if (disk === null) return { value: null, wins: false };
      if (unchanged || disk.viewedAt <= change.at) return { value: null, wins: true };
      return { value: disk, wins: false };
    case "unlink":
      if (!unchanged || disk === null || disk.snapshotHash !== change.snapshotHash) {
        return { value: disk, wins: false };
      }
      return { value: { ...disk, snapshotHash: null }, wins: true };
  }
}

function decideOverride(
  disk: StoredOverride | null,
  change: OverrideChange,
): Decision<StoredOverride> {
  const unchanged = sameOverride(disk, change.base);
  if (change.kind === "set") {
    if (unchanged || disk === null || change.override.setAt >= disk.setAt) {
      return { value: change.override, wins: true };
    }
    return { value: disk, wins: false };
  }
  if (disk === null) return { value: null, wins: false };
  if (unchanged || disk.setAt <= change.at) return { value: null, wins: true };
  return { value: disk, wins: false };
}

export function sameMark(a: StoredMark | null, b: StoredMark | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.resultHash === b.resultHash && a.viewedAt === b.viewedAt && a.snapshotHash === b.snapshotHash
  );
}

function sameOverride(a: StoredOverride | null, b: StoredOverride | null): boolean {
  if (a === null || b === null) return a === b;
  return a.commit === b.commit && a.setAt === b.setAt;
}

function sameRow(a: StoredWorktree | null, b: StoredWorktree | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.checkoutPath === b.checkoutPath &&
    a.startCommit === b.startCommit &&
    a.startObservedAt === b.startObservedAt &&
    a.firstSeenAt === b.firstSeenAt &&
    a.lastSeenAt === b.lastSeenAt
  );
}

function sameState(a: WorktreeState, b: WorktreeState): boolean {
  if (!sameRow(a.row, b.row) || !sameOverride(a.override, b.override)) return false;
  const paths = Object.keys(a.marks);
  if (paths.length !== Object.keys(b.marks).length) return false;
  return paths.every((path) => sameMark(a.marks[path] ?? null, b.marks[path] ?? null));
}
