import { createRequire } from "node:module";
import type { SqliteProbe } from "../shared/ipc";

/**
 * Checks whether `node:sqlite` works in this process. Review marks prefer it and fall back
 * to JSON files per repository when it is missing (review-marks design).
 *
 * The module is required lazily, so a runtime without it reports `available: false`
 * instead of failing to load the core service.
 */
export function probeSqlite(): SqliteProbe {
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
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
