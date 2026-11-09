/**
 * The store's schema versions. Each migration carries the same change for both engines:
 * SQL for the SQLite database, and a function for each repository's JSON document. Both
 * engines record the version they reached in `meta` and run the missing migrations on
 * open; a store written by a newer version is refused rather than rewritten.
 */

/** A JSON engine document before it is checked: whatever the file held. */
export type JsonDocument = Record<string, unknown>;

export interface Migration {
  readonly version: number;
  readonly summary: string;
  /** Statements run in one transaction on the SQLite engine. */
  readonly sqlite: readonly string[];
  /** The same change for one repository's JSON document. */
  readonly json: (document: JsonDocument) => void;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    summary: "worktree identities, start overrides and the schema version",
    sqlite: [
      `CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT, WITHOUT ROWID`,
      `CREATE TABLE worktree (
        worktree_id TEXT PRIMARY KEY,
        common_dir TEXT NOT NULL,
        checkout_path TEXT NOT NULL,
        start_commit TEXT,
        start_observed_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT`,
      "CREATE INDEX worktree_by_path ON worktree (common_dir, checkout_path)",
      `CREATE TABLE start_override (
        worktree_id TEXT PRIMARY KEY,
        "commit" TEXT NOT NULL,
        set_at TEXT NOT NULL
      ) STRICT`,
    ],
    json: (document) => {
      document.worktrees = {};
      document.startOverrides = {};
    },
  },
]);

/** The version a store reaches after every migration. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (latest, migration) => Math.max(latest, migration.version),
  0,
);

/** The migrations a store at `version` still needs, in order. */
export function pendingMigrations(version: number): Migration[] {
  return MIGRATIONS.filter((migration) => migration.version > version).sort(
    (a, b) => a.version - b.version,
  );
}
