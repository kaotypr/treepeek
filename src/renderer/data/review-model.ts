/**
 * Review status as the renderer changes it before the core service answers (optimistic
 * updates), and what the panels read from it. Pure functions, tested without a window.
 */

import type {
  FileReview,
  FileReviewState,
  PreviousMark,
  ReviewStatus,
} from "../../shared/domain/review";

/** The state of `path` in the review scope, or `undefined` when it is not in it. */
export function reviewStateOf(
  status: ReviewStatus | undefined,
  path: string,
): FileReviewState | undefined {
  return reviewFileOf(status, path)?.state;
}

export function reviewFileOf(
  status: ReviewStatus | undefined,
  path: string,
): FileReview | undefined {
  if (!status) return undefined;
  // `files` is sorted by path.
  let low = 0;
  let high = status.files.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const file = status.files[middle];
    if (!file) return undefined;
    if (file.path === path) return file;
    if (file.path < path) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

/** The counts of a list of files. */
function counted(status: ReviewStatus, files: FileReview[]): ReviewStatus {
  return {
    ...status,
    files,
    total: files.length,
    viewed: files.filter((file) => file.state === "viewed").length,
    changedSinceViewed: files.filter((file) => file.state === "changedSinceViewed").length,
  };
}

/** The status once `paths` are marked Viewed (or not), as the core service will answer. */
export function withMarks(
  status: ReviewStatus,
  paths: ReadonlySet<string>,
  viewed: boolean,
): ReviewStatus {
  return counted(
    status,
    status.files.map((file) =>
      paths.has(file.path) ? { path: file.path, state: viewed ? "viewed" : "unviewed" } : file,
    ),
  );
}

/** The status once every file is marked Viewed, or every mark is gone. */
export function withAllMarks(status: ReviewStatus, viewed: boolean): ReviewStatus {
  return withMarks(status, new Set(status.files.map((file) => file.path)), viewed);
}

/**
 * The two `review.mark` calls that put back what `previous` lists: the versions to restore,
 * and the paths that had no mark.
 */
export function undoRequests(previous: readonly PreviousMark[]): {
  restore: { paths: string[]; resultHashes: string[] };
  clear: string[];
} {
  const restore = { paths: [] as string[], resultHashes: [] as string[] };
  const clear: string[] = [];
  for (const item of previous) {
    if (item.resultHash === null) clear.push(item.path);
    else {
      restore.paths.push(item.path);
      restore.resultHashes.push(item.resultHash);
    }
  }
  return { restore, clear };
}
