import { skipToken, useQuery } from "@tanstack/react-query";
import type { ComparisonResult, FileChange } from "../../../shared/domain/compare";
import { core, newRequestId, unwrap } from "../client";
import { type ComparisonRequest, comparisonKey, keys } from "../keys";
import { comparisonArgs } from "./useComparison";

/**
 * One file's diff. Each fetch carries a request id; when nobody needs the answer any more
 * (another file was selected, the preview unmounted) TanStack Query aborts it and the core
 * service is told to stop, killing its git processes.
 */
export function useFileDiff(
  checkoutPath: string | null,
  request: ComparisonRequest | null,
  result: ComparisonResult | undefined,
  file: FileChange | undefined,
) {
  const ready =
    checkoutPath !== null && request !== null && result !== undefined && file !== undefined;
  return useQuery({
    queryKey: ready
      ? keys.fileDiff(checkoutPath, comparisonKey(result.comparison), file, file.resultHash)
      : ["fileDiff", null],
    queryFn: ready
      ? async ({ signal }) => {
          const requestId = newRequestId("diff");
          const cancel = () => void core().request.cancel({ requestId });
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return unwrap(
              await core().diff.file({
                requestId,
                checkoutPath,
                comparison: comparisonArgs(request),
                path: file.path,
                ...(file.category ? { category: file.category } : {}),
              }),
            );
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        }
      : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * The selected file's changes since it was marked Viewed (`diff.file` with `sinceViewed`).
 * Keyed by the version viewed and the version now, so a new mark or a new edit asks again.
 */
export function useSinceViewedDiff(
  checkoutPath: string | null,
  file: FileChange | undefined,
  viewedHash: string | undefined,
) {
  const ready = checkoutPath !== null && file !== undefined && viewedHash !== undefined;
  return useQuery({
    queryKey: ready
      ? keys.fileDiff(
          checkoutPath,
          `sinceViewed|${viewedHash}`,
          { path: file.path },
          file.resultHash,
        )
      : ["fileDiff", null, "sinceViewed"],
    queryFn: ready
      ? async ({ signal }) => {
          const requestId = newRequestId("since");
          const cancel = () => void core().request.cancel({ requestId });
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return unwrap(
              await core().diff.file({
                requestId,
                checkoutPath,
                comparison: { kind: "sinceViewed" },
                path: file.path,
              }),
            );
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        }
      : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
  });
}
