import type { SqliteProbe } from "../shared/ipc";
import { loadNodeSqlite } from "./store/sqlite-store";

/**
 * Checks whether `node:sqlite` works in this process. Review marks prefer it and fall back
 * to JSON files per repository when it is missing (review-marks design).
 *
 * The module is loaded lazily (`loadNodeSqlite`), so a runtime without it reports
 * `available: false` instead of failing to load the core service.
 */
export function probeSqlite(): SqliteProbe {
  try {
    const sqlite = loadNodeSqlite();
    if (!sqlite) {
      return { available: false, error: "node:sqlite is not available in this runtime." };
    }
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      const row = db.prepare("select sqlite_version() as version").get() as
        | { version?: unknown }
        | undefined;
      const version = typeof row?.version === "string" ? row.version : undefined;
      return version === undefined ? { available: true } : { available: true, version };
    } finally {
      db.close();
    }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
