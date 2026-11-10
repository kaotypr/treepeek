import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef } from "react";
import { reviewProgress } from "../../../shared/domain/review";
import {
  TIMELINE_GROUPINGS,
  TIMELINE_ORDERS,
  type TimelineGrouping,
  type TimelineOrder,
} from "../../../shared/settings";
import { CloseIcon } from "../../components/icons";
import { useCachedReviewStatuses } from "../../data/hooks/useReviewStatus";
import { useScan } from "../../data/hooks/useScan";
import { quantity, type ScanData } from "../../data/scan-model";
import { uiStore, useUi } from "../../state/ui-store";
import { TimelineRow } from "./TimelineRow";
import { groupTimeline } from "./timeline-groups";

const GROUPING_LABEL: Readonly<Record<TimelineGrouping, string>> = {
  all: "All repositories",
  repository: "Group by repository",
  folder: "Group by folder",
};

const ORDER_LABEL: Readonly<Record<TimelineOrder, string>> = {
  oldest: "Oldest first",
  newest: "Newest first",
};

/** The known limits, stated the way the prototype stated them. */
export const TIMELINE_LIMITS =
  "Ordered by each worktree’s first retained HEAD reflog entry, which cannot prove when it was created once entries expire. “After” compares with the previous worktree’s current HEAD, which may have moved since. Worktrees of different repositories are ordered by time only; there is no diff between them.";

/**
 * The timeline panel (⌘T): every checkout as a numbered event, grouped and ordered as
 * chosen, with its review progress. The header counts the worktrees reviewed, and "Hide
 * reviewed" leaves out those at 100%. Selecting an event selects its checkout and reveals
 * it in the navigator.
 */
export function TimelinePanel() {
  const grouping = useUi((state) => state.timelineGrouping);
  const order = useUi((state) => state.timelineOrder);
  const setGrouping = useUi((state) => state.setTimelineGrouping);
  const setOrder = useUi((state) => state.setTimelineOrder);
  const setOpen = useUi((state) => state.setTimelineOpen);
  const selected = useUi((state) => state.selectedCheckout);
  const hideReviewed = useUi((state) => state.hideReviewed);
  const setHideReviewed = useUi((state) => state.setHideReviewed);
  const scan = useScan(useCallback((data: ScanData) => data, []));
  const paths = useMemo(() => scan.timeline.map((entry) => entry.checkoutPath), [scan.timeline]);
  const statuses = useCachedReviewStatuses(paths);
  const reviews = useMemo(
    () => new Map(paths.map((path, index) => [path, statuses[index]])),
    [paths, statuses],
  );
  const reviewed = new Set(
    paths.filter((path) => {
      const status = reviews.get(path);
      return status !== undefined && reviewProgress(status).reviewed;
    }),
  );
  const groups = groupTimeline(scan, grouping, order)
    .map((group) => ({
      ...group,
      entries: hideReviewed
        ? group.entries.filter((entry) => !reviewed.has(entry.checkoutPath))
        : group.entries,
    }))
    .filter((group) => group.entries.length > 0);
  const flat = groups.flatMap((group) => group.entries);
  const listId = useId();
  const groupingId = useId();
  const orderId = useId();
  const rows = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (selected) rows.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const select = (path: string) => uiStore.getState().selectCheckout(path, { reveal: true });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = flat.findIndex((entry) => entry.checkoutPath === selected);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : index + 1;
    else if (event.key === "ArrowUp") next = index < 0 ? flat.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = flat.length - 1;
    if (next === null) return;
    event.preventDefault();
    const entry = flat[Math.max(0, Math.min(flat.length - 1, next))];
    if (entry) select(entry.checkoutPath);
  };

  const selectedIndex = flat.findIndex((entry) => entry.checkoutPath === selected);

  return (
    <aside
      aria-label="Worktree timeline"
      className="flex h-full min-h-0 flex-col"
      data-testid="timeline"
    >
      <div className="border-border border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-semibold text-sm">Worktree timeline</h2>
          <span className="text-muted-foreground text-xs" data-testid="timeline-reviewed">
            {paths.length === 0
              ? quantity(0, "worktree")
              : `${reviewed.size} of ${quantity(paths.length, "worktree")} reviewed`}
          </span>
          <button
            type="button"
            aria-label="Close timeline"
            title="Close timeline (⌘T)"
            onClick={() => setOpen(false)}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CloseIcon className="size-3.5" />
          </button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label htmlFor={groupingId} className="font-medium text-muted-foreground text-[11px]">
            Show
            <select
              id={groupingId}
              value={grouping}
              onChange={(event) => setGrouping(event.target.value as TimelineGrouping)}
              className="mt-0.5 block h-6 w-full rounded-md border border-input bg-card px-1 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="timeline-grouping"
            >
              {TIMELINE_GROUPINGS.map((value) => (
                <option key={value} value={value}>
                  {GROUPING_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={orderId} className="font-medium text-muted-foreground text-[11px]">
            Order
            <select
              id={orderId}
              value={order}
              onChange={(event) => setOrder(event.target.value as TimelineOrder)}
              className="mt-0.5 block h-6 w-full rounded-md border border-input bg-card px-1 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="timeline-order"
            >
              {TIMELINE_ORDERS.map((value) => (
                <option key={value} value={value}>
                  {ORDER_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-2 flex items-center gap-1.5 text-muted-foreground text-xs">
          <input
            type="checkbox"
            checked={hideReviewed}
            onChange={(event) => setHideReviewed(event.target.checked)}
            className="size-3 accent-review-viewed"
            data-testid="hide-reviewed"
          />
          Hide reviewed
        </label>
      </div>
      <div
        role="listbox"
        aria-label="Worktrees in timeline order"
        tabIndex={0}
        aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        data-testid="timeline-list"
      >
        {flat.length === 0 ? (
          <p className="p-3 text-muted-foreground text-xs">
            {scan.phase !== "done"
              ? "The timeline appears once the scan is done."
              : hideReviewed && paths.length > 0
                ? "Every worktree is reviewed."
                : "No worktrees to show."}
          </p>
        ) : (
          groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a group of listbox options, not a form
            <div key={group.key} role="group" aria-label={group.title ?? "All repositories"}>
              {group.title !== null && (
                <div
                  className="flex items-baseline gap-2 px-3 pt-3 pb-1 font-bold text-[11px] text-muted-foreground uppercase tracking-widest"
                  data-testid="timeline-group"
                >
                  <span className="min-w-0 flex-1 truncate">{group.title}</span>
                  <span className="font-medium normal-case tracking-normal">
                    {quantity(group.entries.length, "checkout")}
                  </span>
                </div>
              )}
              {group.entries.map((entry) => {
                const checkout = scan.checkouts[entry.checkoutPath];
                if (!checkout) return null;
                const index = flat.indexOf(entry);
                return (
                  <TimelineRow
                    key={entry.checkoutPath}
                    ref={(element) => {
                      if (element) rows.current.set(entry.checkoutPath, element);
                      else rows.current.delete(entry.checkoutPath);
                    }}
                    id={`${listId}-${index}`}
                    scan={scan}
                    entry={entry}
                    checkout={checkout}
                    review={reviews.get(entry.checkoutPath)}
                    selected={entry.checkoutPath === selected}
                    onSelect={() => select(entry.checkoutPath)}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
      <p
        className="border-border border-t px-3 py-2 text-[11px] text-muted-foreground leading-snug"
        data-testid="timeline-limits"
      >
        {TIMELINE_LIMITS}
      </p>
    </aside>
  );
}
