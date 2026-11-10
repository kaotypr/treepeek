import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileDiff } from "../../../shared/domain/diff";
import { runCommand } from "../../commands/registry";
import { isIpcFailure } from "../../data/client";
import { useFileDiff, useSinceViewedDiff } from "../../data/hooks/useFileDiff";
import { useCachedReviewStatus } from "../../data/hooks/useReviewStatus";
import { useScan } from "../../data/hooks/useScan";
import { useSelectedComparison, useSelectedFile } from "../../data/hooks/useSelection";
import type { ComparisonRequest } from "../../data/keys";
import { reviewFileOf } from "../../data/review-model";
import type { ScanData } from "../../data/scan-model";
import { DiffView } from "../../diff-view/DiffView";
import { DEFAULT_CONTEXT_LINES, type DiffAnchor, type DiffViewHandle } from "../../diff-view/types";
import { useResolvedTheme } from "../../lib/use-resolved-theme";
import { type FileSelection, uiStore, useUi } from "../../state/ui-store";
import { PreviewHeader } from "./PreviewHeader";

/** Loading text waits this long, so a quick diff never flashes it. */
const LOADING_DELAY_MS = 150;

/**
 * The selected file's diff in the chosen mode. A mode change keeps the same lines in view;
 * selecting another file cancels the diff still being fetched for the previous one.
 *
 * "Since you viewed" swaps in the file's changes since it was marked Viewed. Below the diff,
 * "Mark viewed and open next" (⌘↩) moves on through the review.
 *
 * Live refresh (live-refresh design, "The open diff"): when the file on screen changes, it
 * re-renders in place with an "Updated" marker, scrolled to where the person was. A file
 * whose changes were undone stays on screen, dimmed, as "no longer changed", and so does
 * everything of a worktree that was removed, until the person moves on.
 */
export function Preview() {
  const { checkoutPath, request, query } = useSelectedComparison();
  const file = useSelectedFile();
  const selection = useUi((state) => state.selectedFile);
  const removed = useScan(
    useCallback(
      (scan: ScanData) => checkoutPath !== null && checkoutPath in scan.removed,
      [checkoutPath],
    ),
  );
  const mode = useUi((state) => state.previewMode);
  const theme = useResolvedTheme();
  const review = useCachedReviewStatus(checkoutPath);
  const reviewed = file ? reviewFileOf(review, file.path) : undefined;
  const sinceViewedOn = useUi((state) => state.sinceViewed);
  const sinceViewed =
    sinceViewedOn &&
    reviewed?.state === "changedSinceViewed" &&
    reviewed.earlierAvailable !== false;
  const comparisonDiff = useFileDiff(
    checkoutPath,
    request,
    query.data,
    sinceViewed ? undefined : file,
  );
  const sinceDiff = useSinceViewedDiff(
    checkoutPath,
    sinceViewed ? file : undefined,
    sinceViewed ? reviewed?.viewedHash : undefined,
  );
  const diff = sinceViewed ? sinceDiff : comparisonDiff;
  const viewRef = useRef<DiffViewHandle>(null);
  const pendingAnchor = useRef<DiffAnchor | null>(null);
  /** Where the person last scrolled the diff to, for a live update to come back to. */
  const scrolledTo = useRef<DiffAnchor | null>(null);

  // What the preview is about: this file, in this comparison, of this checkout.
  const subject = subjectOf(checkoutPath, request, selection, sinceViewed);
  const fetched = diff.data !== undefined && !diff.isPlaceholderData ? diff.data : undefined;
  const lastShown = useRef<Shown | null>(null);
  /** The last diff shown for `subject`, kept for when its file is no longer listed. */
  const [kept, setKept] = useState<Shown | null>(null);
  const [updatedFor, setUpdatedFor] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (subject === null || fetched === undefined) return;
    const before = lastShown.current;
    if (before?.subject === subject && before.diff === fetched) return;
    const shown = { subject, diff: fetched };
    lastShown.current = shown;
    setKept(shown);
    if (before?.subject !== subject) {
      scrolledTo.current = null;
      return;
    }
    if (before.diff.resultHash === fetched.resultHash) return;
    // The same file, changed on disk or in Git: say so, and keep the person's place.
    setUpdatedFor(subject);
    const anchor = scrolledTo.current;
    if (anchor !== null) viewRef.current?.restoreAnchor(anchor);
  }, [subject, fetched]);
  const updated = updatedFor !== null && updatedFor === subject;
  const last = kept !== null && kept.subject === subject ? kept.diff : undefined;
  const noLongerChanged =
    file === undefined && last !== undefined && query.data !== undefined && !removed;
  /** What stays on screen, dimmed: the worktree is gone, or the file no longer changed. */
  const stale = removed || noLongerChanged ? (diff.data ?? last) : undefined;

  // The anchor is read before React re-renders: the store's listeners run synchronously
  // when the mode changes, while the old view is still on screen.
  useEffect(
    () =>
      uiStore.subscribe((state, previous) => {
        if (state.previewMode !== previous.previewMode) {
          pendingAnchor.current = viewRef.current?.getAnchor() ?? null;
        }
      }),
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mode change, after the new view mounted
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (anchor !== null) viewRef.current?.restoreAnchor(anchor);
  }, [mode]);

  const showLoading = useDelayed(diff.isFetching && diff.data === undefined, LOADING_DELAY_MS);

  return (
    <section aria-label="Preview" className="flex h-full min-h-0 flex-col" data-testid="preview">
      <PreviewHeader file={file} stats={(diff.data ?? last)?.stats} reviewed={reviewed} />
      {removed && (
        <LiveNote testId="preview-checkout-gone">
          This worktree no longer exists. What it showed last stays below until you select something
          else.
        </LiveNote>
      )}
      {noLongerChanged && (
        <LiveNote testId="preview-no-longer-changed">
          This file is no longer changed. Its last changes stay below, dimmed.
        </LiveNote>
      )}
      {sinceViewed && (
        <p
          className="shrink-0 border-border border-b bg-review-changed-surface px-3 py-1 text-review-changed text-xs"
          data-testid="since-viewed-note"
        >
          Since you viewed: only what changed after you marked this file Viewed.
        </p>
      )}
      <div
        className="relative min-h-0 flex-1"
        data-testid="preview-body"
        onScrollCapture={() => {
          scrolledTo.current = viewRef.current?.getAnchor() ?? scrolledTo.current;
        }}
      >
        {updated && !removed && (
          <span
            role="status"
            className="pointer-events-none absolute top-2 right-4 z-10 rounded-full border border-border bg-popover px-2 py-0.5 text-popover-foreground text-xs shadow-sm"
            data-testid="preview-updated"
          >
            Updated
          </span>
        )}
        {stale ? (
          <div className="h-full opacity-50" data-testid="preview-stale" aria-disabled="true">
            <DiffView
              ref={viewRef}
              diff={stale}
              mode={mode}
              theme={theme}
              contextLines={DEFAULT_CONTEXT_LINES}
            />
          </div>
        ) : file === undefined ? (
          <Message>
            {checkoutPath
              ? "Select a file to see its changes."
              : "Select a Git folder, then a file, to see its changes."}
          </Message>
        ) : diff.data ? (
          <DiffView
            ref={viewRef}
            diff={diff.data}
            mode={mode}
            theme={theme}
            contextLines={DEFAULT_CONTEXT_LINES}
            {...(reviewed ? { onRequestNextFile: () => runCommand("file.markViewedAndNext") } : {})}
          />
        ) : diff.isError ? (
          <Message tone="error">
            {isIpcFailure(diff.error)
              ? diff.error.message
              : "This file's changes could not be read."}
          </Message>
        ) : showLoading ? (
          <Message>Loading diff…</Message>
        ) : null}
      </div>
    </section>
  );
}

interface Shown {
  subject: string;
  diff: FileDiff;
}

/** One key for "this file in this comparison of this checkout", or `null` with nothing selected. */
function subjectOf(
  checkoutPath: string | null,
  request: ComparisonRequest | null,
  selection: FileSelection | null,
  sinceViewed: boolean,
): string | null {
  if (checkoutPath === null || request === null || selection === null) return null;
  return JSON.stringify([
    checkoutPath,
    request.kind,
    request.ref ?? null,
    request.startOverride ?? null,
    selection.path,
    selection.category ?? null,
    sinceViewed,
  ]);
}

/** A line above the diff about what live refresh found. */
function LiveNote({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      role="status"
      className="shrink-0 border-border border-b bg-review-changed-surface px-3 py-1 text-review-changed text-xs"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

function Message({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <p
      className={
        tone === "error" ? "p-6 text-destructive text-sm" : "p-6 text-muted-foreground text-sm"
      }
      data-testid="preview-message"
    >
      {children}
    </p>
  );
}

/** `value`, but `true` only once it has stayed true for `delayMs`. */
function useDelayed(value: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!value) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value && delayed;
}
