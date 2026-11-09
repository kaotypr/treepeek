import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FolderNode } from "../../shared/domain/scan";
import { GitError } from "../git/errors";

export interface WalkOptions {
  /** Folders deeper than this below the root are neither listed nor entered. */
  maxDepth: number;
  /** Folder names never entered (or listed). */
  skip: ReadonlySet<string>;
  signal: AbortSignal;
}

export interface WalkResult {
  /** Every folder found, the root first, then sorted by relative path. */
  folders: FolderNode[];
  /** Real absolute paths of folders holding a `.git` file or folder, sorted. */
  candidates: string[];
}

/** Folders read at once; enough to keep the disk busy without exhausting file handles. */
const READ_CONCURRENCY = 32;

interface Pending {
  path: string;
  node: FolderNode;
}

/**
 * Walks the scan root (git-service design, "The scan", step 1). `root` must be a real path:
 * the walk never follows a symlink, so every path it reports is real too.
 *
 * - A folder holding a `.git` file or folder is a candidate checkout and is not entered:
 *   nested repositories belong to that checkout (submodules are not scanned).
 * - A folder that is itself a Git directory (a bare repository: `HEAD`, `objects/`,
 *   `refs/`) is listed but not entered, so its object store does not fill the tree.
 * - Folders named in `skip`, symlinks and folders deeper than `maxDepth` are not entered.
 *   Folders at `maxDepth` are read, so a checkout there is still found.
 * - A folder that cannot be read is listed and left alone.
 *
 * Throws a `cancelled` `GitError` when `signal` aborts.
 */
export async function walk(root: string, options: WalkOptions): Promise<WalkResult> {
  const rootNode: FolderNode = {
    name: basename(root) || root,
    relativePath: "",
    depth: 0,
    parent: null,
    checkoutPath: null,
  };
  const folders: FolderNode[] = [rootNode];
  const candidates: string[] = [];
  let level: Pending[] = [{ path: root, node: rootNode }];

  while (level.length > 0) {
    const next: Pending[] = [];
    await eachLimited(level, READ_CONCURRENCY, async ({ path, node }) => {
      if (options.signal.aborted) return;
      const entries = await readFolder(path);
      if (entries === null) return;
      if (entries.some((entry) => entry.name === ".git")) {
        node.checkoutPath = path;
        candidates.push(path);
        return;
      }
      if (isGitDirectory(entries) || node.depth >= options.maxDepth) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || options.skip.has(entry.name)) continue;
        const relativePath = node.relativePath ? `${node.relativePath}/${entry.name}` : entry.name;
        const child: FolderNode = {
          name: entry.name,
          relativePath,
          depth: node.depth + 1,
          parent: node.relativePath,
          checkoutPath: null,
        };
        folders.push(child);
        next.push({ path: join(path, entry.name), node: child });
      }
    });
    if (options.signal.aborted) throw new GitError("cancelled", "The scan was cancelled.");
    level = next;
  }

  folders.sort((a, b) => compareText(a.relativePath, b.relativePath));
  candidates.sort(compareText);
  return { folders, candidates };
}

async function readFolder(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function isGitDirectory(entries: readonly Dirent[]): boolean {
  const has = (name: string, kind: "file" | "directory") =>
    entries.some(
      (entry) => entry.name === name && (kind === "file" ? entry.isFile() : entry.isDirectory()),
    );
  return has("HEAD", "file") && has("objects", "directory") && has("refs", "directory");
}

/** Code-unit order, so the order is the same on every machine and locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index] as T;
      index += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
