import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { DIFF_LIMITS } from "../../shared/constants";
import type { FileStatus } from "../../shared/domain/compare";
import type { FileDiff } from "../../shared/domain/diff";
import type { IpcError } from "../../shared/ipc/result";
import { isIpcError } from "../compare/kinds";
import { readSide, type SideContent } from "../diff/contents";
import { assembleFileDiff, checkRepoPath, mergeSections } from "../diff/file-diff";
import { contentAgainstFile } from "../diff/patch";
import { GitError } from "../git/errors";
import { isWithin, realPathOf } from "../sessions/path-rule";
import type { Mark } from "../store/review-store";
import { type ReviewContext, reviewScope } from "./status";

const OID = /^[0-9a-f]{40,64}$/;

/** The viewed version's content, or why there is none to show. */
type Viewed = { data: Buffer } | { missing: "unavailable" | "tooLarge" };

/**
 * "Since you viewed" (`diff.file` with `sinceViewed`, review-marks design): the version a
 * file's mark says was viewed against the file now, through the normal diff pipeline. The
 * viewed side is the snapshot kept when it was marked, else its blob from Git while that
 * is still reachable; it goes to a temporary file and Git compares it with the file on
 * disk (`diff --no-index`).
 *
 * The file must be in the review scope and have a mark. Fails `refNotFound` with
 * `detail.unavailable: "noEarlierVersion"` when the viewed version is kept nowhere.
 */
export async function sinceViewedDiff(
  ctx: ReviewContext,
  path: string,
): Promise<FileDiff | IpcError> {
  const problem = checkRepoPath(path);
  if (problem === "escapes") return notInScan();
  if (problem === "malformed") {
    return { code: "invalidRequest", message: "That is not a repository-relative file path." };
  }
  const checkoutPath = ctx.checkout.checkout.path;
  const real = await realPathOf(join(checkoutPath, path));
  if (real === null || !isWithin(real, checkoutPath)) return notInScan();

  const scope = await reviewScope(ctx);
  if (isIpcError(scope)) return scope;
  const change = scope.files.find((file) => file.path === path);
  const mark = ctx.store.getMarks(ctx.checkout.worktreeId).find((item) => item.path === path);
  if (!change || !mark) {
    return {
      code: "invalidRequest",
      message: change
        ? "That file has not been marked Viewed."
        : "That file has no changes in this worktree. The list may be out of date.",
      detail: { notInComparison: true },
    };
  }

  const viewed = await viewedContent(ctx, mark);
  if ("missing" in viewed) {
    return viewed.missing === "tooLarge"
      ? { code: "outputTooLarge", message: "The version you viewed is too large to compare." }
      : {
          code: "refNotFound",
          message: "The version you viewed is not available any more.",
          detail: { unavailable: "noEarlierVersion" },
        };
  }

  const viewedDeletion = mark.resultHash.startsWith("deleted:");
  const gone = change.status === "deleted";
  const patch = await contentAgainstFile(
    { checkoutPath, repo: ctx.repo, signal: ctx.signal },
    viewed.data,
    gone ? null : await rightSide(checkoutPath, path),
  );
  const right = await readSide(
    { checkoutPath, catFile: ctx.repo.catFile, signal: ctx.signal },
    change,
    "right",
    { gitlink: false },
  );
  const status: FileStatus =
    viewedDeletion && !gone ? "added" : gone && !viewedDeletion ? "deleted" : "modified";
  return assembleFileDiff(
    { path, status, resultHash: change.resultHash },
    mergeSections(patch.sections),
    patch.truncated,
    patch.stats,
    leftSide(viewed.data),
    right,
  );
}

/** The content a mark's version had: a deletion is empty. */
async function viewedContent(ctx: ReviewContext, mark: Mark): Promise<Viewed> {
  if (mark.resultHash.startsWith("deleted:")) return { data: Buffer.alloc(0) };
  if (mark.snapshotHash !== null) {
    const snapshot = ctx.store.getSnapshot(mark.snapshotHash);
    if (snapshot) return { data: snapshot };
  }
  if (!OID.test(mark.resultHash)) return { missing: "unavailable" };
  try {
    const blob = await ctx.repo.catFile.read(mark.resultHash, DIFF_LIMITS.patchBytes, {
      signal: ctx.signal,
    });
    return blob.tooLarge ? { missing: "tooLarge" } : { data: blob.data };
  } catch (error) {
    if (ctx.signal.aborted || (error instanceof GitError && error.code === "cancelled")) {
      throw error;
    }
    // Not in the repository (never staged, or collected), or not a blob (a submodule).
    return { missing: "unavailable" };
  }
}

/**
 * What Git compares the viewed version with: the file's path when it is a regular file; a
 * symlink's target text (Git would follow a link to a folder); nothing otherwise.
 */
async function rightSide(checkoutPath: string, path: string): Promise<string | Buffer | null> {
  const full = join(checkoutPath, path);
  try {
    const stats = await lstat(full);
    if (stats.isSymbolicLink()) return await readlink(full, { encoding: "buffer" });
    return stats.isFile() ? path : null;
  } catch {
    return null;
  }
}

function leftSide(data: Buffer): SideContent {
  if (data.length > DIFF_LIMITS.contentBytes) {
    return { omitted: true, binary: data.subarray(0, DIFF_LIMITS.binarySniffBytes).includes(0) };
  }
  return { omitted: false, data };
}

function notInScan(): IpcError {
  return { code: "notInScan", message: "That file is not inside this checkout." };
}
