import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DIFF_LIMITS } from "../../shared/constants";
import type { FileChange } from "../../shared/domain/compare";
import { sniffBinary } from "../compare/sniff";
import type { CatFileBatch } from "../git/cat-file";
import { GitError } from "../git/errors";
import { isWithin } from "../sessions/path-rule";

export interface ContentContext {
  /** The checkout's real path. */
  readonly checkoutPath: string;
  /** The repository's `cat-file` process, for commit and index sides. */
  readonly catFile: CatFileBatch;
  readonly signal: AbortSignal;
}

/** One side's content for `FileDiff.left` or `right`. */
export type SideContent =
  /** The whole content, at most `DIFF_LIMITS.contentBytes`. */
  | { omitted: false; data: Buffer }
  /**
   * Over `DIFF_LIMITS.contentBytes`, so not read. `binary` is a sniff of a working-tree
   * file's head; a blob over the cap is never read, so Git's patch decides for it.
   */
  | { omitted: true; binary: boolean };

export interface ReadSideOptions {
  /** The side is a submodule (mode `160000`), which Git shows as `Subproject commit <id>`. */
  gitlink: boolean;
}

/** A full object id; a working-tree submodule's `resultHash` may be `gitlink:<path>` instead. */
const OID = /^[0-9a-f]{40,64}$/;
const EMPTY: SideContent = Object.freeze({ omitted: false, data: Buffer.alloc(0) });

/**
 * Reads one side of a changed file within `DIFF_LIMITS.contentBytes` (diff pipeline,
 * "Contents"):
 *
 * - an empty side is empty;
 * - a commit or index side is its blob (`leftOid`/`rightOid`, from Git's own list), read
 *   through the repository's `cat-file` process, which reads only the size of a blob over
 *   the cap;
 * - a working-tree side is the file on disk, read only after its real path is checked to
 *   lie inside the checkout, and opened without following a symlink. A symlink's content
 *   is its target text, as Git stores it; its target is never read. A file that is gone
 *   reads as empty, matching the deletion Git's patch then shows.
 *
 * Throws a `notInScan` `GitError` for a working-tree file that resolves outside the
 * checkout, and whatever the `cat-file` process throws.
 */
export async function readSide(
  ctx: ContentContext,
  change: FileChange,
  which: "left" | "right",
  options: ReadSideOptions,
): Promise<SideContent> {
  const side = change[which];
  const oid = which === "left" ? change.leftOid : change.rightOid;
  switch (side.kind) {
    case "empty":
      return EMPTY;
    case "commit":
    case "index": {
      if (options.gitlink) return subproject(oid);
      if (oid === undefined) {
        throw new GitError("internal", `No blob id is known for the ${which} side of a file.`);
      }
      const blob = await ctx.catFile.read(oid, DIFF_LIMITS.contentBytes, { signal: ctx.signal });
      return blob.tooLarge ? { omitted: true, binary: false } : { omitted: false, data: blob.data };
    }
    case "workingTree":
      if (options.gitlink) return subproject(change.resultHash);
      return readWorkingFile(ctx, change.path);
  }
}

function subproject(oid: string | undefined): SideContent {
  if (oid === undefined || !OID.test(oid)) return EMPTY;
  return { omitted: false, data: Buffer.from(`Subproject commit ${oid}\n`) };
}

async function readWorkingFile(ctx: ContentContext, path: string): Promise<SideContent> {
  const file = join(ctx.checkoutPath, path);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (isMissing(error)) return EMPTY;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return { omitted: false, data: await readlink(file, { encoding: "buffer" }) };
  }
  // A folder (a submodule without a gitlink mode, or a stale list) has no content to show.
  if (!stats.isFile()) return EMPTY;
  if (!isWithin(await realpath(file), ctx.checkoutPath)) {
    throw new GitError("notInScan", "That file resolves outside its checkout.");
  }
  // `O_NOFOLLOW`: if the file was swapped for a symlink since, open fails.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await handle.stat();
    const cap = DIFF_LIMITS.contentBytes;
    if (size > cap) return { omitted: true, binary: await sniffBinary(ctx.checkoutPath, path) };
    // One byte more than the size, to notice a file that grew past the cap meanwhile.
    const buffer = Buffer.alloc(size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > cap) {
      const head = buffer.subarray(0, DIFF_LIMITS.binarySniffBytes);
      return { omitted: true, binary: head.includes(0) };
    }
    return { omitted: false, data: buffer.subarray(0, total) };
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
