import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { pendingMigrations, SCHEMA_VERSION } from "./migrations";
import {
  type Mark,
  type MarkInput,
  type ReviewStore,
  type SnapshotUsage,
  type StartOverride,
  StoreError,
  storeTime,
  type WorktreeRow,
} from "./review-store";
import { SNAPSHOT_FOLDER, SnapshotFolder } from "./snapshots";

type SqliteModule = typeof import("node:sqlite");

let loaded: SqliteModule | null | undefined;

/**
 * `node:sqlite`, or `null` when this runtime does not have it. It is required lazily, so a
 * runtime without it falls back to the JSON engine instead of failing to load the core
 * service.
 */
export function loadNodeSqlite(): SqliteModule | null {
  if (loaded !== undefined) return loaded;
  try {
    const require = createRequire(import.meta.url);
    loaded = require("node:sqlite") as SqliteModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

type Row = Record<string, SQLOutputValue>;

export interface SqliteStoreOptions {
  /** Where snapshot files go. Default: `snapshots/` beside the database file. */
  snapshotsDir?: string;
}

/**
 * The store in one SQLite database (`userData/store/review.sqlite`), through Node's
 * built-in `node:sqlite`, which p1000 confirmed the core service has. The core service is
 * its only writer. Snapshot bytes live in files (`snapshots.ts`); the `snapshot` table
 * lists them, so usage and pruning are queries.
 */
export class SqliteReviewStore implements ReviewStore {
  readonly engine = "sqlite" as const;
  readonly #db: DatabaseSync;
  readonly #snapshots: SnapshotFolder;
  readonly #statements: {
    upsertWorktree: StatementSync;
    getWorktree: StatementSync;
    findWorktrees: StatementSync;
    staleWorktrees: StatementSync;
    deleteWorktree: StatementSync;
    setOverride: StatementSync;
    deleteOverride: StatementSync;
    getOverride: StatementSync;
    getMarks: StatementSync;
    setMark: StatementSync;
    deleteMark: StatementSync;
    deleteMarks: StatementSync;
    markSnapshots: StatementSync;
    putSnapshot: StatementSync;
    getSnapshot: StatementSync;
    deleteSnapshot: StatementSync;
    snapshotUsage: StatementSync;
    snapshotHashes: StatementSync;
    referenced: StatementSync;
    unreferenced: StatementSync;
    byOldestMark: StatementSync;
    unlinkSnapshot: StatementSync;
  };
  #open = true;

  /**
   * Opens (creating and migrating as needed) the database at `file`. `:memory:` works too,
   * with `snapshotsDir` given.
   */
  constructor(file: string, options: SqliteStoreOptions = {}) {
    const sqlite = loadNodeSqlite();
    if (!sqlite) throw new StoreError("node:sqlite is not available in this runtime.");
    this.#snapshots = new SnapshotFolder(
      options.snapshotsDir ?? join(dirname(file), SNAPSHOT_FOLDER),
    );
    this.#db = new sqlite.DatabaseSync(file);
    try {
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA synchronous = NORMAL");
      this.#db.exec("PRAGMA busy_timeout = 5000");
      migrate(this.#db);
      this.#statements = {
        upsertWorktree: this.#db.prepare(
          `INSERT INTO worktree (worktree_id, common_dir, checkout_path, start_commit,
             start_observed_at, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (worktree_id) DO UPDATE SET
             start_observed_at = coalesce(start_observed_at, excluded.start_observed_at),
             last_seen_at = max(last_seen_at, excluded.last_seen_at)`,
        ),
        getWorktree: this.#db.prepare("SELECT * FROM worktree WHERE worktree_id = ?"),
        findWorktrees: this.#db.prepare(
          `SELECT * FROM worktree WHERE common_dir = ? AND checkout_path = ?
           ORDER BY first_seen_at, worktree_id`,
        ),
        setOverride: this.#db.prepare(
          `INSERT INTO start_override (worktree_id, "commit", set_at) VALUES (?, ?, ?)
           ON CONFLICT (worktree_id) DO UPDATE SET "commit" = excluded."commit",
             set_at = excluded.set_at`,
        ),
        deleteOverride: this.#db.prepare("DELETE FROM start_override WHERE worktree_id = ?"),
        getOverride: this.#db.prepare(`SELECT * FROM start_override WHERE worktree_id = ?`),
        staleWorktrees: this.#db.prepare(
          `SELECT * FROM worktree WHERE common_dir = ? AND last_seen_at < ?
           ORDER BY last_seen_at, worktree_id`,
        ),
        deleteWorktree: this.#db.prepare("DELETE FROM worktree WHERE worktree_id = ?"),
        getMarks: this.#db.prepare("SELECT * FROM mark WHERE worktree_id = ? ORDER BY path"),
        setMark: this.#db.prepare(
          `INSERT INTO mark (worktree_id, path, result_hash, viewed_at, snapshot_hash)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (worktree_id, path) DO UPDATE SET result_hash = excluded.result_hash,
             viewed_at = excluded.viewed_at, snapshot_hash = excluded.snapshot_hash`,
        ),
        deleteMark: this.#db.prepare("DELETE FROM mark WHERE worktree_id = ? AND path = ?"),
        deleteMarks: this.#db.prepare("DELETE FROM mark WHERE worktree_id = ?"),
        markSnapshots: this.#db.prepare(
          `SELECT DISTINCT snapshot_hash FROM mark
           WHERE worktree_id = ? AND snapshot_hash IS NOT NULL`,
        ),
        putSnapshot: this.#db.prepare(
          `INSERT INTO snapshot (hash, size, created_at) VALUES (?, ?, ?)
           ON CONFLICT (hash) DO NOTHING`,
        ),
        getSnapshot: this.#db.prepare("SELECT * FROM snapshot WHERE hash = ?"),
        deleteSnapshot: this.#db.prepare("DELETE FROM snapshot WHERE hash = ?"),
        snapshotUsage: this.#db.prepare(
          "SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM snapshot",
        ),
        snapshotHashes: this.#db.prepare("SELECT hash FROM snapshot"),
        referenced: this.#db.prepare("SELECT 1 AS one FROM mark WHERE snapshot_hash = ? LIMIT 1"),
        unreferenced: this.#db.prepare(
          `SELECT hash, size FROM snapshot AS s
           WHERE NOT EXISTS (SELECT 1 FROM mark AS m WHERE m.snapshot_hash = s.hash)
           ORDER BY created_at, hash`,
        ),
        // A snapshot is as old as the newest mark still using it.
        byOldestMark: this.#db.prepare(
          `SELECT s.hash AS hash, s.size AS size FROM snapshot AS s
           JOIN mark AS m ON m.snapshot_hash = s.hash
           GROUP BY s.hash ORDER BY max(m.viewed_at), s.hash`,
        ),
        unlinkSnapshot: this.#db.prepare(
          "UPDATE mark SET snapshot_hash = NULL WHERE snapshot_hash = ?",
        ),
      };
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  upsertWorktree(row: WorktreeRow): void {
    this.#check();
    this.#statements.upsertWorktree.run(
      row.worktreeId,
      row.commonDir,
      row.checkoutPath,
      row.startCommit,
      row.startObservedAt,
      row.firstSeenAt,
      row.lastSeenAt,
    );
  }

  getWorktree(worktreeId: string): WorktreeRow | null {
    this.#check();
    const row = this.#statements.getWorktree.get(worktreeId);
    return row ? toWorktree(row) : null;
  }

  findWorktreesByPath(commonDir: string, checkoutPath: string): WorktreeRow[] {
    this.#check();
    return this.#statements.findWorktrees.all(commonDir, checkoutPath).map(toWorktree);
  }

  setStartOverride(worktreeId: string, commit: string | null, setAt: string = storeTime()): void {
    this.#check();
    if (commit === null) {
      this.#statements.deleteOverride.run(worktreeId);
      return;
    }
    if (!this.#statements.getWorktree.get(worktreeId)) throw unknownWorktree(worktreeId);
    this.#statements.setOverride.run(worktreeId, commit, setAt);
  }

  getStartOverride(worktreeId: string): StartOverride | null {
    this.#check();
    const row = this.#statements.getOverride.get(worktreeId);
    if (!row) return null;
    return {
      worktreeId: text(row, "worktree_id"),
      commit: text(row, "commit"),
      setAt: text(row, "set_at"),
    };
  }

  getMarks(worktreeId: string): Mark[] {
    this.#check();
    return this.#statements.getMarks.all(worktreeId).map(toMark);
  }

  setMarks(worktreeId: string, marks: readonly MarkInput[]): void {
    this.#check();
    if (marks.length === 0) return;
    if (!this.#statements.getWorktree.get(worktreeId)) throw unknownWorktree(worktreeId);
    this.#transaction(() => {
      for (const mark of marks) {
        this.#statements.setMark.run(
          worktreeId,
          mark.path,
          mark.resultHash,
          mark.viewedAt,
          mark.snapshotHash,
        );
      }
    });
  }

  deleteMarks(worktreeId: string, paths?: readonly string[]): void {
    this.#check();
    if (paths === undefined) {
      this.#statements.deleteMarks.run(worktreeId);
      return;
    }
    this.#transaction(() => {
      for (const path of paths) this.#statements.deleteMark.run(worktreeId, path);
    });
  }

  putSnapshot(hash: string, bytes: Uint8Array): void {
    this.#check();
    const size = this.#snapshots.write(hash, bytes);
    this.#statements.putSnapshot.run(hash, size, storeTime());
  }

  getSnapshot(hash: string): Buffer | null {
    this.#check();
    if (!this.#statements.getSnapshot.get(hash)) return null;
    const bytes = this.#snapshots.read(hash);
    // The file went missing behind the store's back: forget the row too.
    if (bytes === null) this.#statements.deleteSnapshot.run(hash);
    return bytes;
  }

  snapshotUsage(): SnapshotUsage {
    this.#check();
    const row = this.#statements.snapshotUsage.get();
    return { count: count(row, "count"), bytes: count(row, "bytes") };
  }

  deleteUnreferencedSnapshots(): number {
    this.#check();
    const listed = new Set(this.#statements.snapshotHashes.all().map((row) => text(row, "hash")));
    // A file whose row was never written (a crash in between) is not kept either.
    for (const file of this.#snapshots.list()) {
      if (!listed.has(file.hash)) this.#snapshots.remove(file.hash);
    }
    const unreferenced = this.#statements.unreferenced.all().map((row) => text(row, "hash"));
    for (const hash of unreferenced) this.#dropSnapshot(hash);
    return unreferenced.length;
  }

  pruneSnapshots(capBytes: number): number {
    this.#check();
    let { bytes } = this.snapshotUsage();
    let dropped = 0;
    for (const statement of [this.#statements.unreferenced, this.#statements.byOldestMark]) {
      if (bytes <= capBytes) break;
      for (const row of statement.all()) {
        if (bytes <= capBytes) break;
        const hash = text(row, "hash");
        this.#transaction(() => {
          this.#statements.unlinkSnapshot.run(hash);
          this.#dropSnapshot(hash);
        });
        bytes -= count(row, "size");
        dropped += 1;
      }
    }
    return dropped;
  }

  listStaleWorktrees(
    commonDir: string,
    seenPaths: ReadonlySet<string>,
    olderThan: string,
  ): WorktreeRow[] {
    this.#check();
    return this.#statements.staleWorktrees
      .all(commonDir, olderThan)
      .map(toWorktree)
      .filter((row) => !seenPaths.has(row.checkoutPath));
  }

  deleteWorktree(worktreeId: string): void {
    this.#check();
    const snapshots = this.#statements.markSnapshots
      .all(worktreeId)
      .map((row) => text(row, "snapshot_hash"));
    this.#transaction(() => {
      this.#statements.deleteMarks.run(worktreeId);
      this.#statements.deleteOverride.run(worktreeId);
      this.#statements.deleteWorktree.run(worktreeId);
    });
    for (const hash of snapshots) {
      if (!this.#statements.referenced.get(hash)) this.#dropSnapshot(hash);
    }
  }

  clearReviewData(): void {
    this.#check();
    this.#transaction(() => {
      this.#db.exec("DELETE FROM mark");
      this.#db.exec("DELETE FROM snapshot");
    });
    this.#snapshots.clear();
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#db.close();
  }

  /** The row goes first: a file without a row is never served, and is removed later. */
  #dropSnapshot(hash: string): void {
    this.#statements.deleteSnapshot.run(hash);
    this.#snapshots.remove(hash);
  }

  #transaction(run: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #check(): void {
    if (!this.#open) throw new StoreError("The store is closed.");
  }
}

/** Runs the migrations this database still needs, each in its own transaction. */
function migrate(db: DatabaseSync): void {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new StoreError(
      `The store was written by a newer Treepeek (schema ${version}; this one knows ${SCHEMA_VERSION}).`,
    );
  }
  for (const migration of pendingMigrations(version)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.sqlite) db.exec(statement);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(String(migration.version));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new StoreError(`Store migration ${migration.version} failed.`, { cause: error });
    }
  }
}

function schemaVersion(db: DatabaseSync): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!table) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) return 0;
  const value = Number(text(row, "value"));
  if (!Number.isInteger(value) || value < 0)
    throw new StoreError("The store's schema version is unreadable.");
  return value;
}

function toWorktree(row: Row): WorktreeRow {
  return {
    worktreeId: text(row, "worktree_id"),
    commonDir: text(row, "common_dir"),
    checkoutPath: text(row, "checkout_path"),
    startCommit: textOrNull(row, "start_commit"),
    startObservedAt: textOrNull(row, "start_observed_at"),
    firstSeenAt: text(row, "first_seen_at"),
    lastSeenAt: text(row, "last_seen_at"),
  };
}

function toMark(row: Row): Mark {
  return {
    worktreeId: text(row, "worktree_id"),
    path: text(row, "path"),
    resultHash: text(row, "result_hash"),
    viewedAt: text(row, "viewed_at"),
    snapshotHash: textOrNull(row, "snapshot_hash"),
  };
}

function count(row: Row | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new StoreError(`Column ${column} is not a number.`);
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new StoreError(`Column ${column} is not text.`);
  return value;
}

function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string") throw new StoreError(`Column ${column} is not text.`);
  return value;
}

function unknownWorktree(worktreeId: string): StoreError {
  return new StoreError(`No worktree ${worktreeId} has been recorded.`);
}
