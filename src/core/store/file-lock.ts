import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";

/** How long a second writer waits for the lock: SQLite's `busy_timeout` in the other engine. */
export const LOCK_TIMEOUT_MS = 5_000;

/**
 * A lock older than this is broken whoever holds it. The lock is held only while one file
 * is written, which takes milliseconds, so a lock this old was left by a holder that is
 * stuck or whose pid was reused after it died.
 */
export const LOCK_STALE_MS = 30_000;

/**
 * A lock file with no readable holder this old is broken too. The holder writes its pid
 * right after creating the file, so an empty lock is one whose holder died in between.
 */
export const LOCK_UNOWNED_STALE_MS = 2_000;

/** The longest single wait between two tries. */
const MAX_BACKOFF_MS = 50;

export interface FileLockOptions {
  /** How long to wait for another holder. Default `LOCK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** A lock older than this is broken. Default `LOCK_STALE_MS`. */
  staleMs?: number;
}

/** A lock this process holds. */
export interface FileLock {
  readonly path: string;
  /** Whether a stale lock was broken on the way: its holder may have left files behind. */
  readonly brokeStale: boolean;
  /** Removes the lock file, unless it is no longer this holder's. Safe to call twice. */
  release(): void;
}

interface Holder {
  pid: number;
  nonce: string;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Takes the lock at `path`, a file created with `O_EXCL` that holds the holder's pid, a
 * nonce and the time. A second taker retries with growing waits (`Atomics.wait`, so the
 * whole call stays synchronous) for up to `timeoutMs`, and answers `null` if the lock is
 * still held then. A lock whose holder is dead (`process.kill(pid, 0)` fails with
 * `ESRCH`), that names no holder once `LOCK_UNOWNED_STALE_MS` old, or that is older than
 * `staleMs`, is broken: renamed to a unique name, then removed, so two breakers cannot
 * both remove a fresh lock by name.
 *
 * Throws only for file system errors other than the lock being held.
 */
export function acquireFileLock(path: string, options: FileLockOptions = {}): FileLock | null {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const nonce = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;
  let backoff = 1;
  let brokeStale = false;
  for (;;) {
    if (tryCreate(path, nonce)) return heldLock(path, nonce, brokeStale);
    const outcome = breakIfStale(path, staleMs);
    if (outcome === "broken") brokeStale = true;
    if (outcome !== "held") continue;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    sleep(Math.min(left, backoff * (0.5 + Math.random())));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

function tryCreate(path: string, nonce: string): boolean {
  // Made before the file exists, so only the write itself stands between creating the
  // lock and naming its holder; a holder killed in between leaves a lock with no owner.
  const holder = Buffer.from(
    JSON.stringify({ pid: process.pid, nonce, time: new Date().toISOString() }),
  );
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, holder);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
  return true;
}

function heldLock(path: string, nonce: string, brokeStale: boolean): FileLock {
  let released = false;
  return {
    path,
    brokeStale,
    release() {
      if (released) return;
      released = true;
      // A lock broken as stale and taken by another writer is that writer's now.
      if (readHolder(path)?.nonce === nonce) rmSync(path, { force: true });
    },
  };
}

/**
 * Breaks the lock at `path` when it is stale. Answers `gone` when there was no lock to
 * break (it was released meanwhile), `broken` when it was broken, `held` otherwise.
 */
function breakIfStale(path: string, staleMs: number): "gone" | "broken" | "held" {
  const lock = inspect(path);
  if (!lock) return "gone";
  const stale =
    lock.age > staleMs ||
    (lock.holder ? !isAlive(lock.holder.pid) : lock.age > LOCK_UNOWNED_STALE_MS);
  if (!stale) return "held";
  const aside = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return "gone";
    throw error;
  }
  if (inodeOf(aside) !== lock.ino) {
    // Another breaker got there first and a new holder took the lock in between: this
    // moved the new holder's lock, so put it back unless yet another taker has one now.
    try {
      linkSync(aside, path);
    } catch (error) {
      if (codeOf(error) !== "EEXIST" && codeOf(error) !== "ENOENT") throw error;
    }
    rmSync(aside, { force: true });
    return "gone";
  }
  rmSync(aside, { force: true });
  return "broken";
}

/** The lock file's inode, age and holder, read from one open file; `null` when gone. */
function inspect(path: string): { ino: bigint; age: number; holder: Holder | null } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd, { bigint: true });
    return {
      ino: stats.ino,
      age: Date.now() - Number(stats.mtimeMs),
      holder: parseHolder(readFileSync(fd, "utf8")),
    };
  } finally {
    closeSync(fd);
  }
}

function inodeOf(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).ino;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** The lock's holder, or `null` when the file is gone or holds no readable holder. */
function readHolder(path: string): Holder | null {
  try {
    return parseHolder(readFileSync(path, "utf8"));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

function parseHolder(text: string): Holder | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { pid, nonce } = value as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || typeof nonce !== "string") {
      return null;
    }
    return { pid, nonce };
  } catch {
    return null;
  }
}

/** Whether a process with this pid exists; one another user owns counts. */
function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
