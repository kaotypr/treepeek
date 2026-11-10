import { type ReviewStatus, reviewProgress } from "../../shared/domain/review";
import { cn } from "../lib/utils";

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** What a ring says, for VoiceOver and the tooltip. */
export function progressLabel(status: ReviewStatus | undefined): string {
  if (!status) return "Review progress not known yet";
  const progress = reviewProgress(status);
  if (progress.empty) return "No changes";
  const changed = progress.changed ? `, ${status.changedSinceViewed} changed since viewed` : "";
  if (progress.reviewed) return `Reviewed, all ${status.total} files${changed}`;
  return `${status.viewed} of ${status.total} files reviewed, ${progress.percent}%${changed}`;
}

/**
 * A worktree's review progress in a row of the picker, the tree or the timeline: a small
 * ring that fills as files are viewed, a check mark at 100%, and an amber dot when a file
 * changed since it was viewed. A worktree without changes shows a dash.
 */
export function ProgressRing({
  status,
  className,
}: {
  status: ReviewStatus | undefined;
  className?: string;
}) {
  const label = progressLabel(status);
  const progress = status ? reviewProgress(status) : null;
  const percent = progress?.percent ?? 0;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "relative inline-flex size-3.5 shrink-0 items-center justify-center",
        className,
      )}
      data-testid="progress-ring"
      data-percent={progress ? percent : undefined}
      data-state={
        !progress
          ? "unknown"
          : progress.empty
            ? "empty"
            : progress.reviewed
              ? "reviewed"
              : "partial"
      }
      data-changed={progress?.changed ? "true" : undefined}
    >
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-3.5" aria-hidden="true">
        {progress?.reviewed ? (
          <>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2} className="fill-review-progress" />
            <path
              d="M4 7.2 6.1 9.3 10.2 4.9"
              fill="none"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="stroke-background"
            />
          </>
        ) : (
          <>
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className={progress?.empty ? "stroke-border" : "stroke-input"}
              strokeDasharray={progress?.empty ? "2 2" : undefined}
            />
            {percent > 0 && (
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                className="stroke-review-progress"
                strokeDasharray={`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              />
            )}
          </>
        )}
      </svg>
      {progress?.changed && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-review-changed ring-1 ring-background"
        />
      )}
    </span>
  );
}
