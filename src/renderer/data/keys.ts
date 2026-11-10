/**
 * TanStack Query keys. Every key a later plan invalidates is built here, so live refresh
 * can name exactly what a change makes stale.
 *
 * File diffs are keyed by the comparison's resolved sides and the file's `resultHash`, so a
 * diff whose content did not change is served from the cache, and one whose sides moved is
 * fetched again.
 */

import type { Comparison, ContentSide, ListableComparisonKind } from "../../shared/domain/compare";

/** A comparison as `comparison.list` and `diff.file` take it. */
export interface ComparisonRequest {
  kind: ListableComparisonKind;
  ref?: string;
  startOverride?: string;
}

/** What identifies one file in a comparison's list. */
export interface FileKey {
  path: string;
  category?: string;
  leftOid?: string;
}

export const keys = {
  /** The window's scan, streamed into the cache (`scan-stream.ts`). */
  scan: (scanRoot: string) => ["scan", scanRoot] as const,
  /** Every comparison of one checkout: the prefix a change in that checkout invalidates. */
  checkoutComparisons: (checkoutPath: string) => ["comparison", checkoutPath] as const,
  comparison: (checkoutPath: string, request: ComparisonRequest) =>
    [
      "comparison",
      checkoutPath,
      request.kind,
      request.ref ?? null,
      request.startOverride ?? null,
    ] as const,
  /** Every checkout's review status: the prefix "Clear review data" invalidates. */
  reviewStatuses: () => ["reviewStatus"] as const,
  /** One checkout's review status (`review.status`, `review.changed`). */
  reviewStatus: (checkoutPath: string) => ["reviewStatus", checkoutPath] as const,
  /** Every file diff of one checkout. */
  checkoutDiffs: (checkoutPath: string) => ["fileDiff", checkoutPath] as const,
  fileDiff: (checkoutPath: string, comparisonKey: string, file: FileKey, resultHash: string) =>
    [
      "fileDiff",
      checkoutPath,
      comparisonKey,
      file.path,
      file.category ?? null,
      file.leftOid ?? null,
      resultHash,
    ] as const,
};

function sideKey(side: ContentSide): string {
  return side.kind === "commit" ? `commit:${side.oid}` : side.kind;
}

/** A comparison's identity once resolved: its kind and the two sides it compares. */
export function comparisonKey(comparison: Comparison): string {
  return `${comparison.kind}|${sideKey(comparison.left)}|${sideKey(comparison.right)}`;
}
