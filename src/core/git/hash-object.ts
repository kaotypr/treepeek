import type { BigIntStats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { Lru } from "../cache/lru";
import { BatchProcess, type BatchRequestOptions } from "./batch-process";
import { GitError, GitParseError } from "./errors";
import { runGit } from "./run";

export interface HashObjectBatchOptions {
  /** Idle time before the process closes. Default `BATCH_IDLE_MS`. */
  idleMs?: number;
  /** Time limit for one chunk of paths. Default `GIT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Paths whose hash is remembered. Default `HASH_CACHE_ENTRIES`. */
  cacheEntries?: number;
}

/** How many `(path, size, mtimeNs)` hashes one checkout remembers. */
export const HASH_CACHE_ENTRIES = 100_000;

/**
 * Paths sent per request. Each request holds a git-queue slot and has its own time limit,
 * so a large untracked tree is hashed in pieces other work can run between.
 */
const CHUNK = 256;

const OID = /^[0-9a-f]{40,64}$/;
const WHAT = "hash-object --stdin-paths";

interface CachedHash {
  size: bigint;
  mtimeNs: bigint;
  oid: string;
}

interface Pending {
  path: string;
  stats: BigIntStats;
}

/**
 * Computes the blob id Git would give working-tree files, through one long-lived
 * `git hash-object --stdin-paths` per checkout (git-service design), never with `-w`, so
 * nothing is written to the repository. A file whose size and mtime have not changed since
 * it was last hashed is answered from a `(path, size, mtimeNs)` cache without asking git.
 *
 * Git hashes a symlink's target text, not what it points at, while `--stdin-paths` would
 * follow the link, so a symlink is hashed from its target with `hash-object --stdin`.
 */
export class HashObjectBatch {
  readonly checkoutPath: string;
  readonly #batch: BatchProcess;
  readonly #cache: Lru<string, CachedHash>;

  /** `checkoutPath` is the checkout's top level; paths are relative to it. */
  constructor(checkoutPath: string, options: HashObjectBatchOptions = {}) {
    this.checkoutPath = checkoutPath;
    this.#batch = new BatchProcess({
      cwd: checkoutPath,
      args: ["hash-object", "--stdin-paths"],
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    this.#cache = new Lru(options.cacheEntries ?? HASH_CACHE_ENTRIES);
  }

  /** The running process's pid, or `null` when none is running. */
  get pid(): number | null {
    return this.#batch.pid;
  }

  /** Paths whose hash is cached. */
  get cacheSize(): number {
    return this.#cache.size;
  }

  /**
   * Hashes `paths` (repository-relative, `/`-separated). The result maps each path that
   * could be hashed to its blob id. Paths that cannot be (missing, a folder, unreadable,
   * absolute or containing `..`) are left out.
   */
  async hash(paths: readonly string[], options: BatchRequestOptions): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const unique = [...new Set(paths)].filter(isCheckoutRelative);
    const stats = await Promise.all(
      unique.map((path) =>
        lstat(join(this.checkoutPath, path), { bigint: true }).catch(() => null),
      ),
    );
    if (options.signal.aborted) throw cancelledError();

    const files: Pending[] = [];
    const links: Pending[] = [];
    unique.forEach((path, index) => {
      const stat = stats[index];
      if (!stat) return;
      const cached = this.#cache.get(path);
      if (cached && cached.size === stat.size && cached.mtimeNs === stat.mtimeNs) {
        result.set(path, cached.oid);
      } else if (stat.isFile()) {
        files.push({ path, stats: stat });
      } else if (stat.isSymbolicLink()) {
        links.push({ path, stats: stat });
      }
    });

    let rest = files;
    while (rest.length > 0) {
      const chunk = rest.slice(0, CHUNK);
      const { oids, failedAt } = await this.#hashChunk(
        chunk.map((entry) => entry.path),
        options,
      );
      oids.forEach((oid, index) => {
        const entry = chunk[index];
        if (entry) this.#remember(entry, oid, result);
      });
      // Git stops at a file it cannot open; skip that one and carry on with a new process.
      rest = rest.slice(failedAt === null ? chunk.length : failedAt + 1);
    }

    for (const link of links) {
      const oid = await this.#hashSymlink(link.path, options);
      if (oid) this.#remember(link, oid, result);
    }
    return result;
  }

  /** Stops the process; later hashes that need git fail with `cancelled`. */
  close(): void {
    this.#batch.close();
  }

  #remember(entry: Pending, oid: string, result: Map<string, string>): void {
    // The stats were taken before hashing: if the file changed since, the next call sees
    // a different size or mtime and hashes it again.
    this.#cache.set(entry.path, { size: entry.stats.size, mtimeNs: entry.stats.mtimeNs, oid });
    result.set(entry.path, oid);
  }

  /**
   * Sends `paths` in one request and reads one id per path. When git exits part-way (it
   * exits on the first file it cannot open), returns the ids it gave and the index of the
   * path it stopped at.
   */
  #hashChunk(
    paths: readonly string[],
    options: BatchRequestOptions,
  ): Promise<{ oids: string[]; failedAt: number | null }> {
    return this.#batch.request(async (io) => {
      io.write(paths.map((path) => `${stdinPathLine(path)}\n`).join(""));
      const oids: string[] = [];
      try {
        for (let index = 0; index < paths.length; index += 1) {
          const line = (await io.readLine()).toString("latin1");
          if (!OID.test(line))
            throw new GitParseError(WHAT, `unexpected line "${line.slice(0, 80)}"`);
          oids.push(line);
        }
      } catch (error) {
        if (error instanceof GitError && error.detail.exitCode === 128) {
          return { oids, failedAt: oids.length };
        }
        throw error;
      }
      return { oids, failedAt: null };
    }, options);
  }

  async #hashSymlink(path: string, options: BatchRequestOptions): Promise<string | null> {
    let target: Buffer;
    try {
      target = await readlink(join(this.checkoutPath, path), { encoding: "buffer" });
    } catch {
      return null;
    }
    // No `--path`, so no attributes and no filters apply: the blob is the target text, as Git
    // stores a symlink.
    const output = await runGit(this.checkoutPath, ["hash-object", "--stdin"], {
      signal: options.signal,
      stdin: target,
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    });
    const oid = output.stdout.toString("latin1").trim();
    if (!OID.test(oid)) throw new GitParseError("hash-object --stdin", "no object id");
    return oid;
  }
}

/** A repository-relative path that stays inside the checkout. */
function isCheckoutRelative(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\0")) return false;
  return !path.split("/").some((segment) => segment === ".." || segment === "");
}

/**
 * The line `--stdin-paths` reads for `path`. Git reads one path per line, drops a trailing
 * CR, and unquotes a line that starts with `"` as a C string; so a path with a control
 * character or a leading quote is sent C-quoted.
 */
export function stdinPathLine(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being detected.
  if (!/[\u0000-\u001f\u007f]/.test(path) && !path.startsWith('"')) return path;
  let quoted = '"';
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === "\\") quoted += `\\${char}`;
    else if (char === "\n") quoted += "\\n";
    else if (char === "\t") quoted += "\\t";
    else if (char === "\r") quoted += "\\r";
    else if (code < 0x20 || code === 0x7f) quoted += `\\${code.toString(8).padStart(3, "0")}`;
    else quoted += char;
  }
  return `${quoted}"`;
}

function cancelledError(): GitError {
  return new GitError("cancelled", "The Git command was cancelled.");
}
