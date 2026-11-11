import { REVIEW_LIMITS } from "../../shared/constants";
import type { ScanResult } from "../scan/scan";
import { isWithin } from "../sessions/path-rule";
import { type ReviewStore, storeTime } from "../store/review-store";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  /** The snapshot store's cap. Default `REVIEW_LIMITS.storeCapBytes`. */
  capBytes?: number;
  /** The clock; tests pin it. */
  now?: Date;
}

/**
 * At startup (review-marks design, "Pruning"): snapshots no mark references go, then the
 * store is brought under its cap. Answers how many snapshots went.
 */
export function pruneOnStartup(store: ReviewStore, options: PruneOptions = {}): number {
  const unreferenced = store.deleteUnreferencedSnapshots();
  return unreferenced + store.pruneSnapshots(options.capBytes ?? REVIEW_LIMITS.storeCapBytes);
}

/**
 * After a scan (review-marks design, "Pruning"): an identity of a scanned repository whose
 * checkout the scan could have listed, but which Git's worktree list no longer holds, is
 * forgotten once it has not been seen for `REVIEW_LIMITS.pruneAfterDays` days, with its
 * marks, override and the snapshots that leaves unreferenced. The scan could have listed a
 * checkout under any of its roots, and anywhere when it lists outside worktrees
 * (`worktrees: "all"`): agent tools delete their worktrees themselves, so this is what
 * drops their marks. An identity elsewhere is left alone: it was only outside this scan,
 * not gone. Then the snapshot store is brought under its cap.
 */
export function pruneAfterScan(
  store: ReviewStore,
  scan: Pick<ScanResult, "roots" | "worktrees" | "listedCheckouts">,
  options: PruneOptions = {},
): { worktrees: number; snapshots: number } {
  const now = options.now ?? new Date();
  const olderThan = storeTime(new Date(now.getTime() - REVIEW_LIMITS.pruneAfterDays * DAY_MS));
  const anywhere = scan.worktrees === "all";
  const inScope = (path: string) =>
    anywhere || scan.roots.some((root) => isWithin(path, root.path));
  let worktrees = 0;
  for (const [commonDir, listed] of scan.listedCheckouts) {
    for (const row of store.listStaleWorktrees(commonDir, listed, olderThan)) {
      if (!inScope(row.checkoutPath)) continue;
      store.deleteWorktree(row.worktreeId);
      worktrees += 1;
    }
  }
  const snapshots = store.pruneSnapshots(options.capBytes ?? REVIEW_LIMITS.storeCapBytes);
  return { worktrees, snapshots };
}
