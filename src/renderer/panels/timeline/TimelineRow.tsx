import { forwardRef } from "react";
import { type Checkout, isKnownStart, type TimelineEntry } from "../../../shared/domain/scan";
import {
  quantity,
  relationLabel,
  relativePath,
  repositoryName,
  type ScanData,
  uncommittedCount,
} from "../../data/scan-model";
import { compactDate, fullDate } from "../../lib/format";
import { cn } from "../../lib/utils";

/**
 * One timeline event (the prototype's compact row): its number, repository and observed
 * time; the folder; its relation to the previous checkout of the same repository; counts.
 */
export const TimelineRow = forwardRef<
  HTMLDivElement,
  {
    scan: ScanData;
    entry: TimelineEntry;
    checkout: Checkout;
    selected: boolean;
    onSelect: () => void;
    id: string;
  }
>(function TimelineRow({ scan, entry, checkout, selected, onSelect, id }, ref) {
  const start = checkout.start;
  const relation = relationLabel(scan, entry);
  const folder = relativePath(scan.scanRoot, checkout.path);
  const uncommitted = uncommittedCount(checkout);
  const repo = repositoryName(scan, checkout.path);
  const counts = checkout.history
    ? `${quantity(checkout.history.commits, "commit")} · ${quantity(checkout.history.files, "file")}`
    : "Start unknown";

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: the listbox holds focus and points at the active row with aria-activedescendant
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard for every row
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${entry.sequence}. ${repo}, ${folder}. ${relation}. ${counts}${uncommitted > 0 ? `, ${quantity(uncommitted, "uncommitted file")}` : ""}`}
      data-checkout-path={checkout.path}
      data-sequence={entry.sequence}
      onClick={onSelect}
      className={cn(
        "mx-2 my-1 cursor-default rounded-lg border px-2.5 py-2 text-xs",
        selected
          ? "border-selection-border bg-selection text-selection-foreground"
          : "border-border bg-card hover:bg-hover",
      )}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-step font-bold text-[10px] text-step-foreground">
          {entry.sequence}
        </span>
        <span className="truncate font-bold text-repo uppercase tracking-wide">{repo}</span>
        {isKnownStart(start) ? (
          <time
            className="ml-auto shrink-0"
            dateTime={start.observedAt}
            title={fullDate(start.observedAt)}
          >
            {compactDate(start.observedAt)}
          </time>
        ) : (
          <span className="ml-auto shrink-0">Unknown</span>
        )}
      </div>
      <p className="mt-1 break-all font-semibold text-foreground" data-testid="timeline-folder">
        {folder}
      </p>
      <div className="mt-0.5 flex items-baseline gap-2 text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={relation} data-testid="timeline-relation">
          {relation}
        </span>
        <span className="shrink-0 font-semibold text-primary-strong">{counts}</span>
      </div>
      {uncommitted > 0 && (
        <p className="mt-0.5 text-status-unstaged">{quantity(uncommitted, "uncommitted file")}</p>
      )}
    </div>
  );
});
