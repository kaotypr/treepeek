import { coreCalls, err, ok } from "../../shared/ipc";
import { isIpcError } from "../compare/kinds";
import { buildFileDiff } from "../diff/file-diff";
import { reviewContext } from "../review/background";
import { sinceViewedDiff } from "../review/since-viewed";
import type { Session, SessionServices } from "../sessions/session";
import { failWith } from "./errors";

/**
 * `diff.file {requestId, checkoutPath, comparison, path, category?}`: the checkout must be
 * one of the session's scan (`notInScan` otherwise). Answers with the file's `FileDiff`,
 * built from the comparison's own list (`buildFileDiff`); cancelling the request kills its
 * git processes through the handler's signal. `sinceViewed` compares the version a file's
 * review mark says was viewed with the file now (`sinceViewedDiff`).
 */
export function registerDiffHandlers(session: Session, services: SessionServices): void {
  session.rpc.onCall(coreCalls["diff.file"], async (_ctx, request, signal) => {
    const scanned = await session.findCheckout(request.checkoutPath);
    if (!scanned) return err("notInScan", "That checkout is not in this window's scan.");
    const { kind } = request.comparison;
    try {
      if (kind === "sinceViewed") {
        const { ref, startOverride } = request.comparison;
        if (ref !== undefined || startOverride !== undefined || request.category !== undefined) {
          return err("invalidRequest", "Since you viewed takes no ref, start or category.");
        }
        const store = services.store();
        if (!store) return err("internal", "The local store is not available.");
        const result = await sinceViewedDiff(
          reviewContext(session, scanned, store, signal),
          request.path,
        );
        if (isIpcError(result)) return err(result.code, result.message, result.detail);
        return ok(result);
      }
      const { repo, checkout } = session.resourcesOf(scanned);
      const result = await buildFileDiff(
        {
          checkout: scanned,
          predecessor: await session.predecessorOf(scanned),
          repo,
          hashObject: checkout.hashObject,
          signal,
        },
        {
          comparison: { ...request.comparison, kind },
          path: request.path,
          ...(request.category === undefined ? {} : { category: request.category }),
        },
      );
      if (isIpcError(result)) return err(result.code, result.message, result.detail);
      return ok(result);
    } catch (error) {
      return failWith(error);
    }
  });
}
