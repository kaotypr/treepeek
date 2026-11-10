import type { ReviewStatus } from "../../shared/domain/review";
import { coreCalls, err, ok } from "../../shared/ipc";
import { isIpcError } from "../compare/kinds";
import { announceMarks, reviewContext, scheduleStatusForScan } from "../review/background";
import { markAll, markFiles } from "../review/mark";
import { computeStatus } from "../review/status";
import type { Session, SessionServices } from "../sessions/session";
import { failWith } from "./errors";

const NO_STORE = "The local store is not available, so review marks cannot be read or kept.";
const NOT_IN_SCAN = "That checkout is not in this window's scan.";

/**
 * The review channels (review-marks design): `review.status`, `review.mark`,
 * `review.markAll`, `review.storeUsage` and `review.clearAll`. A checkout must be one of
 * the session's scan (`notInScan` otherwise). A change to marks reaches every other window
 * showing the checkout as `review.changed`.
 */
export function registerReviewHandlers(session: Session, services: SessionServices): void {
  const { rpc } = session;

  rpc.onCall(coreCalls["review.status"], async (_ctx, request, signal) => {
    const store = services.store();
    if (!store) return err("internal", NO_STORE);
    const scanned = await Promise.all(
      request.checkoutPaths.map((path) => session.findCheckout(path)),
    );
    try {
      const statuses: ReviewStatus[] = [];
      for (const item of scanned) {
        if (!item) return err("notInScan", NOT_IN_SCAN);
        const status = await computeStatus(reviewContext(session, item, store, signal));
        if (isIpcError(status)) return err(status.code, status.message, status.detail);
        statuses.push(status);
      }
      return ok(statuses);
    } catch (error) {
      return failWith(error);
    }
  });

  rpc.onCall(coreCalls["review.mark"], async (_ctx, request, signal) => {
    const scanned = await session.findCheckout(request.checkoutPath);
    if (!scanned) return err("notInScan", NOT_IN_SCAN);
    const store = services.store();
    if (!store) return err("internal", NO_STORE);
    try {
      const status = await markFiles(reviewContext(session, scanned, store, signal), {
        paths: request.paths,
        viewed: request.viewed,
        ...(request.resultHashes === undefined ? {} : { resultHashes: request.resultHashes }),
      });
      if (isIpcError(status)) return err(status.code, status.message, status.detail);
      session.log.info("review marks changed", {
        checkoutPath: scanned.checkout.path,
        files: request.paths.length,
        viewed: request.viewed,
        restored: request.resultHashes !== undefined,
      });
      announceMarks(services, session, scanned.checkout.path);
      return ok(status);
    } catch (error) {
      return failWith(error);
    }
  });

  rpc.onCall(coreCalls["review.markAll"], async (_ctx, request, signal) => {
    const scanned = await session.findCheckout(request.checkoutPath);
    if (!scanned) return err("notInScan", NOT_IN_SCAN);
    const store = services.store();
    if (!store) return err("internal", NO_STORE);
    try {
      const result = await markAll(reviewContext(session, scanned, store, signal), request.viewed);
      if (isIpcError(result)) return err(result.code, result.message, result.detail);
      session.log.info(request.viewed ? "marked all as reviewed" : "unmarked all", {
        checkoutPath: scanned.checkout.path,
        changed: result.previous.length,
      });
      announceMarks(services, session, scanned.checkout.path);
      return ok(result);
    } catch (error) {
      return failWith(error);
    }
  });

  rpc.onCall(coreCalls["review.storeUsage"], () => {
    const store = services.store();
    if (!store) return err("internal", NO_STORE);
    try {
      return ok(store.snapshotUsage());
    } catch (error) {
      return failWith(error);
    }
  });

  rpc.onCall(coreCalls["review.clearAll"], () => {
    const store = services.store();
    if (!store) return err("internal", NO_STORE);
    try {
      store.clearReviewData();
    } catch (error) {
      return failWith(error);
    }
    session.log.info("cleared review data");
    // Every window's progress starts over.
    for (const other of services.sessions()) {
      if (!other.closed) void scheduleStatusForScan(other, services);
    }
    return ok({});
  });
}
