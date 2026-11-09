import { coreCalls, err, ok } from "../../shared/ipc";
import { resolveUserRef } from "../git/refs";
import type { Session, SessionServices } from "../sessions/session";
import { failWith } from "./errors";

/**
 * `start.override {checkoutPath, commit}`: resolves the commit-ish to a commit
 * (`refNotFound` when it names none), stores it for the checkout's worktree identity, or
 * clears it with `null`, and answers with the checkout's new start and history.
 */
export function registerStartHandlers(session: Session, services: SessionServices): void {
  session.rpc.onCall(coreCalls["start.override"], async (_ctx, request, signal) => {
    const scanned = await session.findCheckout(request.checkoutPath);
    if (!scanned) return err("notInScan", "That checkout is not in this window's scan.");
    const store = services.store();
    if (!store) return err("internal", "The local store is not available.");
    try {
      const commit =
        request.commit === null
          ? null
          : await resolveUserRef(scanned.checkout.path, request.commit, signal);
      store.setStartOverride(scanned.worktreeId, commit);
      const updated = await session.refreshStart(scanned, signal);
      session.log.info("start override changed", {
        checkoutPath: scanned.checkout.path,
        cleared: commit === null,
      });
      return ok(updated.checkout);
    } catch (error) {
      return failWith(error);
    }
  });
}
