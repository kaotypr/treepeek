import { coreCalls, err, ok } from "../../shared/ipc";
import { isIpcError } from "../compare/kinds";
import { listComparison } from "../compare/list";
import type { Session } from "../sessions/session";
import { failWith } from "./errors";

/**
 * `comparison.list {checkoutPath, kind, ref?, startOverride?}`: the checkout must be one
 * of the session's scan (`notInScan` otherwise). Answers with the comparison's sides and
 * files, or the reason the checkout cannot have that kind (`listComparison`).
 */
export function registerCompareHandlers(session: Session): void {
  session.rpc.onCall(coreCalls["comparison.list"], async (_ctx, request, signal) => {
    const scanned = await session.findCheckout(request.checkoutPath);
    if (!scanned) return err("notInScan", "That checkout is not in this window's scan.");
    try {
      const { repo, checkout } = session.resourcesOf(scanned);
      const result = await listComparison(
        {
          checkout: scanned,
          predecessor: await session.predecessorOf(scanned),
          repo,
          hashObject: checkout.hashObject,
          signal,
        },
        request,
      );
      if (isIpcError(result)) return err(result.code, result.message, result.detail);
      return ok(result);
    } catch (error) {
      return failWith(error);
    }
  });
}
