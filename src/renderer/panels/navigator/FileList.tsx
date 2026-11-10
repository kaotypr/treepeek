import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import type { FileChange, FileStatus } from "../../../shared/domain/compare";
import { COMPARISON_LABELS } from "../../../shared/domain/comparison-hints";
import type { FileReviewState } from "../../../shared/domain/review";
import { runCommand } from "../../commands/registry";
import { isIpcFailure } from "../../data/client";
import { useCachedReviewStatus, useMarkFiles } from "../../data/hooks/useReviewStatus";
import {
  matchesSelection,
  useSelectedComparison,
  useVisibleFiles,
} from "../../data/hooks/useSelection";
import { reviewFileOf } from "../../data/review-model";
import { quantity } from "../../data/scan-model";
import { cn } from "../../lib/utils";
import { uiStore, useUi } from "../../state/ui-store";

const ROW_HEIGHT = 26;

export const STATUS_LETTER: Readonly<Record<FileStatus, string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "U",
};

const STATUS_CLASS: Readonly<Record<FileStatus, string>> = {
  added: "text-status-added",
  modified: "text-status-modified",
  deleted: "text-status-deleted",
  renamed: "text-status-renamed",
  copied: "text-status-renamed",
  typeChanged: "text-status-modified",
  untracked: "text-status-untracked",
};

const CATEGORY_CLASS = {
  staged: "text-status-staged",
  unstaged: "text-status-unstaged",
  untracked: "text-status-untracked",
} as const;

export function fileLabel(file: FileChange): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

const VIEWED_LABEL: Readonly<Record<FileReviewState, string>> = {
  unviewed: "not viewed",
  viewed: "viewed",
  changedSinceViewed: "changed since viewed",
};

/**
 * The comparison's files: compact virtualized rows (a 5,000-file list scrolls like a short
 * one), the path ellipsized with the whole path on hover, the selected row wrapped. ↑ and ↓
 * move the selection; ⌘F filters.
 *
 * Each file of the review scope has a Viewed checkbox; a viewed file is dimmed, and one
 * that changed since it was viewed has an amber badge. "Hide viewed" leaves viewed files
 * out. The keyboard marks with V (the checkbox stays out of the tab order, as the list
 * holds focus).
 */
export function FileList() {
  const { query, request, checkoutPath } = useSelectedComparison();
  const files = useVisibleFiles();
  const total = query.data?.files.length ?? 0;
  const selection = useUi((state) => state.selectedFile);
  const filter = useUi((state) => state.fileFilter);
  const setFilter = useUi((state) => state.setFileFilter);
  const hideViewed = useUi((state) => state.hideViewed);
  const setHideViewed = useUi((state) => state.setHideViewed);
  const review = useCachedReviewStatus(checkoutPath);
  const mark = useMarkFiles();
  const filterFocusRequest = useUi((state) => state.filterFocusRequest);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (filterFocusRequest === 0) return;
    filterRef.current?.focus();
    filterRef.current?.select();
  }, [filterFocusRequest]);

  const selectedIndex = files.findIndex((file) => matchesSelection(file, selection));
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => {
      const file = files[index];
      return file ? `${file.category ?? ""}:${file.path}` : index;
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the selection only
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex]);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown") runCommand("file.next");
    else if (event.key === "ArrowUp") runCommand("file.previous");
    else if (event.key === "Home" || event.key === "End") {
      const file = event.key === "Home" ? files[0] : files[files.length - 1];
      if (file) uiStore.getState().selectFile(selectionOf(file));
    } else return;
    event.preventDefault();
  };

  const comparison = query.data;
  const activeId = selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-list">
      <div className="flex items-center gap-2 border-border border-b px-3 py-1.5">
        <input
          ref={filterRef}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              scrollRef.current?.focus();
              if (selectedIndex < 0) runCommand("file.next");
            } else if (event.key === "Escape" && filter !== "") {
              event.preventDefault();
              setFilter("");
            }
          }}
          placeholder="Filter files"
          aria-label="Filter files"
          aria-keyshortcuts="Meta+F"
          aria-controls={listId}
          spellCheck={false}
          autoComplete="off"
          className="h-6 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="file-filter"
        />
        <button
          type="button"
          aria-pressed={hideViewed}
          title="Hide files you marked Viewed"
          onClick={() => setHideViewed(!hideViewed)}
          className={cn(
            "h-6 shrink-0 rounded-md border border-input px-1.5 text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
            hideViewed ? "bg-selection text-selection-foreground" : "bg-card",
          )}
          data-testid="hide-viewed"
        >
          Hide viewed
        </button>
        <span
          className="shrink-0 text-muted-foreground text-xs"
          aria-live="polite"
          data-testid="file-count"
        >
          {(filter.trim() !== "" || hideViewed) && comparison
            ? `${files.length} of ${total}`
            : quantity(total, "file")}
        </span>
      </div>

      {comparison && (
        <p
          className="border-border border-b px-3 py-1 text-muted-foreground text-xs"
          data-testid="comparison-summary"
        >
          <span className="text-foreground">{request ? COMPARISON_LABELS[request.kind] : ""}</span>
          {comparison.commits !== undefined && <> · {quantity(comparison.commits, "commit")}</>}
          {comparison.contained === true && <> · already contained</>}
          {comparison.note && <span className="block">{comparison.note}</span>}
        </p>
      )}

      <div
        ref={scrollRef}
        id={listId}
        role="listbox"
        aria-label="Changed files"
        tabIndex={0}
        aria-activedescendant={activeId}
        onKeyDown={onListKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {request === null ? (
          <Empty>Enter a base branch or commit in the comparison settings.</Empty>
        ) : query.isPending ? (
          <Empty>Loading changes…</Empty>
        ) : query.isError ? (
          <Empty tone="error">
            {isIpcFailure(query.error) ? query.error.message : "The changes could not be listed."}
          </Empty>
        ) : files.length === 0 ? (
          <Empty>
            {total === 0
              ? "No changes in this comparison. Use comparison settings to choose another view."
              : "No files match the filter."}
          </Empty>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const file = files[item.index];
              if (!file) return null;
              const selected = item.index === selectedIndex;
              const label = fileLabel(file);
              const reviewed = reviewFileOf(review, file.path);
              const state = reviewed?.state;
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: the listbox holds focus and points at the active row with aria-activedescendant
                // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard for every row
                <div
                  key={item.key}
                  id={`${listId}-${item.index}`}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  role="option"
                  aria-selected={selected}
                  title={label}
                  data-path={file.path}
                  data-review={state}
                  onClick={() => uiStore.getState().selectFile(selectionOf(file))}
                  className={cn(
                    "absolute left-0 flex w-full cursor-default items-start gap-2 px-3 py-1 text-xs",
                    selected ? "bg-selection text-selection-foreground" : "hover:bg-hover",
                    !selected && state === "viewed" && "text-muted-foreground",
                  )}
                  style={{ top: item.start, minHeight: ROW_HEIGHT }}
                >
                  {state === undefined || checkoutPath === null ? (
                    <span aria-hidden="true" className="size-3 shrink-0" />
                  ) : (
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      checked={state === "viewed"}
                      aria-label={`Viewed: ${file.path}`}
                      title={state === "viewed" ? "Viewed (V)" : "Mark as viewed (V)"}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        mark.mutate({
                          checkoutPath,
                          paths: [file.path],
                          viewed: event.target.checked,
                        })
                      }
                      className="mt-px size-3 shrink-0 accent-review-viewed"
                      data-testid="viewed-checkbox"
                    />
                  )}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "w-3 shrink-0 text-center font-mono font-semibold",
                      STATUS_CLASS[file.status],
                    )}
                  >
                    {STATUS_LETTER[file.status]}
                  </span>
                  <span
                    className={cn("min-w-0 flex-1 font-mono", selected ? "break-all" : "truncate")}
                  >
                    {label}
                    <span className="sr-only">
                      , {file.status}
                      {state ? `, ${VIEWED_LABEL[state]}` : ""}
                      {file.category ? ", " : ""}
                    </span>
                  </span>
                  {state === "changedSinceViewed" && (
                    <span
                      aria-hidden="true"
                      title="Changed since you viewed it"
                      className="shrink-0 rounded-sm bg-review-changed-surface px-1 text-[10px] text-review-changed"
                      data-testid="changed-badge"
                    >
                      changed
                    </span>
                  )}
                  {file.category && (
                    <span
                      className={cn(
                        "shrink-0 text-[10px] uppercase tracking-wide",
                        CATEGORY_CLASS[file.category],
                      )}
                    >
                      {file.category}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function selectionOf(file: FileChange) {
  return { path: file.path, ...(file.category ? { category: file.category } : {}) };
}

function Empty({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <p
      className={cn("p-4 text-xs", tone === "error" ? "text-destructive" : "text-muted-foreground")}
    >
      {children}
    </p>
  );
}
