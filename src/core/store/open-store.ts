import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../shared/log";
import { JsonReviewStore } from "./json-store";
import { type ReviewStore, type StoreEngine, StoreError } from "./review-store";
import { loadNodeSqlite, SqliteReviewStore } from "./sqlite-store";

/** The SQLite engine's database file, inside `userData/store/`. */
export const SQLITE_FILE = "review.sqlite";

export interface OpenStoreOptions {
  /** Forces an engine; by default SQLite when `node:sqlite` loads, JSON otherwise. */
  engine?: StoreEngine;
  log?: Logger;
}

/**
 * Opens the local store under `<userDataDir>/store/`, choosing the engine: SQLite when the
 * runtime has `node:sqlite` (p1000 confirmed the core service does), one JSON file per
 * repository otherwise. A SQLite database that exists but fails to open is an error, not a
 * reason to switch engines: switching would hide everything it holds.
 */
export function openReviewStore(userDataDir: string, options: OpenStoreOptions = {}): ReviewStore {
  const dir = join(userDataDir, "store");
  mkdirSync(dir, { recursive: true });
  const engine = options.engine ?? (loadNodeSqlite() ? "sqlite" : "json");
  if (engine === "sqlite") {
    if (!loadNodeSqlite()) throw new StoreError("node:sqlite is not available in this runtime.");
    return new SqliteReviewStore(join(dir, SQLITE_FILE));
  }
  options.log?.info("using the JSON store engine", { dir });
  return new JsonReviewStore(dir, options.log ? { log: options.log } : {});
}
