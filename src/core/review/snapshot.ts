import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DIFF_LIMITS, REVIEW_LIMITS } from "../../shared/constants";
import { GitError } from "../git/errors";
import { isWithin } from "../sessions/path-rule";
import { isSnapshotHash } from "../store/snapshots";
import type { ReviewContext } from "./status";

/** Files read for snapshots at once. */
const PARALLEL = 16;

/** A working-tree file as it was read for a snapshot, and the stat it was read under. */
interface ReadFile {
  path: string;
  resultHash: string;
  bytes: Buffer;
  size: bigint;
  mtimeNs: bigint;
}

/**
 * Keeps snapshots of the content being marked (review-marks design, "Since you viewed"):
 * working-tree versions may exist nowhere else once the file changes again, and Treepeek
 * never writes to a repository's object database. A file is snapshotted when it is at
 * most `REVIEW_LIMITS.snapshotBytes`, not binary, and still the version marked: after
 * reading it, its hash (from the checkout's `hash-object`, cached by size and mtime) must
 * be the mark's `resultHash` and its stat unchanged. The snapshot is named by that
 * `resultHash`, so the same content marked twice, in any worktree, is kept once.
 *
 * Answers the snapshot name for each path that has one now (newly kept or kept before).
 */
export async function snapshotFiles(
  ctx: ReviewContext,
  files: readonly { path: string; resultHash: string }[],
): Promise<Map<string, string>> {
  const kept = new Map<string, string>();
  const toRead: { path: string; resultHash: string }[] = [];
  for (const file of files) {
    if (!isSnapshotHash(file.resultHash)) continue;
    if (ctx.store.hasSnapshot(file.resultHash)) kept.set(file.path, file.resultHash);
    else toRead.push(file);
  }

  const read: ReadFile[] = [];
  for (let index = 0; index < toRead.length; index += PARALLEL) {
    if (ctx.signal.aborted) throw cancelled();
    const batch = await Promise.all(
      toRead.slice(index, index + PARALLEL).map((file) => readForSnapshot(ctx, file)),
    );
    for (const file of batch) if (file) read.push(file);
  }
  if (read.length === 0) return kept;

  const hashes = await ctx.hashObject.hash(
    read.map((file) => file.path),
    { signal: ctx.signal, ...(ctx.priority ? { priority: ctx.priority } : {}) },
  );
  for (const file of read) {
    if (hashes.get(file.path) !== file.resultHash) continue;
    const now = await lstat(join(ctx.checkout.checkout.path, file.path), { bigint: true }).catch(
      () => null,
    );
    if (!now || now.size !== file.size || now.mtimeNs !== file.mtimeNs) continue;
    ctx.store.putSnapshot(file.resultHash, file.bytes);
    kept.set(file.path, file.resultHash);
  }
  return kept;
}

/**
 * A working-tree file's bytes for a snapshot, or `null` when it gets none: missing, not a
 * file or a symlink, over the size limit, binary, or resolving outside the checkout. A
 * symlink's content is its target text, as Git stores it.
 */
async function readForSnapshot(
  ctx: ReviewContext,
  file: { path: string; resultHash: string },
): Promise<ReadFile | null> {
  const checkoutPath = ctx.checkout.checkout.path;
  const full = join(checkoutPath, file.path);
  try {
    const before = await lstat(full, { bigint: true });
    if (before.isSymbolicLink()) {
      const target = await readlink(full, { encoding: "buffer" });
      return { ...file, bytes: target, size: before.size, mtimeNs: before.mtimeNs };
    }
    if (!before.isFile() || before.size > BigInt(REVIEW_LIMITS.snapshotBytes)) return null;
    if (!isWithin(await realpath(full), checkoutPath)) return null;
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = Number(before.size);
      // One byte more than the size, to notice a file that grew meanwhile.
      const buffer = Buffer.alloc(size + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total !== size) return null;
      const bytes = buffer.subarray(0, size);
      if (bytes.subarray(0, DIFF_LIMITS.binarySniffBytes).includes(0)) return null;
      return { ...file, bytes, size: before.size, mtimeNs: before.mtimeNs };
    } finally {
      await handle.close();
    }
  } catch {
    // Gone or unreadable: the mark stands, without a snapshot.
    return null;
  }
}

function cancelled(): GitError {
  return new GitError("cancelled", "Marking was cancelled.");
}
