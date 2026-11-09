/**
 * How each comparison kind is named and explained in the comparison settings. The labels
 * are the domain model's; the hints carry the prototype's wording over, with one added for
 * `review`, which the prototype did not have.
 */

import type { ListableComparisonKind } from "./compare";

export const COMPARISON_LABELS: Readonly<Record<ListableComparisonKind, string>> = Object.freeze({
  review: "All worktree changes",
  worktree: "Made in this worktree (commits only)",
  working: "Current uncommitted changes",
  incoming: "Already arrived since previous worktree",
  sincePrevious: "All changes since previous worktree",
  base: "Compare with another base",
  upstream: "Compare with upstream",
});

export const COMPARISON_HINTS: Readonly<Record<ListableComparisonKind, string>> = Object.freeze({
  review:
    "Everything this worktree changed since it was first seen: its commits plus staged, unstaged, and untracked files.",
  worktree: "Changes from the first recorded checkout to this worktree’s current HEAD.",
  working: "Staged, unstaged, and untracked files in this checkout right now.",
  incoming:
    "Changes between the previous worktree’s HEAD and this worktree’s initial HEAD. These were already present when it started.",
  sincePrevious:
    "The full difference from the previous worktree’s HEAD to this worktree’s current HEAD.",
  base: "Enter a local branch or commit. Compared from its merge base to HEAD.",
  upstream: "Compared from the upstream merge base to HEAD. No fetch is performed.",
});
