import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Memo } from "./memo";

/**
 * Filesystem stamps for the mutable caches. Live refresh invalidates the caches when it
 * sees a change; a scan does not rely on it having seen every one, and compares a cheap
 * stamp (file metadata, no git process) with the one an entry was stored under, forgetting
 * the entry when it changed.
 */

/** Forgets `memo`'s entry for `key` when `stamp` differs from the one it was stored under. */
export function revalidate<K, V>(
  memo: Memo<K, V>,
  stamps: Map<K, string>,
  key: K,
  stamp: string,
): void {
  if (stamps.get(key) === stamp) return;
  memo.delete(key);
  stamps.set(key, stamp);
}

/** Inode, size and mtime of a file or folder, or `-` when it does not exist. */
export async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}`;
  } catch {
    return "-";
  }
}

/** The stamps of several files, in order. */
export async function filesStamp(paths: readonly string[]): Promise<string> {
  return (await Promise.all(paths.map(fileStamp))).join("|");
}

/**
 * Changes whenever Git's worktree list can change: a worktree added or removed (an entry in
 * `<commonDir>/worktrees/`), or moved or repaired (its `gitdir` file rewritten).
 */
export async function worktreeListStamp(commonDir: string): Promise<string> {
  const folder = join(commonDir, "worktrees");
  let names: string[];
  try {
    names = (await readdir(folder)).sort();
  } catch {
    return "-";
  }
  const parts = await Promise.all(
    names.map(async (name) => `${name}=${await fileStamp(join(folder, name, "gitdir"))}`),
  );
  return [await fileStamp(folder), ...parts].join("|");
}
