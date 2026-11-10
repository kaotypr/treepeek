/**
 * What changed in a checkout. Cache invalidation uses these kinds, and live refresh reports
 * them to the renderer (`refresh.checkout`), which maps each kind to the queries it
 * invalidates.
 *
 * - `head`: HEAD moved (commit, checkout, reset).
 * - `index`: the staging area changed.
 * - `workingTree`: files on disk changed.
 * - `refs`: branches or tags changed.
 * - `reflog`: the HEAD reflog changed, so the start may have changed.
 * - `upstream`: the upstream ref or its position changed.
 * - `removed`: the checkout disappeared.
 * - `structure`: new checkouts or folders appeared.
 */
export type ChangeKind =
  | "head"
  | "index"
  | "workingTree"
  | "refs"
  | "reflog"
  | "upstream"
  | "removed"
  | "structure";

/** Every change kind, in the order the design lists them. */
export const CHANGE_KINDS: readonly ChangeKind[] = Object.freeze([
  "head",
  "index",
  "workingTree",
  "refs",
  "reflog",
  "upstream",
  "removed",
  "structure",
]);

/**
 * Why live refresh is not running somewhere:
 *
 * - `eventStorm`: so many files changed at once in a checkout that its working-tree refresh
 *   paused until the person refreshes;
 * - `watcherError`: no watcher could watch a folder, so nothing there refreshes on its own.
 */
export type RefreshPauseReason = "eventStorm" | "watcherError";

export const REFRESH_PAUSE_REASONS: readonly RefreshPauseReason[] = Object.freeze([
  "eventStorm",
  "watcherError",
]);

/** One place live refresh is not running. */
export interface RefreshPause {
  /** The checkout whose working tree paused, or the folder no watcher could watch. */
  path: string;
  reason: RefreshPauseReason;
  /** When it began, in milliseconds since the epoch. */
  since: number;
}
