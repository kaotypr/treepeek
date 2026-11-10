import type { ListableComparisonKind } from "../../shared/domain/compare";
import { type Checkout, isKnownStart, type TimelineEntry } from "../../shared/domain/scan";

/** Kinds whose left side is the start (or the comparison's own start override). */
export const START_KINDS: ReadonlySet<ListableComparisonKind> = new Set([
  "review",
  "worktree",
  "incoming",
  "sincePrevious",
]);

/**
 * Why a checkout cannot have a comparison kind, in the words the settings show; `null` when
 * it can. The core service decides in the end (it answers `refNotFound` with the reason);
 * this keeps the impossible kinds from being offered at all.
 */
export function unavailableReason(
  kind: ListableComparisonKind,
  checkout: Checkout,
  entry: TimelineEntry | undefined,
  options: { startOverride?: string | null } = {},
): string | null {
  const startKnown = isKnownStart(checkout.start) || !!options.startOverride;
  switch (kind) {
    case "review":
    case "working":
      return null;
    case "worktree":
      if (checkout.head === null) return "This checkout has no commits yet";
      return startKnown ? null : "The start of this worktree is unknown";
    case "incoming":
    case "sincePrevious":
      if (entry?.relation !== "after") return "No direct previous worktree";
      if (kind === "incoming" && !startKnown) return "The start of this worktree is unknown";
      return null;
    case "base":
      return checkout.head === null ? "This checkout has no commits yet" : null;
    case "upstream":
      return checkout.upstream === null ? "This branch has no upstream" : null;
  }
}
