import { useCallback } from "react";
import { type Checkout, isKnownStart } from "../../../shared/domain/scan";
import { BranchIcon } from "../../components/icons";
import { useScan } from "../../data/hooks/useScan";
import {
  quantity,
  repositoryName,
  repositoryNeighbours,
  type ScanData,
  timelineEntry,
  uncommittedCount,
} from "../../data/scan-model";
import { compactDate, fullDate, shortCommit } from "../../lib/format";
import { uiStore, useUi } from "../../state/ui-store";
import { ComparisonPopover } from "./ComparisonPopover";
import { OpenInMenu } from "./OpenInMenu";
import { ReviewProgress } from "./ReviewProgress";
import { StartOverrideDialog } from "./StartOverrideDialog";

const linkButton =
  "rounded-sm text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The selected checkout: repository and branch (with comparison settings), where it was
 * first seen from, its counts, its review progress (with the partial-scope note when no
 * start is known), and the previous and next checkout of the same repository.
 */
export function CheckoutDetails({ checkout }: { checkout: Checkout }) {
  const settingStart = useUi((state) => state.startDialogOpen);
  const setSettingStart = useUi((state) => state.setStartDialogOpen);
  const details = useScan(
    useCallback(
      (scan: ScanData) => ({
        repository: repositoryName(scan, checkout.path),
        entry: timelineEntry(scan, checkout.path),
        neighbours: repositoryNeighbours(scan, checkout.path),
        removed: checkout.path in scan.removed,
      }),
      [checkout.path],
    ),
  );
  const start = checkout.start;
  const uncommitted = uncommittedCount(checkout);
  const branch =
    checkout.branch ??
    (checkout.head ? `detached at ${shortCommit(checkout.head)}` : "no commits yet");

  return (
    <section
      aria-label="Checkout details"
      className="flex flex-col gap-1 border-border border-b px-3 py-2.5 text-xs"
      data-testid="checkout-details"
    >
      <div className="flex items-center gap-1.5">
        <span
          className="truncate font-semibold text-repo uppercase tracking-wide"
          data-testid="checkout-repository"
        >
          {details.repository}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <BranchIcon className="size-3 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={branch}
          data-testid="checkout-branch"
        >
          <span className="sr-only">Branch </span>
          {branch}
        </span>
        <ComparisonPopover checkout={checkout} entry={details.entry} />
      </div>

      {details.removed && (
        <p
          role="status"
          className="rounded-md bg-review-changed-surface px-2 py-1 text-review-changed"
          data-testid="checkout-gone"
        >
          This worktree no longer exists.
        </p>
      )}

      <p className="text-muted-foreground" data-testid="checkout-start">
        {isKnownStart(start) ? (
          <>
            First seen{" "}
            <time
              dateTime={start.observedAt}
              title={fullDate(start.observedAt)}
              className="text-foreground"
            >
              {compactDate(start.observedAt)}
            </time>{" "}
            from{" "}
            <code
              className="font-mono text-foreground"
              title={start.commit}
              data-testid="checkout-start-commit"
            >
              {shortCommit(start.commit)}
            </code>
            {start.source === "override" && (
              <span data-testid="checkout-start-override"> (set by you)</span>
            )}{" "}
            ·{" "}
            <button type="button" className={linkButton} onClick={() => setSettingStart(true)}>
              Change…
            </button>
          </>
        ) : (
          <>
            First seen time unknown ·{" "}
            <button type="button" className={linkButton} onClick={() => setSettingStart(true)}>
              Set start…
            </button>
          </>
        )}
      </p>

      <p data-testid="checkout-counts">
        {checkout.history ? (
          <>
            {quantity(checkout.history.commits, "commit")} ·{" "}
            {quantity(checkout.history.files, "file")} changed
          </>
        ) : (
          <span className="text-muted-foreground">Commits and files unknown</span>
        )}
        {uncommitted > 0 && (
          <span className="text-status-unstaged" data-testid="checkout-uncommitted">
            {" "}
            · +{quantity(uncommitted, "uncommitted file")}
          </span>
        )}
      </p>

      <ReviewProgress checkoutPath={checkout.path} />

      {!isKnownStart(start) && (
        <p
          className="rounded-md bg-review-changed-surface px-2 py-1 text-review-changed"
          data-testid="partial-scope-note"
        >
          Showing uncommitted changes only: where this worktree started is unknown.{" "}
          <button type="button" className={linkButton} onClick={() => setSettingStart(true)}>
            Set start…
          </button>
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <OpenInMenu />
        <div className="ml-auto flex gap-1">
          <NeighbourButton
            label="← Previous event"
            shortcut="⌘["
            target={details.neighbours.previous}
            testId="previous-event"
          />
          <NeighbourButton
            label="Next event →"
            shortcut="⌘]"
            target={details.neighbours.next}
            testId="next-event"
          />
        </div>
      </div>

      <StartOverrideDialog checkout={checkout} open={settingStart} onOpenChange={setSettingStart} />
    </section>
  );
}

function NeighbourButton({
  label,
  shortcut,
  target,
  testId,
}: {
  label: string;
  shortcut: string;
  target: string | null;
  testId: string;
}) {
  return (
    <button
      type="button"
      disabled={target === null}
      title={`${label.replace(/[←→]/g, "").trim()} in this repository (${shortcut})`}
      onClick={() => target && uiStore.getState().selectCheckout(target, { reveal: true })}
      className="rounded-md border border-input bg-card px-2 py-0.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      data-testid={testId}
    >
      {label}
    </button>
  );
}
