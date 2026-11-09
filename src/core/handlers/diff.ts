import { coreCalls, err, ok } from "../../shared/ipc";
import { isIpcError } from "../compare/kinds";
import { buildFileDiff } from "../diff/file-diff";
import type { Session } from "../sessions/session";
import { failWith } from "./errors";

/**
 * `diff.file {requestId, checkoutPath, comparison, path, category?}`: the checkout must be
 * one of the session's scan (`notInScan` otherwise). Answers with the file's `FileDiff`,
 * built from the comparison's own list (`buildFileDiff`); cancelling the request kills its
 * git processes through the handler's signal.
 */
export function registerDiffHandlers(session: Session): void {
  session.rpc.onCall(coreCalls["diff.file"], async (_ctx, request, signal) => {
    const scanned = await session.findCheckout(request.checkoutPath);
    if (!scanned) return err("notInScan", "That checkout is not in this window's scan.");
    try {
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
          comparison: request.comparison,
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
