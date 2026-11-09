/**
 * What changed in a checkout. Cache invalidation uses these kinds now; live refresh reports
 * them to the renderer later, which maps each kind to the queries it invalidates.
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
