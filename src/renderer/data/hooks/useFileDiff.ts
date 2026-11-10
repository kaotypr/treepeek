import { type QueryKey, skipToken, useQuery } from "@tanstack/react-query";
import type { ComparisonResult, FileChange } from "../../../shared/domain/compare";
import type { FileDiff } from "../../../shared/domain/diff";
import { core, newRequestId, unwrap } from "../client";
import { type ComparisonRequest, comparisonKey, keys } from "../keys";
import { comparisonArgs } from "./useComparison";

/**
 * While a changed version of the same file loads (live refresh gave it a new `resultHash`),
 * the version on screen stays, so the preview does not blank out: the same checkout, the
 * same kind of comparison, the same path and category. Any other file starts empty.
 */
function keepSameFile(
  previous: FileDiff | undefined,
  previousQuery: { queryKey: QueryKey } | undefined,
  key: QueryKey,
): FileDiff | undefined {
  const before = previousQuery?.queryKey;
  if (previous === undefined || !before || before[1] === null) return undefined;
  const kind = (value: unknown) => String(value).split("|")[0];
  const same =
    before[1] === key[1] &&
    kind(before[2]) === kind(key[2]) &&
    before[3] === key[3] &&
    before[4] === key[4];
  return same ? previous : undefined;
}

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
  const queryKey: QueryKey = ready
    ? keys.fileDiff(checkoutPath, comparisonKey(result.comparison), file, file.resultHash)
    : ["fileDiff", null];
  return useQuery<FileDiff, Error, FileDiff, QueryKey>({
    queryKey,
    placeholderData: (previous, previousQuery) => keepSameFile(previous, previousQuery, queryKey),
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
  const queryKey: QueryKey = ready
    ? keys.fileDiff(checkoutPath, `sinceViewed|${viewedHash}`, { path: file.path }, file.resultHash)
    : ["fileDiff", null, "sinceViewed"];
  return useQuery<FileDiff, Error, FileDiff, QueryKey>({
    queryKey,
    placeholderData: (previous, previousQuery) => keepSameFile(previous, previousQuery, queryKey),
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
