import type { FileChange } from "../../shared/domain/compare";
import type { FileReview, FileReviewState, ReviewStatus } from "../../shared/domain/review";
import { isKnownStart } from "../../shared/domain/scan";
import type { IpcError } from "../../shared/ipc/result";
import type { RepositoryResources } from "../cache/shared-state";
import { isIpcError } from "../compare/kinds";
import { listComparison } from "../compare/list";
import { GitError } from "../git/errors";
import type { HashObjectBatch } from "../git/hash-object";
import type { GitPriority } from "../git/queue";
import type { ScannedCheckout } from "../scan/resolve-checkout";
import type { Mark, ReviewStore } from "../store/review-store";

/** What review work on one checkout needs. */
export interface ReviewContext {
  readonly checkout: ScannedCheckout;
  readonly repo: RepositoryResources;
  /** The checkout's `hash-object` process, for working-tree result hashes. */
  readonly hashObject: HashObjectBatch;
  readonly store: ReviewStore;
  readonly signal: AbortSignal;
  /** Queue lane for git work. Default `normal`; background status uses `low`. */
  readonly priority?: GitPriority;
}

/** The checkout's review scope: the `review` comparison's files. */
export interface ReviewScope {
  files: readonly FileChange[];
  /** No start is known, so only the uncommitted changes are in it. */
  partialScope: boolean;
}

/** An object id, which a `resultHash` is unless it names a deletion or a special case. */
const OID = /^[0-9a-f]{40,64}$/;

/**
 * The review scope (domain model, ReviewScope): everything the checkout changed since its
 * start, committed and uncommitted, as the `review` comparison lists it. The list comes
 * from the same cache `comparison.list` uses, so the files a window shows and the files
 * its progress counts are the same list.
 */
export async function reviewScope(ctx: ReviewContext): Promise<ReviewScope | IpcError> {
  const listed = await listComparison(
    {
      checkout: ctx.checkout,
      // `review` never needs the previous checkout.
      predecessor: undefined,
      repo: ctx.repo,
      hashObject: ctx.hashObject,
      signal: ctx.signal,
      ...(ctx.priority ? { priority: ctx.priority } : {}),
    },
    { kind: "review" },
  );
  if (isIpcError(listed)) return listed;
  return { files: listed.files, partialScope: !isKnownStart(ctx.checkout.checkout.start) };
}

/** A file's state from its mark (review-marks design, rule 3). */
export function fileState(
  mark: Pick<Mark, "resultHash"> | undefined,
  resultHash: string,
): FileReviewState {
  if (!mark) return "unviewed";
  return mark.resultHash === resultHash ? "viewed" : "changedSinceViewed";
}

export interface StatusInput {
  checkoutPath: string;
  worktreeId: string;
  partialScope: boolean;
  files: readonly Pick<FileChange, "path" | "resultHash">[];
  marks: readonly Pick<Mark, "path" | "resultHash">[];
  /** Whether a file changed since viewed can still show the viewed version. */
  earlierAvailable?: ReadonlyMap<string, boolean>;
}

/**
 * Joins the scope with the marks: each file's state, the counts and the partial-scope
 * flag. Marks of paths outside the scope are not counted (rule 7).
 */
export function joinStatus(input: StatusInput): ReviewStatus {
  const marks = new Map(input.marks.map((mark) => [mark.path, mark]));
  let viewed = 0;
  let changed = 0;
  const files = input.files
    .map((file): FileReview => {
      const mark = marks.get(file.path);
      const state = fileState(mark, file.resultHash);
      if (state === "viewed") viewed += 1;
      if (state !== "changedSinceViewed" || !mark) return { path: file.path, state };
      changed += 1;
      const review: FileReview = { path: file.path, state, viewedHash: mark.resultHash };
      const earlier = input.earlierAvailable?.get(file.path);
      if (earlier !== undefined) review.earlierAvailable = earlier;
      return review;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    checkoutPath: input.checkoutPath,
    worktreeId: input.worktreeId,
    total: files.length,
    viewed,
    changedSinceViewed: changed,
    partialScope: input.partialScope,
    files,
  };
}

/**
 * A checkout's review status (`review.status`, review-marks design, "Computing status"):
 * the scope's files with their `resultHash` (the comparison fills them in, hashing only
 * working-tree files whose size or mtime changed), joined with the identity's marks. For a
 * file changed since viewed, whether its viewed version is still kept is checked too.
 */
export async function computeStatus(ctx: ReviewContext): Promise<ReviewStatus | IpcError> {
  const scope = await reviewScope(ctx);
  if (isIpcError(scope)) return scope;
  const marks = ctx.store.getMarks(ctx.checkout.worktreeId);
  const byPath = new Map(marks.map((mark) => [mark.path, mark]));
  const earlierAvailable = new Map<string, boolean>();
  for (const file of scope.files) {
    const mark = byPath.get(file.path);
    if (fileState(mark, file.resultHash) !== "changedSinceViewed" || !mark) continue;
    earlierAvailable.set(file.path, await viewedVersionKept(ctx, mark));
  }
  return joinStatus({
    checkoutPath: ctx.checkout.checkout.path,
    worktreeId: ctx.checkout.worktreeId,
    partialScope: scope.partialScope,
    files: scope.files,
    marks,
    earlierAvailable,
  });
}

/**
 * Whether the version a mark was made for can still be shown: a deletion always can (it
 * is empty), otherwise from its snapshot or, while it is reachable, its blob in Git.
 */
export async function viewedVersionKept(ctx: ReviewContext, mark: Mark): Promise<boolean> {
  if (mark.resultHash.startsWith("deleted:")) return true;
  if (mark.snapshotHash !== null && ctx.store.hasSnapshot(mark.snapshotHash)) return true;
  if (!OID.test(mark.resultHash)) return false;
  try {
    // Only the size is read: a cap of 0 never asks for the body.
    await ctx.repo.catFile.read(mark.resultHash, 0, {
      signal: ctx.signal,
      ...(ctx.priority ? { priority: ctx.priority } : {}),
    });
    return true;
  } catch (error) {
    if (ctx.signal.aborted || (error instanceof GitError && error.code === "cancelled")) {
      throw error;
    }
    return false;
  }
}
