import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeSqlite } from "../../../../src/core/probe-sqlite";
import { worktreeId } from "../../../../src/core/store/identity";
import {
  JSON_FLUSH_DELAY_MS,
  JsonReviewStore,
  repositoryFileName,
} from "../../../../src/core/store/json-store";
import {
  MIGRATIONS,
  pendingMigrations,
  SCHEMA_VERSION,
} from "../../../../src/core/store/migrations";
import { SQLITE_FILE } from "../../../../src/core/store/open-store";
import { StoreError, storeTime, type WorktreeRow } from "../../../../src/core/store/review-store";
import { loadNodeSqlite, SqliteReviewStore } from "../../../../src/core/store/sqlite-store";
import type { Logger } from "../../../../src/shared/log";

const sqliteAvailable = probeSqlite().available;
const COMMON = "/repos/app/.git";

function row(checkoutPath: string, startCommit: string | null = "a".repeat(40)): WorktreeRow {
  return {
    worktreeId: worktreeId(COMMON, checkoutPath, startCommit),
    commonDir: COMMON,
    checkoutPath,
    startCommit,
    startObservedAt: startCommit ? "2025-01-01T00:00:00Z" : null,
    firstSeenAt: "2025-02-01T00:00:00Z",
    lastSeenAt: "2025-02-01T00:00:00Z",
  };
}

/** A logger that keeps the messages of its warnings and prints nothing. */
function silentLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger & { warnings: string[] } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
    child: () => log,
  };
  return log;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-engines-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("version 1 creates worktree, start_override and meta; version 2 mark and snapshot", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2]);
    expect(SCHEMA_VERSION).toBe(2);
    const first = MIGRATIONS[0]?.sqlite.join("\n") ?? "";
    for (const table of ["meta", "worktree", "start_override"]) {
      expect(first).toContain(`CREATE TABLE ${table} `);
    }
    const second = MIGRATIONS[1]?.sqlite.join("\n") ?? "";
    for (const table of ["mark", "snapshot"]) expect(second).toContain(`CREATE TABLE ${table} `);
    expect(pendingMigrations(0).map((migration) => migration.version)).toEqual([1, 2]);
    expect(pendingMigrations(1).map((migration) => migration.version)).toEqual([2]);
    expect(pendingMigrations(SCHEMA_VERSION)).toEqual([]);
  });
});

describe.runIf(sqliteAvailable)("SqliteReviewStore", () => {
  const file = () => join(dir, SQLITE_FILE);

  it("records the schema version in meta", () => {
    new SqliteReviewStore(file()).close();
    const sqlite = loadNodeSqlite();
    if (!sqlite) throw new Error("node:sqlite vanished");
    const db = new sqlite.DatabaseSync(file());
    try {
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((entry) => entry.name);
      expect(tables).toEqual(["mark", "meta", "snapshot", "start_override", "worktree"]);
    } finally {
      db.close();
    }
  });

  it("opens an already migrated database without migrating again", () => {
    const first = new SqliteReviewStore(file());
    first.upsertWorktree(row("/repos/a"));
    first.close();
    const second = new SqliteReviewStore(file());
    expect(second.getWorktree(row("/repos/a").worktreeId)).toEqual(row("/repos/a"));
    second.close();
  });

  it("upgrades a version-1 database, keeping its worktrees and overrides", () => {
    const sqlite = loadNodeSqlite();
    if (!sqlite) throw new Error("node:sqlite vanished");
    const db = new sqlite.DatabaseSync(file());
    for (const statement of MIGRATIONS[0]?.sqlite ?? []) db.exec(statement);
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    const kept = row("/repos/a");
    db.prepare(
      `INSERT INTO worktree (worktree_id, common_dir, checkout_path, start_commit,
         start_observed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      kept.worktreeId,
      kept.commonDir,
      kept.checkoutPath,
      kept.startCommit,
      kept.startObservedAt,
      kept.firstSeenAt,
      kept.lastSeenAt,
    );
    db.prepare(`INSERT INTO start_override (worktree_id, "commit", set_at) VALUES (?, ?, ?)`).run(
      kept.worktreeId,
      "b".repeat(40),
      "2025-06-01T00:00:00Z",
    );
    db.close();

    const store = new SqliteReviewStore(file());
    try {
      expect(store.getWorktree(kept.worktreeId)).toEqual(kept);
      expect(store.getStartOverride(kept.worktreeId)?.commit).toBe("b".repeat(40));
      store.setMarks(kept.worktreeId, [
        {
          path: "a.txt",
          resultHash: "c".repeat(40),
          viewedAt: "2025-07-01T00:00:00Z",
          snapshotHash: null,
        },
      ]);
      expect(store.getMarks(kept.worktreeId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("refuses a database written by a newer schema, and leaves it untouched", () => {
    new SqliteReviewStore(file()).close();
    const sqlite = loadNodeSqlite();
    if (!sqlite) throw new Error("node:sqlite vanished");
    const db = new sqlite.DatabaseSync(file());
    db.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    db.close();
    expect(() => new SqliteReviewStore(file())).toThrow(StoreError);
    expect(() => new SqliteReviewStore(file())).toThrow(/newer Treepeek/);
  });
});

describe("JsonReviewStore", () => {
  it("keeps one file per repository, named by the SHA-256 of its common dir", () => {
    const store = new JsonReviewStore(dir);
    store.upsertWorktree(row("/repos/a"));
    store.upsertWorktree({ ...row("/repos/b"), commonDir: "/repos/svc.git" });
    store.close();
    expect(readdirSync(dir).sort()).toEqual(
      [repositoryFileName(COMMON), repositoryFileName("/repos/svc.git"), "snapshots"].sort(),
    );
    const saved = JSON.parse(readFileSync(join(dir, repositoryFileName(COMMON)), "utf8"));
    expect(saved).toMatchObject({ schemaVersion: SCHEMA_VERSION, commonDir: COMMON });
  });

  it("gathers writes for 250 ms, then writes them at once (fake timers)", () => {
    expect(JSON_FLUSH_DELAY_MS).toBe(250);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new JsonReviewStore(dir);
    const file = join(dir, repositoryFileName(COMMON));
    store.upsertWorktree(row("/repos/a"));
    store.upsertWorktree(row("/repos/b"));
    expect(existsSync(file)).toBe(false);
    vi.advanceTimersByTime(JSON_FLUSH_DELAY_MS - 1);
    expect(existsSync(file)).toBe(false);
    vi.advanceTimersByTime(1);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved.worktrees)).toHaveLength(2);
    store.close();
  });

  it("writes pending changes on close, leaving no temporary file", () => {
    const store = new JsonReviewStore(dir, { flushDelayMs: 60_000 });
    store.upsertWorktree(row("/repos/a"));
    store.setStartOverride(row("/repos/a").worktreeId, "b".repeat(40), "2025-06-01T00:00:00Z");
    store.close();
    expect(readdirSync(dir).sort()).toEqual([repositoryFileName(COMMON), "snapshots"].sort());
    const reopened = new JsonReviewStore(dir);
    expect(reopened.getStartOverride(row("/repos/a").worktreeId)?.commit).toBe("b".repeat(40));
    reopened.close();
  });

  it("sets a damaged file aside and starts that repository empty", () => {
    const name = repositoryFileName(COMMON);
    writeFileSync(join(dir, name), "{ not json");
    const log = silentLog();
    const store = new JsonReviewStore(dir, { log });
    expect(store.findWorktreesByPath(COMMON, "/repos/a")).toEqual([]);
    store.upsertWorktree(row("/repos/a"));
    store.close();
    const files = readdirSync(dir);
    expect(files).toContain(name);
    expect(files.some((file) => file.startsWith(`${name}.corrupt-`))).toBe(true);
    expect(log.warnings).toHaveLength(1);
  });

  it("sets aside a file whose contents do not match the schema", () => {
    const name = repositoryFileName(COMMON);
    writeFileSync(
      join(dir, name),
      JSON.stringify({
        schemaVersion: 1,
        commonDir: COMMON,
        worktrees: { x: { checkoutPath: 5 } },
      }),
    );
    const store = new JsonReviewStore(dir, { log: silentLog() });
    expect(store.getWorktree("x")).toBeNull();
    store.close();
    expect(readdirSync(dir).some((file) => file.startsWith(`${name}.corrupt-`))).toBe(true);
  });

  it("refuses to open over a file written by a newer schema, and leaves it untouched", () => {
    const name = repositoryFileName(COMMON);
    const content = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, commonDir: COMMON });
    writeFileSync(join(dir, name), content);
    expect(() => new JsonReviewStore(dir)).toThrow(/newer Treepeek/);
    expect(readFileSync(join(dir, name), "utf8")).toBe(content);
  });

  it("upgrades a version-1 document, keeping its worktrees and overrides", () => {
    const name = repositoryFileName(COMMON);
    const kept = row("/repos/a");
    writeFileSync(
      join(dir, name),
      JSON.stringify({
        schemaVersion: 1,
        commonDir: COMMON,
        worktrees: {
          [kept.worktreeId]: {
            checkoutPath: kept.checkoutPath,
            startCommit: kept.startCommit,
            startObservedAt: kept.startObservedAt,
            firstSeenAt: kept.firstSeenAt,
            lastSeenAt: kept.lastSeenAt,
          },
        },
        startOverrides: {
          [kept.worktreeId]: { commit: "b".repeat(40), setAt: "2025-06-01T00:00:00Z" },
        },
      }),
    );
    const store = new JsonReviewStore(dir);
    expect(store.getWorktree(kept.worktreeId)).toEqual(kept);
    expect(store.getStartOverride(kept.worktreeId)?.commit).toBe("b".repeat(40));
    store.setMarks(kept.worktreeId, [
      {
        path: "a.txt",
        resultHash: "c".repeat(40),
        viewedAt: "2025-07-01T00:00:00Z",
        snapshotHash: null,
      },
    ]);
    store.close();
    const saved = JSON.parse(readFileSync(join(dir, name), "utf8"));
    expect(saved.schemaVersion).toBe(2);
    expect(Object.keys(saved.worktrees)).toEqual([kept.worktreeId]);
    expect(saved.marks[kept.worktreeId]["a.txt"].resultHash).toBe("c".repeat(40));
  });

  it("migrates a version-0 document", () => {
    const name = repositoryFileName(COMMON);
    writeFileSync(join(dir, name), JSON.stringify({ schemaVersion: 0, commonDir: COMMON }));
    const store = new JsonReviewStore(dir);
    expect(store.findWorktreesByPath(COMMON, "/repos/a")).toEqual([]);
    store.upsertWorktree(row("/repos/a"));
    store.close();
    const saved = JSON.parse(readFileSync(join(dir, name), "utf8"));
    expect(saved.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("storeTime", () => {
  it("is ISO 8601 UTC to the second, so store times sort as text", () => {
    expect(storeTime(new Date("2026-11-09T08:54:36.789Z"))).toBe("2026-11-09T08:54:36Z");
  });
});
