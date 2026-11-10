import { reviewProgress } from "../../../shared/domain/review";
import { shortcutLabel } from "../../commands/keymap";
import { runCommand } from "../../commands/registry";
import { useReviewStatus } from "../../data/hooks/useReviewStatus";
import { quantity } from "../../data/scan-model";
import { useUndo } from "../../state/undo";

const button =
  "rounded-md border border-input bg-card px-2 py-0.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * The selected checkout's review progress: a bar with `32 / 40 files · 80%`, "Mark all as
 * reviewed" and "Unmark all" (each one action, undone with ⌘Z), and how many files changed
 * since they were viewed. A worktree without changes says so instead of 100%.
 */
export function ReviewProgress({ checkoutPath }: { checkoutPath: string }) {
  const query = useReviewStatus(checkoutPath);
  const status = query.data;
  // ⌘Z undoes the window's last "Mark all" or "Unmark all"; the button shows where it was.
  const canUndo = useUndo((state) => state.entries.at(-1)?.checkoutPath === checkoutPath);

  if (!status) {
    return (
      <p className="text-muted-foreground" data-testid="review-progress" data-state="loading">
        {query.isError ? "Review progress could not be read." : "Reading review progress…"}
      </p>
    );
  }
  const progress = reviewProgress(status);
  if (progress.empty) {
    return (
      <p className="text-muted-foreground" data-testid="review-progress" data-state="empty">
        No changes to review.
      </p>
    );
  }
  const marked = status.viewed + status.changedSinceViewed;
  return (
    <div
      className="mt-1 flex flex-col gap-1"
      data-testid="review-progress"
      data-state={progress.reviewed ? "reviewed" : "partial"}
    >
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label="Review progress"
          aria-valuemin={0}
          aria-valuemax={status.total}
          aria-valuenow={status.viewed}
          aria-valuetext={`${status.viewed} of ${status.total} files viewed`}
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted ring-1 ring-border"
        >
          <div
            className="h-full rounded-full bg-review-progress transition-[width]"
            style={{ width: `${(status.viewed * 100) / status.total}%` }}
          />
        </div>
        <span className="shrink-0 tabular-nums" data-testid="review-progress-text">
          {progress.reviewed && (
            <span aria-hidden="true" className="mr-1 text-review-viewed">
              ✓
            </span>
          )}
          {status.viewed} / {quantity(status.total, "file")} · {progress.percent}%
        </span>
      </div>
      {status.changedSinceViewed > 0 && (
        <p className="text-review-changed" data-testid="review-changed-count">
          {quantity(status.changedSinceViewed, "file")} changed since you viewed{" "}
          {status.changedSinceViewed === 1 ? "it" : "them"}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={button}
          disabled={progress.reviewed}
          onClick={() => runCommand("checkout.markAllReviewed")}
          data-testid="mark-all-reviewed"
        >
          Mark all as reviewed
        </button>
        <button
          type="button"
          className={button}
          disabled={marked === 0}
          onClick={() => runCommand("checkout.unmarkAll")}
          data-testid="unmark-all"
        >
          Unmark all
        </button>
        {canUndo && (
          <button
            type="button"
            className={button}
            title={`Undo (${shortcutLabel("review.undo") ?? "⌘Z"})`}
            onClick={() => runCommand("review.undo")}
            data-testid="undo-marks"
          >
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
