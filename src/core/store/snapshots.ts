import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
}

/**
 * The snapshot files (review-marks design, "Since you viewed"): one file per snapshot,
 * named by its `resultHash`, so the same content marked in two worktrees is kept once.
 * Both engines keep their bytes here; the SQLite engine also lists them in its `snapshot`
 * table, while the JSON engine's table is this folder.
 *
 * A file is written to a temporary name and renamed, so a snapshot is either whole or
 * absent.
 */
export class SnapshotFolder {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Whether the snapshot is there; `false` for a name no snapshot can have. */
  has(hash: string): boolean {
    return NAME.test(hash) && this.#stat(hash) !== null;
  }

  /** Writes the snapshot unless it is there already; answers its size on disk. */
  write(hash: string, bytes: Uint8Array): number {
    const file = this.#file(hash);
    const existing = this.#stat(hash);
    if (existing) return existing.size;
    const temporary = join(this.dir, `.${hash}.${process.pid}.tmp`);
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    return bytes.byteLength;
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

  remove(hash: string): void {
    rmSync(this.#file(hash), { force: true });
  }

  /** Every snapshot file, oldest first. Temporary files left by a crash are removed. */
  list(): SnapshotFile[] {
    const files: SnapshotFile[] = [];
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith(".tmp")) {
        rmSync(join(this.dir, name), { force: true });
        continue;
      }
      if (!NAME.test(name)) continue;
      const stats = this.#stat(name);
      if (stats) files.push({ hash: name, size: stats.size, createdAt: stats.createdAt });
    }
    return files.sort((a, b) =>
      a.createdAt === b.createdAt ? compare(a.hash, b.hash) : compare(a.createdAt, b.createdAt),
    );
  }

  /** Removes every snapshot file. */
  clear(): void {
    for (const name of readdirSync(this.dir)) {
      if (NAME.test(name) || name.endsWith(".tmp")) rmSync(join(this.dir, name), { force: true });
    }
  }

  #file(hash: string): string {
    if (!NAME.test(hash)) throw new StoreError(`"${hash.slice(0, 80)}" cannot name a snapshot.`);
    return join(this.dir, hash);
  }

  #stat(hash: string): { size: number; createdAt: string } | null {
    try {
      const stats = statSync(this.#file(hash));
      return stats.isFile() ? { size: stats.size, createdAt: storeTime(stats.mtime) } : null;
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
