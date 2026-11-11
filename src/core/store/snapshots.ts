import {
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
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { StoreError, storeTime } from "./review-store";

/** The folder snapshots live in, inside `userData/store/`. */
export const SNAPSHOT_FOLDER = "snapshots";

/**
 * A snapshot's name: the `resultHash` of the content it holds, which for a file is an
 * object id (40 or 64 hex digits). Nothing else is ever a file name here.
 */
const NAME = /^[0-9a-f]{40,64}$/;

/** Whether `hash` can name a snapshot. */
export function isSnapshotHash(hash: string): boolean {
  return NAME.test(hash);
}

/** One snapshot file as the folder lists it. */
export interface SnapshotFile {
  hash: string;
  size: number;
  /** When the file was written, as a store time. */
  createdAt: string;
  /** The file's modification time in milliseconds, as precisely as the file system keeps it. */
  modifiedMs: number;
}

/** What `put` did. */
export interface SnapshotWrite {
  /** The snapshot's size on disk. */
  size: number;
  /** The modification time this call gave the file, or `null` when it was there already. */
  modifiedMs: number | null;
}

export interface SnapshotFolderOptions {
  /**
   * Temporary files younger than this are left alone by `list` and `clear`: another
   * process sharing the folder may be writing them. Without it every temporary file is
   * removed, which is right only when this process is the folder's one writer.
   */
  temporaryMinAgeMs?: number;
}

/**
 * The snapshot files (review-marks design, "Since you viewed"): one file per snapshot,
 * named by its `resultHash`, so the same content marked in two worktrees is kept once.
 * Both engines keep their bytes here; the SQLite engine also lists them in its `snapshot`
 * table, while the JSON engine's table is this folder.
 *
 * A file is written to a temporary name and renamed, so a snapshot is either whole or
 * absent. Several processes may share the folder: a file's modification time says when it
 * was last written or linked to a mark (`touch`), which the JSON engine uses to leave other
 * processes' fresh snapshots alone.
 */
export class SnapshotFolder {
  readonly dir: string;
  readonly #temporaryMinAgeMs: number;

  constructor(dir: string, options: SnapshotFolderOptions = {}) {
    this.dir = dir;
    this.#temporaryMinAgeMs = options.temporaryMinAgeMs ?? 0;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Whether the snapshot is there; `false` for a name no snapshot can have. */
  has(hash: string): boolean {
    return NAME.test(hash) && this.#stat(hash) !== null;
  }

  /** Writes the snapshot unless it is there already; answers its size on disk. */
  write(hash: string, bytes: Uint8Array): number {
    return this.put(hash, bytes).size;
  }

  /** `write`, also saying whether this call wrote the file and the time it gave it. */
  put(hash: string, bytes: Uint8Array): SnapshotWrite {
    const file = this.#file(hash);
    const existing = this.#stat(hash);
    if (existing) return { size: existing.size, modifiedMs: null };
    const temporary = join(this.dir, `.${hash}.${process.pid}.tmp`);
    const fd = openSync(temporary, "w", 0o600);
    let modifiedMs: number;
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
      modifiedMs = fstatSync(fd).mtimeMs;
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    return { size: bytes.byteLength, modifiedMs };
  }

  /**
   * Marks the snapshot as just used by setting its modification time to now, so a process
   * sharing the folder sees it as recent. Answers the new time, or `null` when the snapshot
   * is not there or `hash` cannot name one.
   */
  touch(hash: string): number | null {
    if (!NAME.test(hash)) return null;
    const file = this.#file(hash);
    const now = new Date();
    try {
      utimesSync(file, now, now);
      return statSync(file).mtimeMs;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** The snapshot's bytes, or `null` when it is not there or `hash` cannot name one. */
  read(hash: string): Buffer | null {
    if (!NAME.test(hash)) return null;
    try {
      return readFileSync(this.#file(hash));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * Removes the snapshot. With `ifModifiedMs`, only while its modification time is still
   * that one, so a snapshot another process used meanwhile stays. Answers whether it went.
   */
  remove(hash: string, ifModifiedMs?: number): boolean {
    const file = this.#file(hash);
    if (ifModifiedMs !== undefined && this.#stat(hash)?.modifiedMs !== ifModifiedMs) return false;
    rmSync(file, { force: true });
    return true;
  }

  /**
   * Every snapshot file, oldest first. Temporary files left by a crash are removed (only
   * old ones, with `temporaryMinAgeMs`).
   */
  list(): SnapshotFile[] {
    const files: SnapshotFile[] = [];
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith(".tmp")) {
        this.#removeTemporary(name);
        continue;
      }
      if (!NAME.test(name)) continue;
      const stats = this.#stat(name);
      if (stats) files.push({ hash: name, ...stats });
    }
    return files.sort((a, b) =>
      a.createdAt === b.createdAt ? compare(a.hash, b.hash) : compare(a.createdAt, b.createdAt),
    );
  }

  /** Removes every snapshot file, and temporary files as `list` does. */
  clear(): void {
    for (const name of readdirSync(this.dir)) {
      if (NAME.test(name)) rmSync(join(this.dir, name), { force: true });
      else if (name.endsWith(".tmp")) this.#removeTemporary(name);
    }
  }

  #removeTemporary(name: string): void {
    const file = join(this.dir, name);
    if (this.#temporaryMinAgeMs > 0) {
      try {
        if (Date.now() - statSync(file).mtimeMs < this.#temporaryMinAgeMs) return;
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    }
    rmSync(file, { force: true });
  }

  #file(hash: string): string {
    if (!NAME.test(hash)) throw new StoreError(`"${hash.slice(0, 80)}" cannot name a snapshot.`);
    return join(this.dir, hash);
  }

  #stat(hash: string): { size: number; createdAt: string; modifiedMs: number } | null {
    try {
      const stats = statSync(this.#file(hash));
      return stats.isFile()
        ? { size: stats.size, createdAt: storeTime(stats.mtime), modifiedMs: stats.mtimeMs }
        : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
