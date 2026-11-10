import type { PreviousMark, ReviewStatus } from "../../shared/domain/review";
import type { IpcError } from "../../shared/ipc/result";
import { isIpcError } from "../compare/kinds";
import { checkRepoPath } from "../diff/file-diff";
import { type MarkInput, storeTime } from "../store/review-store";
import { snapshotFiles } from "./snapshot";
import { computeStatus, type ReviewContext, reviewScope } from "./status";

export interface MarkRequest {
  /** Repository-relative paths. */
  paths: readonly string[];
  viewed: boolean;
  /** One per path, only with `viewed`: the versions to mark instead of the current ones. */
  resultHashes?: readonly string[];
}

/** How many paths an error names when it lists them. */
const NAMED = 5;

/**
 * Marks files Viewed or not (`review.mark`) and answers the checkout's status.
 *
 * - `viewed` marks each path's current version: the `resultHash` its scope lists, so the
 *   version marked is the one the window showed. Every path must be in the review scope;
 *   otherwise nothing is marked and the answer is `invalidRequest`. A snapshot is kept of
 *   each working-tree version that qualifies (`snapshotFiles`).
 * - `resultHashes` restores exact versions instead (an undo of "Mark all" or "Unmark
 *   all"), for any repository-relative path: a mark may stay for a file that left the
 *   scope (rule 7). A snapshot kept under that version is linked again.
 * - not `viewed` deletes the paths' marks.
 */
export async function markFiles(
  ctx: ReviewContext,
  request: MarkRequest,
  now: Date = new Date(),
): Promise<ReviewStatus | IpcError> {
  const { paths, viewed, resultHashes } = request;
  for (const path of paths) {
    const problem = checkRepoPath(path);
    if (problem === "escapes") {
      return { code: "notInScan", message: "That file is not inside this checkout." };
    }
    if (problem === "malformed") {
      return { code: "invalidRequest", message: "That is not a repository-relative file path." };
    }
  }
  if (resultHashes !== undefined && (!viewed || resultHashes.length !== paths.length)) {
    return {
      code: "invalidRequest",
      message: "Versions to restore go with viewed files, one for each path.",
    };
  }
  const worktreeId = ctx.checkout.worktreeId;

  if (!viewed) {
    ctx.store.deleteMarks(worktreeId, paths);
    return computeStatus(ctx);
  }

  const viewedAt = storeTime(now);
  const scope = await reviewScope(ctx);
  if (isIpcError(scope)) return scope;
  const current = new Map(scope.files.map((file) => [file.path, file.resultHash]));

  let wanted: { path: string; resultHash: string }[];
  if (resultHashes !== undefined) {
    wanted = paths.map((path, index) => ({ path, resultHash: resultHashes[index] ?? "" }));
  } else {
    const outside = paths.filter((path) => !current.has(path));
    if (outside.length > 0) {
      return {
        code: "invalidRequest",
        message: `Only files with changes in this worktree can be marked Viewed (not ${outside
          .slice(0, NAMED)
          .join(", ")}).`,
        detail: { notInScope: outside.slice(0, NAMED) },
      };
    }
    wanted = paths.map((path) => ({ path, resultHash: current.get(path) ?? "" }));
  }

  // Only a version that is the current one can be read from the disk for a snapshot.
  const snapshots = await snapshotFiles(
    ctx,
    wanted.filter((file) => current.get(file.path) === file.resultHash),
  );
  const marks: MarkInput[] = wanted.map((file) => ({
    path: file.path,
    resultHash: file.resultHash,
    viewedAt,
    snapshotHash:
      snapshots.get(file.path) ?? (ctx.store.hasSnapshot(file.resultHash) ? file.resultHash : null),
  }));
  ctx.store.setMarks(worktreeId, marks);
  return computeStatus(ctx);
}

export interface MarkAllResult {
  status: ReviewStatus;
  /** Each path the action changed, with its mark before it (`null`: none), for an undo. */
  previous: PreviousMark[];
}

/**
 * "Mark all as reviewed" (`viewed`): a mark at the current version for every file of the
 * review scope, with snapshots. "Unmark all": every mark of the worktree goes, in the
 * scope or not (rule 6). Both answer what they replaced, so the window can undo them.
 */
export async function markAll(
  ctx: ReviewContext,
  viewed: boolean,
  now: Date = new Date(),
): Promise<MarkAllResult | IpcError> {
  const worktreeId = ctx.checkout.worktreeId;
  const before = ctx.store.getMarks(worktreeId);
  let previous: PreviousMark[];

  if (!viewed) {
    previous = before.map((mark) => ({ path: mark.path, resultHash: mark.resultHash }));
    ctx.store.deleteMarks(worktreeId);
  } else {
    const scope = await reviewScope(ctx);
    if (isIpcError(scope)) return scope;
    const marked = new Map(before.map((mark) => [mark.path, mark.resultHash]));
    const changing = scope.files.filter((file) => marked.get(file.path) !== file.resultHash);
    previous = changing.map((file) => ({
      path: file.path,
      resultHash: marked.get(file.path) ?? null,
    }));
    const snapshots = await snapshotFiles(ctx, changing);
    const viewedAt = storeTime(now);
    ctx.store.setMarks(
      worktreeId,
      changing.map((file) => ({
        path: file.path,
        resultHash: file.resultHash,
        viewedAt,
        snapshotHash: snapshots.get(file.path) ?? null,
      })),
    );
  }

  const status = await computeStatus(ctx);
  if (isIpcError(status)) return status;
  return { status, previous };
}
