import { coreEvents } from "../../shared/ipc";
import { isIpcError } from "../compare/kinds";
import { GitError } from "../git/errors";
import type { GitPriority } from "../git/queue";
import type { ScannedCheckout } from "../scan/resolve-checkout";
import type { Session, SessionServices } from "../sessions/session";
import type { ReviewStore } from "../store/review-store";
import { computeStatus, type ReviewContext } from "./status";

/**
 * Checkouts whose status is computed at once in the background. Few, so the low lane of
 * the git queue stays short and a checkout the person selects meanwhile, whose work runs in
 * the normal lane, is not kept waiting behind many others.
 */
const PARALLEL = 2;

/** What review work on one of a session's checkouts runs with. */
export function reviewContext(
  session: Session,
  scanned: ScannedCheckout,
  store: ReviewStore,
  signal: AbortSignal,
  priority?: GitPriority,
): ReviewContext {
  const { repo, checkout } = session.resourcesOf(scanned);
  return {
    checkout: scanned,
    repo,
    hashObject: checkout.hashObject,
    store,
    signal,
    ...(priority ? { priority } : {}),
  };
}

/**
 * Computes the review status of every checkout of the session's last scan in the
 * background, in the git queue's low lane, and sends each as `review.changed` the moment it
 * is known, so the rows fill in their progress after a scan without slowing the checkout
 * the person is looking at. A newer scan, the scan root changing, the session closing, or
 * this being called again stops it. Resolves once every status is sent or it stopped.
 */
export async function scheduleStatusForScan(
  session: Session,
  services: SessionServices,
  checkouts: readonly ScannedCheckout[] = session.lastScan?.checkouts ?? [],
): Promise<void> {
  const store = services.store();
  if (!store || checkouts.length === 0) return;
  const signal = session.startBackground();
  const startedAt = Date.now();
  let next = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) return;
      const scanned = checkouts[next];
      next += 1;
      if (!scanned) return;
      try {
        const status = await computeStatus(reviewContext(session, scanned, store, signal, "low"));
        if (signal.aborted) return;
        if (isIpcError(status)) {
          failed += 1;
          continue;
        }
        session.rpc.emit(coreEvents["review.changed"], status);
      } catch (error) {
        if (signal.aborted || (error instanceof GitError && error.code === "cancelled")) return;
        failed += 1;
        session.log.warn("could not compute a checkout's review status", {
          path: scanned.checkout.path,
          error,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (signal.aborted) return;
  session.log.info("review status computed", {
    checkouts: checkouts.length,
    failed,
    durationMs: Date.now() - startedAt,
  });
}

/**
 * After marks changed in one window: every other window whose scan shows the checkout gets
 * its status again, computed for its own view of the checkout (in the low lane).
 */
export function announceMarks(
  services: SessionServices,
  from: Session,
  checkoutPath: string,
): void {
  const store = services.store();
  if (!store) return;
  for (const session of services.sessions()) {
    if (session === from || session.closed) continue;
    const scanned = session.checkoutAt(checkoutPath);
    if (!scanned) continue;
    void (async () => {
      try {
        const signal = new AbortController().signal;
        const status = await computeStatus(reviewContext(session, scanned, store, signal, "low"));
        if (!isIpcError(status) && !session.closed) {
          session.rpc.emit(coreEvents["review.changed"], status);
        }
      } catch (error) {
        if (!session.closed) {
          session.log.warn("could not tell a window about changed marks", { checkoutPath, error });
        }
      }
    })();
  }
}
