import { createRequire } from "node:module";
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { pendingMigrations, SCHEMA_VERSION } from "./migrations";
import {
  type ReviewStore,
  type StartOverride,
  StoreError,
  storeTime,
  type WorktreeRow,
} from "./review-store";

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

/**
 * The store in one SQLite database (`userData/store/review.sqlite`), through Node's
 * built-in `node:sqlite`, which p1000 confirmed the core service has. The core service is
 * its only writer.
 */
export class SqliteReviewStore implements ReviewStore {
  readonly engine = "sqlite" as const;
  readonly #db: DatabaseSync;
  readonly #statements: {
    upsertWorktree: StatementSync;
    getWorktree: StatementSync;
    findWorktrees: StatementSync;
    setOverride: StatementSync;
    deleteOverride: StatementSync;
    getOverride: StatementSync;
  };
  #open = true;

  /** Opens (creating and migrating as needed) the database at `file`; `:memory:` works too. */
  constructor(file: string) {
    const sqlite = loadNodeSqlite();
    if (!sqlite) throw new StoreError("node:sqlite is not available in this runtime.");
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

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#db.close();
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
