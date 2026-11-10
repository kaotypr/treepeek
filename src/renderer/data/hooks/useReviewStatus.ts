import {
  type QueryClient,
  skipToken,
  type UseQueryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { ReviewStatus } from "../../../shared/domain/review";
import { uiStore } from "../../state/ui-store";
import { type UndoEntry, undoStore } from "../../state/undo";
import { core, isIpcFailure, unwrap } from "../client";
import { keys } from "../keys";
import { undoRequests, withAllMarks, withMarks } from "../review-model";

/** Asks the core service for one checkout's review status. */
function fetchStatus(checkoutPath: string): () => Promise<ReviewStatus> {
  return async () => {
    const [status] = unwrap(await core().review.status({ checkoutPaths: [checkoutPath] }));
    if (!status) throw new Error("The core service answered no status.");
    return status;
  };
}

/**
 * A checkout's review status, asked for again whenever the checkout is selected (marks may
 * have changed in another window, or a rescan changed the files). Background status and
 * other windows' changes arrive as `review.changed` (`useReviewEvents`).
 */
export function useReviewStatus(checkoutPath: string | null) {
  return useQuery({
    queryKey: checkoutPath ? keys.reviewStatus(checkoutPath) : ["reviewStatus", null],
    queryFn: checkoutPath ? fetchStatus(checkoutPath) : skipToken,
    // Stale at once, so selecting the checkout asks again; nothing else refetches it.
    staleTime: 0,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * The status the cache holds for a checkout, without asking for it (rows, rings).
 *
 * Disabled rather than given `skipToken`: every observer hands the query its options, and a
 * refetch (`invalidateQueries` after a scan) runs with whichever observer's came last. Were
 * those `skipToken`, the selected checkout's refetch would fail with "Missing queryFn".
 */
export function useCachedReviewStatus(checkoutPath: string | null): ReviewStatus | undefined {
  return useQuery<ReviewStatus>({
    queryKey: checkoutPath ? keys.reviewStatus(checkoutPath) : ["reviewStatus", null],
    queryFn: checkoutPath ? fetchStatus(checkoutPath) : skipToken,
    enabled: false,
    gcTime: Number.POSITIVE_INFINITY,
  }).data;
}

/** The statuses the cache holds for `paths`, in order (the timeline's header and filter). */
export function useCachedReviewStatuses(paths: readonly string[]): (ReviewStatus | undefined)[] {
  return useQueries({
    queries: paths.map(
      (path): UseQueryOptions<ReviewStatus> => ({
        queryKey: keys.reviewStatus(path),
        // Disabled with the real query function, as in `useCachedReviewStatus`.
        queryFn: fetchStatus(path),
        enabled: false,
        gcTime: Number.POSITIVE_INFINITY,
      }),
    ),
    combine: (results) => results.map((result) => result.data),
  });
}

/** Writes every `review.changed` into the cache, for as long as the window shows a scan. */
export function useReviewEvents(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.treepeek.on("review.changed", (status) => {
        // A status computed before this window's own mark still on its way would undo the
        // change on screen; the mark's answer brings the status instead.
        if ((pending.get(status.checkoutPath) ?? 0) > 0) return;
        queryClient.setQueryData(keys.reviewStatus(status.checkoutPath), status);
      }),
    [queryClient],
  );
}

/** Mark calls on their way, by checkout. */
const pending = new Map<string, number>();

function begin(checkoutPath: string): void {
  pending.set(checkoutPath, (pending.get(checkoutPath) ?? 0) + 1);
}

function end(checkoutPath: string): void {
  const left = (pending.get(checkoutPath) ?? 1) - 1;
  if (left > 0) pending.set(checkoutPath, left);
  else pending.delete(checkoutPath);
}

interface Optimistic {
  previous: ReviewStatus | undefined;
}

/** Shows the change at once; the core service's answer replaces it. */
async function optimistic(
  queryClient: QueryClient,
  checkoutPath: string,
  update: (status: ReviewStatus) => ReviewStatus,
): Promise<Optimistic> {
  begin(checkoutPath);
  const key = keys.reviewStatus(checkoutPath);
  await queryClient.cancelQueries({ queryKey: key });
  const previous = queryClient.getQueryData<ReviewStatus>(key);
  if (previous) queryClient.setQueryData(key, update(previous));
  return { previous };
}

function rollBack(
  queryClient: QueryClient,
  checkoutPath: string,
  context: Optimistic | undefined,
  error: unknown,
  what: string,
): void {
  if (context?.previous) {
    queryClient.setQueryData(keys.reviewStatus(checkoutPath), context.previous);
  }
  const reason = isIpcFailure(error) ? error.message : "The core service did not answer.";
  uiStore.getState().showNotice(`${what}: ${reason}`, "error");
}

/** Marks files Viewed or not, showing the change at once and rolling it back on failure. */
export function useMarkFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["review.mark"],
    mutationFn: async (request: { checkoutPath: string; paths: string[]; viewed: boolean }) =>
      unwrap(await core().review.mark(request)),
    onMutate: (request) =>
      optimistic(queryClient, request.checkoutPath, (status) =>
        withMarks(status, new Set(request.paths), request.viewed),
      ),
    onError: (error, request, context) =>
      rollBack(
        queryClient,
        request.checkoutPath,
        context,
        error,
        request.viewed ? "Could not mark as viewed" : "Could not unmark",
      ),
    onSuccess: (status) => queryClient.setQueryData(keys.reviewStatus(status.checkoutPath), status),
    onSettled: (_data, _error, request) => end(request.checkoutPath),
  });
}

/**
 * "Mark all as reviewed" and "Unmark all": one action each, shown at once; once the core
 * service has done it, what it replaced goes on the window's undo stack (⌘Z).
 */
export function useMarkAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["review.markAll"],
    mutationFn: async (request: { checkoutPath: string; viewed: boolean }) =>
      unwrap(await core().review.markAll(request)),
    onMutate: (request) =>
      optimistic(queryClient, request.checkoutPath, (status) =>
        withAllMarks(status, request.viewed),
      ),
    onError: (error, request, context) =>
      rollBack(
        queryClient,
        request.checkoutPath,
        context,
        error,
        request.viewed ? "Could not mark all as reviewed" : "Could not unmark all",
      ),
    onSuccess: ({ status, previous }, request) => {
      queryClient.setQueryData(keys.reviewStatus(status.checkoutPath), status);
      if (previous.length > 0) {
        undoStore.getState().push({
          checkoutPath: request.checkoutPath,
          action: request.viewed ? "markAll" : "unmarkAll",
          previous,
        });
      }
    },
    onSettled: (_data, _error, request) => end(request.checkoutPath),
  });
}

/** Puts back what one "Mark all" or "Unmark all" replaced (⌘Z). */
export async function undoMarks(queryClient: QueryClient, entry: UndoEntry): Promise<void> {
  const { checkoutPath, previous } = entry;
  const { restore, clear } = undoRequests(previous);
  begin(checkoutPath);
  try {
    let status: ReviewStatus | undefined;
    if (restore.paths.length > 0) {
      status = unwrap(await core().review.mark({ checkoutPath, viewed: true, ...restore }));
    }
    if (clear.length > 0) {
      status = unwrap(await core().review.mark({ checkoutPath, paths: clear, viewed: false }));
    }
    if (status) queryClient.setQueryData(keys.reviewStatus(checkoutPath), status);
    uiStore
      .getState()
      .showNotice(entry.action === "markAll" ? "Undid Mark all as reviewed." : "Undid Unmark all.");
  } catch (error) {
    uiStore
      .getState()
      .showNotice(
        `Could not undo: ${isIpcFailure(error) ? error.message : "the core service did not answer."}`,
        "error",
      );
  } finally {
    end(checkoutPath);
  }
}
