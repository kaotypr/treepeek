import { skipToken, useQuery } from "@tanstack/react-query";
import { core, unwrap } from "../client";
import { type ComparisonRequest, keys } from "../keys";

/** The request `comparison.list` and `diff.file` take, without absent optional fields. */
export function comparisonArgs(request: ComparisonRequest): ComparisonRequest {
  return {
    kind: request.kind,
    ...(request.ref ? { ref: request.ref } : {}),
    ...(request.startOverride ? { startOverride: request.startOverride } : {}),
  };
}

/**
 * The selected checkout's file list for one comparison. It stays fresh until a rescan (or,
 * later, live refresh) invalidates it.
 */
export function useComparison(checkoutPath: string | null, request: ComparisonRequest | null) {
  const ready = checkoutPath !== null && request !== null;
  return useQuery({
    queryKey: ready ? keys.comparison(checkoutPath, request) : ["comparison", null],
    queryFn: ready
      ? async () =>
          unwrap(await core().comparison.list({ checkoutPath, ...comparisonArgs(request) }))
      : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
