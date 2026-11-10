/**
 * Review marks (review-marks design): a reviewer marks the files of a worktree's review
 * scope Viewed, and the marks add up to the worktree's progress.
 */

/**
 * One file of the review scope:
 *
 * | State | Condition | Counts as reviewed |
 * | --- | --- | --- |
 * | `unviewed` | no mark for the path | no |
 * | `viewed` | the mark's `resultHash` is the file's current one | yes |
 * | `changedSinceViewed` | the mark's `resultHash` differs from the current one | no |
 */
export type FileReviewState = "unviewed" | "viewed" | "changedSinceViewed";

export const FILE_REVIEW_STATES: readonly FileReviewState[] = Object.freeze([
  "unviewed",
  "viewed",
  "changedSinceViewed",
]);

/** One file of the review scope and its state. */
export interface FileReview {
  /** Repository-relative, `/`-separated (the `review` comparison's path). */
  path: string;
  state: FileReviewState;
  /** `changedSinceViewed` only: the `resultHash` of the version that was viewed. */
  viewedHash?: string;
  /**
   * `changedSinceViewed` only: whether the viewed version can still be shown ("Since you
   * viewed"), from a snapshot or from Git.
   */
  earlierAvailable?: boolean;
}

/** A checkout's review progress, as `review.status` answers it. */
export interface ReviewStatus {
  /** The checkout's real path. */
  checkoutPath: string;
  /** The worktree identity the marks belong to. */
  worktreeId: string;
  /** Files in the review scope. */
  total: number;
  viewed: number;
  changedSinceViewed: number;
  /** No start is known, so the scope holds only the uncommitted changes. */
  partialScope: boolean;
  /** Every file of the scope, sorted by path. */
  files: FileReview[];
}

/** A file's mark before an action changed it, `null` when it had none (for undo). */
export interface PreviousMark {
  path: string;
  resultHash: string | null;
}

export interface ReviewProgress {
  /** Viewed ÷ files in scope, rounded down, so 100 means every file. */
  percent: number;
  /** 100% of at least one file. */
  reviewed: boolean;
  /** Nothing in the scope: shown as "No changes" rather than 100%. */
  empty: boolean;
  /** Some file changed since it was viewed. */
  changed: boolean;
}

/** The progress a status adds up to (review-marks design, rule 4). */
export function reviewProgress(
  status: Pick<ReviewStatus, "total" | "viewed" | "changedSinceViewed">,
): ReviewProgress {
  const empty = status.total === 0;
  const percent = empty ? 0 : Math.floor((status.viewed * 100) / status.total);
  return {
    percent,
    reviewed: !empty && status.viewed === status.total,
    empty,
    changed: status.changedSinceViewed > 0,
  };
}
