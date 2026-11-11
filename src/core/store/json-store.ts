import { createHash, randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { Logger } from "../../shared/log";
import { acquireFileLock, LOCK_TIMEOUT_MS } from "./file-lock";
import {
  type MarkChange,
  mergeDocument,
  PendingChanges,
  type RepositoryDocument,
  type StoredWorktree,
  worktreeState,
} from "./json-merge";
import { type JsonDocument, pendingMigrations, SCHEMA_VERSION } from "./migrations";
import {
  laterTime,
  type Mark,
  type MarkInput,
  type ReviewStore,
  type SnapshotUsage,
  type StartOverride,
  StoreError,
  storeTime,
  type WorktreeRow,
} from "./review-store";
import { SNAPSHOT_FOLDER, type SnapshotFile, SnapshotFolder } from "./snapshots";

/** How long scan sightings and snapshot unlinks are gathered before one file write. */
export const JSON_FLUSH_DELAY_MS = 250;

/**
 * Snapshots this young are never deleted unless this process wrote them and nobody used
 * them since: another process may have written one for a mark it has not written yet.
 */
export const SNAPSHOT_GRACE_MS = 5 * 60_000;

/** A temporary snapshot file younger than this may be another process's write in flight. */
const SNAPSHOT_TEMPORARY_MIN_AGE_MS = 60_000;

/** The first wait before a failed write is tried again; it doubles up to the maximum. */
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

const FILE_NAME = /^[0-9a-f]{64}\.json$/;

const TimeSchema = v.pipe(v.string(), v.isoTimestamp());

const DocumentSchema = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  commonDir: v.string(),
  worktrees: v.record(
    v.string(),
    v.object({
      checkoutPath: v.string(),
      startCommit: v.nullable(v.string()),
      startObservedAt: v.nullable(TimeSchema),
      firstSeenAt: TimeSchema,
      lastSeenAt: TimeSchema,
    }),
  ),
  startOverrides: v.record(v.string(), v.object({ commit: v.string(), setAt: TimeSchema })),
  /** worktreeId → path → mark. */
  marks: v.record(
    v.string(),
    v.record(
      v.string(),
      v.object({
        resultHash: v.string(),
        viewedAt: TimeSchema,
        snapshotHash: v.nullable(v.string()),
      }),
    ),
  ),
});

export interface JsonStoreOptions {
  /** Delay before gathered writes reach the disk. Default `JSON_FLUSH_DELAY_MS`. */
  flushDelayMs?: number;
  /** How long a write waits for another process's lock. Default `LOCK_TIMEOUT_MS`. */
  lockTimeoutMs?: number;
  /** The clock that times removals and start overrides; tests pin it. */
  now?: () => Date;
  log?: Logger;
}

/** The file a repository's document lives in: the SHA-256 of its common dir. */
export function repositoryFileName(commonDir: string): string {
  return `${createHash("sha256").update(commonDir).digest("hex")}.json`;
}

/** What identifies one version of a file: replacing it by a rename changes the inode. */
interface Stamp {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

/** One repository's document as this process holds it. */
interface Repository {
  readonly commonDir: string;
  readonly name: string;
  readonly file: string;
  /** The document as this process last read or wrote it. Never changed in place. */
  synced: RepositoryDocument;
  /** The file's stamp when `synced` was taken; `null` when there was no file. */
  stamp: Stamp | null;
  /** `synced` with `pending` laid on top: what every read answers from. */
  view: RepositoryDocument;
  /** What this process changed since `synced`. */
  pending: PendingChanges;
  /** A newer Treepeek wrote the file after this store opened: it is never written again. */
  readOnly: boolean;
  /** Whether leftover temporary files were removed under the lock yet. */
  swept: boolean;
}

/** The file on disk against `synced`. */
type Look =
  | { kind: "same" }
  | { kind: "changed"; document: RepositoryDocument; stamp: Stamp | null }
  | { kind: "readOnly" };

type FileRead =
  | { kind: "document"; document: RepositoryDocument; stamp: Stamp }
  | { kind: "missing" }
  | { kind: "newer"; version: number; stamp: Stamp }
  | { kind: "unreadable"; reason: string; error: unknown; stamp: Stamp };

/**
 * The store as one JSON file per repository (`store/<sha256 of common dir>.json`), the
 * review-marks design's fallback for a runtime without `node:sqlite`. Several processes
 * may share the folder (one core service per window in the VS Code extension), so no
 * process trusts its memory for longer than one call:
 *
 * - Every call that touches a document first compares the file's stamp (inode, size,
 *   mtime) with the one this process last read or wrote, and reads it again when another
 *   process replaced it. A worktree id or common dir it does not know makes it list the
 *   folder again. Readers take no lock: a file only ever changes by an atomic rename. A
 *   worktree delete is the one exception: it is guarded by the worktree as last read, so
 *   pruning drops it when another process scanned or changed the worktree since.
 * - Each change is kept as a pending change with its base (`json-merge.ts`). A write takes
 *   the repository's lock (`file-lock.ts`), merges the pending changes into the file as it
 *   is then, writes a temporary file (pid and nonce in its name), fsyncs it and renames it
 *   over the file. A single writer finds its own file unchanged and never re-reads it.
 * - The user's changes (marks, start overrides, deletes, clearing) are written at once,
 *   so two processes' changes to one file are ordered by when they were made unless they
 *   fall within one write of each other. Scan sightings and snapshot unlinks are gathered
 *   for `flushDelayMs`. A write that cannot take the lock, or fails, keeps its changes
 *   pending and is tried again later; only `close()` and `flush()` throw for it.
 *
 * A file that cannot be read or checked when the store opens is moved aside
 * (`<name>.corrupt-<time>`) and the repository starts empty, so one damaged file never
 * stops the app; a file from a newer schema stops the store from opening, so it is never
 * overwritten. Found later, a damaged file is merged over from the last copy this process
 * read, and a newer one makes its repository read-only for this process.
 *
 * Marks live in their repository's document. Snapshots are shared by every repository, so
 * their table is the snapshot folder itself (`snapshots/`): a file's size and time are its
 * row, and references are counted across every repository's file, read again first, and
 * this process's pending marks. Linking a snapshot to a mark touches its file, and a
 * snapshot is deleted only once its file is `SNAPSHOT_GRACE_MS` old, unless this process
 * wrote it and its time is still the one this process left.
 */
export class JsonReviewStore implements ReviewStore {
  readonly engine = "json" as const;
  readonly dir: string;
  readonly #snapshots: SnapshotFolder;
  readonly #flushDelayMs: number;
  readonly #lockTimeoutMs: number;
  readonly #now: () => Date;
  readonly #log: Logger | undefined;
  /** commonDir → repository. */
  readonly #repositories = new Map<string, Repository>();
  /** The file names of `#repositories`, to tell the files other processes created. */
  readonly #names = new Set<string>();
  /** worktreeId → repository. An id hashes its common dir, so its repository never changes. */
  readonly #byWorktree = new Map<string, Repository>();
  /** The file version each problem was last reported for, so each is reported once. */
  readonly #reported = new Map<string, Stamp>();
  /** Snapshots this process wrote, with the modification time it left on each. */
  readonly #ownSnapshots = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #retryDelayMs = RETRY_DELAY_MS;
  #open = true;

  constructor(dir: string, options: JsonStoreOptions = {}) {
    this.dir = dir;
    this.#flushDelayMs = options.flushDelayMs ?? JSON_FLUSH_DELAY_MS;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log;
    mkdirSync(dir, { recursive: true });
    this.#snapshots = new SnapshotFolder(join(dir, SNAPSHOT_FOLDER), {
      temporaryMinAgeMs: SNAPSHOT_TEMPORARY_MIN_AGE_MS,
    });
    for (const name of readdirSync(dir)) {
      if (FILE_NAME.test(name)) this.#loadAtOpen(name);
    }
  }

  upsertWorktree(row: WorktreeRow): void {
    this.#check();
    const repo = this.#repository(row.commonDir);
    this.#byWorktree.set(row.worktreeId, repo);
    const existing = repo.view.worktrees[row.worktreeId];
    const next: StoredWorktree = existing
      ? {
          ...existing,
          startObservedAt: existing.startObservedAt ?? row.startObservedAt,
          lastSeenAt: laterTime(existing.lastSeenAt, row.lastSeenAt),
        }
      : {
          checkoutPath: row.checkoutPath,
          startCommit: row.startCommit,
          startObservedAt: row.startObservedAt,
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
        };
    if (
      existing &&
      existing.startObservedAt === next.startObservedAt &&
      existing.lastSeenAt === next.lastSeenAt
    ) {
      return;
    }
    repo.view.worktrees[row.worktreeId] = next;
    if (repo.readOnly) return;
    repo.pending.upserts.set(row.worktreeId, { ...next });
    this.#schedule(this.#flushDelayMs);
  }

  getWorktree(worktreeId: string): WorktreeRow | null {
    this.#check();
    const repo = this.#worktreeRepository(worktreeId);
    const entry = repo?.view.worktrees[worktreeId];
    return repo && entry ? { worktreeId, commonDir: repo.commonDir, ...entry } : null;
  }

  findWorktreesByPath(commonDir: string, checkoutPath: string): WorktreeRow[] {
    this.#check();
    const repo = this.#existingRepository(commonDir);
    if (!repo) return [];
    return Object.entries(repo.view.worktrees)
      .filter(([, entry]) => entry.checkoutPath === checkoutPath)
      .map(([worktreeId, entry]) => ({ worktreeId, commonDir, ...entry }))
      .sort((a, b) =>
        a.firstSeenAt === b.firstSeenAt
          ? a.worktreeId.localeCompare(b.worktreeId)
          : a.firstSeenAt < b.firstSeenAt
            ? -1
            : 1,
      );
  }

  setStartOverride(
    worktreeId: string,
    commit: string | null,
    setAt: string = storeTime(this.#now()),
  ): void {
    this.#check();
    const repo = this.#worktreeRepository(worktreeId);
    if (!repo?.view.worktrees[worktreeId]) {
      if (commit === null) return;
      throw new StoreError(`No worktree ${worktreeId} has been recorded.`);
    }
    if (commit === null && !(worktreeId in repo.view.startOverrides)) return;
    this.#checkWritable(repo);
    const base = repo.synced.startOverrides[worktreeId] ?? null;
    if (commit === null) {
      delete repo.view.startOverrides[worktreeId];
      repo.pending.overrides.set(worktreeId, { kind: "remove", at: setAt, base });
    } else {
      repo.view.startOverrides[worktreeId] = { commit, setAt };
      repo.pending.overrides.set(worktreeId, { kind: "set", override: { commit, setAt }, base });
    }
    this.#writeNow(repo);
  }

  getStartOverride(worktreeId: string): StartOverride | null {
    this.#check();
    const entry = this.#worktreeRepository(worktreeId)?.view.startOverrides[worktreeId];
    return entry ? { worktreeId, ...entry } : null;
  }

  getMarks(worktreeId: string): Mark[] {
    this.#check();
    const marks = this.#worktreeRepository(worktreeId)?.view.marks[worktreeId] ?? {};
    return Object.entries(marks)
      .map(([path, mark]) => ({ worktreeId, path, ...mark }))
      .sort((a, b) => compare(a.path, b.path));
  }

  setMarks(worktreeId: string, marks: readonly MarkInput[]): void {
    this.#check();
    if (marks.length === 0) return;
    const repo = this.#worktreeRepository(worktreeId);
    if (!repo?.view.worktrees[worktreeId]) {
      throw new StoreError(`No worktree ${worktreeId} has been recorded.`);
    }
    this.#checkWritable(repo);
    // Before the marks reach the file, so a process pruning meanwhile sees it in use.
    for (const mark of marks) {
      if (mark.snapshotHash !== null) this.#linkSnapshot(mark.snapshotHash);
    }
    const own = repo.view.marks[worktreeId] ?? {};
    for (const mark of marks) {
      const stored = {
        resultHash: mark.resultHash,
        viewedAt: mark.viewedAt,
        snapshotHash: mark.snapshotHash,
      };
      own[mark.path] = stored;
      repo.pending.setMark(worktreeId, mark.path, {
        kind: "set",
        mark: { ...stored },
        base: repo.synced.marks[worktreeId]?.[mark.path] ?? null,
      });
    }
    repo.view.marks[worktreeId] = own;
    this.#writeNow(repo);
  }

  deleteMarks(worktreeId: string, paths?: readonly string[]): void {
    this.#check();
    const repo = this.#worktreeRepository(worktreeId);
    const own = repo?.view.marks[worktreeId];
    if (!repo || !own) return;
    const targets = [...new Set(paths ?? Object.keys(own))].filter((path) =>
      Object.hasOwn(own, path),
    );
    if (targets.length === 0) return;
    this.#checkWritable(repo);
    const at = storeTime(this.#now());
    for (const path of targets) {
      delete own[path];
      repo.pending.setMark(worktreeId, path, {
        kind: "remove",
        at,
        base: repo.synced.marks[worktreeId]?.[path] ?? null,
      });
    }
    if (Object.keys(own).length === 0) delete repo.view.marks[worktreeId];
    this.#writeNow(repo);
  }

  putSnapshot(hash: string, bytes: Uint8Array): void {
    this.#check();
    const written = this.#snapshots.put(hash, bytes);
    if (written.modifiedMs !== null) this.#ownSnapshots.set(hash, written.modifiedMs);
  }

  getSnapshot(hash: string): Buffer | null {
    this.#check();
    return this.#snapshots.read(hash);
  }

  hasSnapshot(hash: string): boolean {
    this.#check();
    return this.#snapshots.has(hash);
  }

  snapshotUsage(): SnapshotUsage {
    this.#check();
    const files = this.#snapshots.list();
    return { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  }

  deleteUnreferencedSnapshots(): number {
    this.#check();
    this.#discover();
    const referenced = this.#referencedSnapshots();
    let dropped = 0;
    for (const file of this.#snapshots.list()) {
      if (referenced.has(file.hash) || !this.#mayDeleteSnapshot(file)) continue;
      if (this.#removeSnapshot(file)) dropped += 1;
    }
    return dropped;
  }

  pruneSnapshots(capBytes: number): number {
    this.#check();
    this.#discover();
    const files = this.#snapshots.list();
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    if (bytes <= capBytes) return 0;
    const byHash = new Map(files.map((file) => [file.hash, file]));
    const newestUse = new Map<string, string>();
    for (const document of this.#documentsWithPending()) {
      for (const marks of Object.values(document.marks)) {
        for (const mark of Object.values(marks)) {
          if (mark.snapshotHash === null || !byHash.has(mark.snapshotHash)) continue;
          const seen = newestUse.get(mark.snapshotHash);
          newestUse.set(mark.snapshotHash, seen ? laterTime(seen, mark.viewedAt) : mark.viewedAt);
        }
      }
    }
    const unreferenced = files.filter((file) => !newestUse.has(file.hash));
    // A snapshot is as old as the newest mark still using it.
    const byOldestMark = [...newestUse]
      .sort(([a, at], [b, bt]) => (at === bt ? compare(a, b) : compare(at, bt)))
      .flatMap(([hash]) => byHash.get(hash) ?? []);
    let dropped = 0;
    for (const file of [...unreferenced, ...byOldestMark]) {
      if (bytes <= capBytes) break;
      if (!this.#mayDeleteSnapshot(file) || !this.#removeSnapshot(file)) continue;
      if (newestUse.has(file.hash)) this.#unlinkSnapshot(file.hash);
      bytes -= file.size;
      dropped += 1;
    }
    return dropped;
  }

  listStaleWorktrees(
    commonDir: string,
    seenPaths: ReadonlySet<string>,
    olderThan: string,
  ): WorktreeRow[] {
    this.#check();
    const repo = this.#existingRepository(commonDir);
    if (!repo) return [];
    return Object.entries(repo.view.worktrees)
      .filter(([, entry]) => entry.lastSeenAt < olderThan && !seenPaths.has(entry.checkoutPath))
      .map(([worktreeId, entry]) => ({ worktreeId, commonDir, ...entry }))
      .sort((a, b) =>
        a.lastSeenAt === b.lastSeenAt
          ? compare(a.worktreeId, b.worktreeId)
          : compare(a.lastSeenAt, b.lastSeenAt),
      );
  }

  deleteWorktree(worktreeId: string): void {
    this.#check();
    // Not read again first: the delete is guarded by the worktree as this process last read
    // it, when it judged it stale (`listStaleWorktrees`), so anyone touching it since then
    // keeps it.
    let repo = this.#byWorktree.get(worktreeId);
    if (!repo) {
      this.#discover();
      repo = this.#byWorktree.get(worktreeId);
    }
    if (!repo) return;
    const { view } = repo;
    const held =
      worktreeId in view.worktrees || worktreeId in view.startOverrides || worktreeId in view.marks;
    // A repository a newer Treepeek writes is that version's to prune.
    if (!held || repo.readOnly) return;
    const snapshots = new Set<string>();
    for (const document of [repo.synced, view]) {
      for (const mark of Object.values(document.marks[worktreeId] ?? {})) {
        if (mark.snapshotHash !== null) snapshots.add(mark.snapshotHash);
      }
    }
    repo.pending.forgetWorktree(worktreeId);
    repo.pending.deletes.set(worktreeId, { base: worktreeState(repo.synced, worktreeId) });
    delete view.worktrees[worktreeId];
    delete view.startOverrides[worktreeId];
    delete view.marks[worktreeId];
    this.#writeNow(repo);
    if (snapshots.size === 0) return;
    this.#discover();
    const referenced = this.#referencedSnapshots();
    for (const file of this.#snapshots.list()) {
      if (!snapshots.has(file.hash) || referenced.has(file.hash)) continue;
      if (this.#mayDeleteSnapshot(file)) this.#removeSnapshot(file);
    }
  }

  clearReviewData(): void {
    this.#check();
    this.#discover();
    const at = storeTime(this.#now());
    for (const repo of this.#repositories.values()) {
      const { view } = repo;
      if (repo.readOnly || Object.keys(view.marks).length === 0) continue;
      for (const [worktreeId, marks] of Object.entries(view.marks)) {
        for (const path of Object.keys(marks)) {
          repo.pending.setMark(worktreeId, path, {
            kind: "remove",
            at,
            base: repo.synced.marks[worktreeId]?.[path] ?? null,
          });
        }
      }
      view.marks = {};
      this.#writeNow(repo);
    }
    this.#discover();
    const referenced = this.#referencedSnapshots();
    for (const file of this.#snapshots.list()) {
      if (!referenced.has(file.hash) && this.#mayDeleteSnapshot(file)) this.#removeSnapshot(file);
    }
  }

  /**
   * Writes every changed document now. Throws a `StoreError` when one could not be
   * written; its changes stay pending and are tried again later.
   */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const failed = [...this.#repositories.values()].filter((repo) => !this.#tryWrite(repo));
    if (failed.length > 0) {
      this.#retryLater();
      throw new StoreError(
        `Could not write ${failed.map((repo) => repo.name).join(", ")}; the changes stay pending.`,
      );
    }
    this.#retryDelayMs = RETRY_DELAY_MS;
  }

  close(): void {
    if (!this.#open) return;
    let failure: unknown = null;
    try {
      this.flush();
    } catch (error) {
      failure = error;
    }
    this.#open = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (failure !== null) throw failure;
  }

  #check(): void {
    if (!this.#open) throw new StoreError("The store is closed.");
  }

  #checkWritable(repo: Repository): void {
    if (repo.readOnly) {
      throw new StoreError(
        `${repo.name} was written by a newer Treepeek; this one does not change it.`,
      );
    }
  }

  // Finding documents

  /** The repository of `commonDir`, read again if its file changed; created when new. */
  #repository(commonDir: string): Repository {
    const repo =
      this.#repositories.get(commonDir) ??
      this.#addRepository(commonDir, migrateDocument({ schemaVersion: 0, commonDir }), null);
    this.#sync(repo);
    return repo;
  }

  /** The repository of `commonDir` when this process or another has a file for it. */
  #existingRepository(commonDir: string): Repository | undefined {
    const known = this.#repositories.get(commonDir);
    if (known) {
      this.#sync(known);
      return known;
    }
    if (statStamp(join(this.dir, repositoryFileName(commonDir))) === null) return undefined;
    return this.#repository(commonDir);
  }

  /** The repository holding `worktreeId`, listing the folder again when it is not known. */
  #worktreeRepository(worktreeId: string): Repository | undefined {
    const known = this.#byWorktree.get(worktreeId);
    if (known) {
      this.#sync(known);
      return known;
    }
    this.#discover();
    return this.#byWorktree.get(worktreeId);
  }

  /** Reads every changed file again and picks up the files other processes created. */
  #discover(): void {
    for (const repo of this.#repositories.values()) this.#sync(repo);
    for (const name of readdirSync(this.dir)) {
      if (!FILE_NAME.test(name) || this.#names.has(name)) continue;
      const file = join(this.dir, name);
      const stamp = statStamp(file);
      if (stamp === null || this.#wasReported(name, stamp)) continue;
      const read = readRepositoryFile(file);
      if (read.kind === "missing") continue;
      if (read.kind === "document" && name === repositoryFileName(read.document.commonDir)) {
        this.#addRepository(read.document.commonDir, read.document, read.stamp);
        continue;
      }
      this.#report(name, read.stamp, {
        message:
          read.kind === "newer"
            ? "a newer Treepeek wrote a store file; this process leaves it alone"
            : "could not read a store file another process wrote",
        file,
        reason: read.kind === "unreadable" ? read.reason : undefined,
      });
    }
  }

  #addRepository(commonDir: string, synced: RepositoryDocument, stamp: Stamp | null): Repository {
    const name = repositoryFileName(commonDir);
    const repo: Repository = {
      commonDir,
      name,
      file: join(this.dir, name),
      synced,
      stamp,
      view: structuredClone(synced),
      pending: new PendingChanges(),
      readOnly: false,
      swept: false,
    };
    this.#repositories.set(commonDir, repo);
    this.#names.add(name);
    this.#index(repo);
    return repo;
  }

  #index(repo: Repository): void {
    for (const worktreeId of Object.keys(repo.view.worktrees)) {
      this.#byWorktree.set(worktreeId, repo);
    }
  }

  // Reading and writing files

  /** Reads the file again when another process replaced it, keeping this process's changes. */
  #sync(repo: Repository): void {
    if (repo.readOnly) return;
    const look = this.#look(repo);
    if (look.kind !== "changed") return;
    const merged = mergeDocument(look.document, repo.pending);
    repo.synced = look.document;
    repo.stamp = look.stamp;
    repo.view = merged.document;
    repo.pending = merged.pending;
    this.#index(repo);
  }

  /** The file against what this process last read or wrote. */
  #look(repo: Repository): Look {
    const stamp = statStamp(repo.file);
    if (sameStamp(stamp, repo.stamp)) return { kind: "same" };
    const read: FileRead = stamp === null ? { kind: "missing" } : readRepositoryFile(repo.file);
    switch (read.kind) {
      case "missing":
        return {
          kind: "changed",
          document: migrateDocument({ schemaVersion: 0, commonDir: repo.commonDir }),
          stamp: null,
        };
      case "newer":
        this.#makeReadOnly(repo, read.version, read.stamp);
        return { kind: "readOnly" };
      case "unreadable":
        return this.#keepLastCopy(repo, read.stamp, read.reason);
      case "document":
        if (read.document.commonDir !== repo.commonDir) {
          return this.#keepLastCopy(repo, read.stamp, "it belongs to another file name");
        }
        return { kind: "changed", document: read.document, stamp: read.stamp };
    }
  }

  /** A damaged file found after open: merged over from the last copy this process read. */
  #keepLastCopy(repo: Repository, stamp: Stamp, reason: string): Look {
    this.#report(repo.name, stamp, {
      message: "a store file another process wrote cannot be read; using the last copy read",
      file: repo.file,
      reason,
    });
    return { kind: "changed", document: repo.synced, stamp };
  }

  #makeReadOnly(repo: Repository, version: number, stamp: Stamp): void {
    repo.readOnly = true;
    repo.pending = new PendingChanges();
    this.#report(repo.name, stamp, {
      message: "a newer Treepeek wrote a store file; this process no longer writes it",
      file: repo.file,
      schemaVersion: version,
    });
  }

  /** Writes a repository's pending changes; never throws. Answers whether none are left. */
  #tryWrite(repo: Repository): boolean {
    try {
      if (this.#write(repo)) return true;
      this.#log?.warn("another process held a store file's lock; the changes stay pending", {
        file: repo.file,
      });
    } catch (error) {
      this.#log?.warn("could not write a store file; the changes stay pending", {
        file: repo.file,
        error,
      });
    }
    return false;
  }

  /** A user's change: written at once, or tried again later. */
  #writeNow(repo: Repository): void {
    if (!this.#tryWrite(repo)) this.#retryLater();
  }

  /** Answers `false` when the lock stayed held; throws when the file system fails. */
  #write(repo: Repository): boolean {
    if (repo.pending.isEmpty || repo.readOnly) return true;
    const lock = acquireFileLock(`${repo.file}.lock`, { timeoutMs: this.#lockTimeoutMs });
    if (!lock) return false;
    try {
      // No other writer is inside the lock, so its temporary files are a crashed one's.
      if (!repo.swept || lock.brokeStale) {
        this.#sweep(repo);
        repo.swept = true;
      }
      const look = this.#look(repo);
      if (look.kind === "readOnly") return true;
      const theirs = look.kind === "same" ? repo.synced : look.document;
      const { document } = mergeDocument(theirs, repo.pending);
      repo.stamp = writeAtomically(repo.file, document);
      repo.synced = document;
      repo.view = structuredClone(document);
      repo.pending = new PendingChanges();
      this.#index(repo);
      return true;
    } finally {
      lock.release();
    }
  }

  #sweep(repo: Repository): void {
    const prefix = `${repo.name}.`;
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        rmSync(join(this.dir, name), { force: true });
      }
    }
  }

  #schedule(delayMs: number): void {
    if (this.#timer || !this.#open) return;
    const timer = setTimeout(() => {
      this.#timer = null;
      try {
        this.flush();
      } catch {
        // Logged per file, and tried again later; a timer must never throw.
      }
    }, delayMs);
    timer.unref?.();
    this.#timer = timer;
  }

  #retryLater(): void {
    this.#schedule(Math.max(this.#flushDelayMs, this.#retryDelayMs));
    this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  }

  #loadAtOpen(name: string): void {
    const file = join(this.dir, name);
    const read = readRepositoryFile(file);
    switch (read.kind) {
      case "missing":
        return;
      case "newer":
        throw new StoreError(
          `${name} was written by a newer Treepeek (schema ${read.version}; this one knows ${SCHEMA_VERSION}).`,
        );
      case "unreadable":
        this.#setAside(file, read.reason, read.error);
        return;
      case "document":
        if (name !== repositoryFileName(read.document.commonDir)) {
          this.#setAside(file, "it belongs to another file name", null);
          return;
        }
        this.#addRepository(read.document.commonDir, read.document, read.stamp);
    }
  }

  #setAside(file: string, reason: string, error: unknown): void {
    const aside = `${file}.corrupt-${storeTime().replace(/[:]/g, "")}`;
    try {
      renameSync(file, aside);
    } catch {
      // Leave it where it is; it will be overwritten by the next write for that repository.
    }
    this.#log?.warn("set aside an unreadable store file", {
      file,
      aside,
      reason,
      error: error instanceof Error ? error.message : undefined,
    });
  }

  #wasReported(name: string, stamp: Stamp): boolean {
    return sameStamp(this.#reported.get(name) ?? null, stamp);
  }

  /** Logs a problem with one version of a file once. */
  #report(name: string, stamp: Stamp, data: { message: string } & Record<string, unknown>): void {
    if (this.#wasReported(name, stamp)) return;
    this.#reported.set(name, stamp);
    const { message, ...rest } = data;
    this.#log?.warn(message, rest);
  }

  // Snapshots

  /** Every repository's document as on disk and as this process sees it. */
  #documentsWithPending(): RepositoryDocument[] {
    return [...this.#repositories.values()].flatMap((repo) => [repo.synced, repo.view]);
  }

  /** Every snapshot some mark references, on disk or pending in this process. */
  #referencedSnapshots(): Set<string> {
    const referenced = new Set<string>();
    for (const document of this.#documentsWithPending()) {
      for (const marks of Object.values(document.marks)) {
        for (const mark of Object.values(marks)) {
          if (mark.snapshotHash !== null) referenced.add(mark.snapshotHash);
        }
      }
    }
    return referenced;
  }

  #mayDeleteSnapshot(file: SnapshotFile): boolean {
    if (this.#ownSnapshots.get(file.hash) === file.modifiedMs) return true;
    return Date.now() - file.modifiedMs >= SNAPSHOT_GRACE_MS;
  }

  /** Removes the file unless someone touched it since it was listed. */
  #removeSnapshot(file: SnapshotFile): boolean {
    const removed = this.#snapshots.remove(file.hash, file.modifiedMs);
    if (removed) this.#ownSnapshots.delete(file.hash);
    return removed;
  }

  #linkSnapshot(hash: string): void {
    let modifiedMs: number | null;
    try {
      modifiedMs = this.#snapshots.touch(hash);
    } catch (error) {
      this.#log?.warn("could not touch a snapshot", { hash, error });
      return;
    }
    if (modifiedMs !== null && this.#ownSnapshots.has(hash)) {
      this.#ownSnapshots.set(hash, modifiedMs);
    }
  }

  /** Every mark that references `hash` no longer does, unless it changed meanwhile. */
  #unlinkSnapshot(hash: string): void {
    for (const repo of this.#repositories.values()) {
      let changed = false;
      for (const [worktreeId, marks] of Object.entries(repo.view.marks)) {
        for (const [path, mark] of Object.entries(marks)) {
          if (mark.snapshotHash !== hash) continue;
          mark.snapshotHash = null;
          changed = true;
          if (repo.readOnly) continue;
          const pending = repo.pending.markChange(worktreeId, path);
          const base = repo.synced.marks[worktreeId]?.[path];
          let change: MarkChange | null = null;
          if (pending?.kind === "set") {
            change = { ...pending, mark: { ...pending.mark, snapshotHash: null } };
          } else if (base?.snapshotHash === hash) {
            change = { kind: "unlink", snapshotHash: hash, base };
          }
          if (change) repo.pending.setMark(worktreeId, path, change);
        }
      }
      if (changed && !repo.readOnly) this.#schedule(this.#flushDelayMs);
    }
  }
}

/** Reads and checks one repository file. */
function readRepositoryFile(file: string): FileRead {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }
  let stamp: Stamp;
  let text: string;
  try {
    stamp = stampOf(fstatSync(fd, { bigint: true }));
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: "unreadable", reason: "it is not valid JSON", error, stamp };
  }
  const version = isObject(raw) ? raw.schemaVersion : undefined;
  if (typeof version === "number" && version > SCHEMA_VERSION) {
    return { kind: "newer", version, stamp };
  }
  try {
    if (!isObject(raw)) throw new Error("not an object");
    return { kind: "document", document: migrateDocument(raw), stamp };
  } catch (error) {
    return { kind: "unreadable", reason: "its contents do not match the schema", error, stamp };
  }
}

/** Writes `document` to a temporary file, fsyncs it and renames it over `file`. */
function writeAtomically(file: string, document: RepositoryDocument): Stamp | null {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(document)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // The lock is held, so the file is still the one just renamed.
  return statStamp(file);
}

/** Brings a document to `SCHEMA_VERSION` and checks it; throws when it does not fit. */
function migrateDocument(document: JsonDocument): RepositoryDocument {
  const version = document.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new StoreError("The document has no schema version.");
  }
  for (const migration of pendingMigrations(version)) {
    migration.json(document);
    document.schemaVersion = migration.version;
  }
  return v.parse(DocumentSchema, document);
}

function statStamp(file: string): Stamp | null {
  try {
    return stampOf(statSync(file, { bigint: true }));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function stampOf(stats: BigIntStats): Stamp {
  return { ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

function sameStamp(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is JsonDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
