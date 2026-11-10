import { MAX_SCAN_DEPTH } from "../../shared/constants";
import { coreCalls, coreEvents, err, ok } from "../../shared/ipc";
import { requireGit } from "../git/runtime";
import { scheduleStatusForScan } from "../review/background";
import { pruneAfterScan } from "../review/prune";
import { checkScanRoot } from "../scan/root";
import type { ScanResult } from "../scan/scan";
import type { WalkResult } from "../scan/walk";
import type { ScanRun, Session, SessionServices } from "../sessions/session";
import { failWith } from "./errors";
import { scanRootError } from "./session";

/**
 * `scan.start {requestId}`: answers with the folder tree once the walk finishes. The rest
 * of the scan runs after that answer has been posted, so every `scan.checkout` and the
 * final `scan.done` reach the window after it. A newer `scan.start`, `request.cancel` with
 * this `requestId`, or the session closing stops the scan; a stopped scan sends no
 * `scan.done`.
 *
 * After `scan.done`, identities Git no longer lists are pruned, live refresh watches what
 * the scan found (in place of what the session's previous scan held), and every checkout's
 * review status is computed in the background and sent as `review.changed`.
 */
export function registerScanHandlers(session: Session, services: SessionServices): void {
  session.rpc.onCall(coreCalls["scan.start"], async (ctx, _request, signal) => {
    const scanRoot = session.scanRoot;
    if (scanRoot === null) {
      return err("invalidRequest", "Open the session with a scan root before scanning.");
    }
    // The folder may have become unreadable since the session opened (a rescan).
    const root = await checkScanRoot(scanRoot);
    if (!root.ok) return scanRootError(root.problem);
    let run: ScanRun;
    let walked: WalkResult;
    try {
      await requireGit();
      run = session.startScan(signal);
      walked = await run.walk();
    } catch (error) {
      return failWith(error);
    }
    ctx.afterReply(async () => {
      const result = await run.resolve(walked, (checkout) =>
        session.rpc.emit(coreEvents["scan.checkout"], checkout.checkout),
      );
      if (!result) return;
      session.log.info("scan finished", {
        scanRoot,
        checkouts: result.checkouts.length,
        problems: result.problems.length,
        durationMs: result.durationMs,
      });
      session.rpc.emit(coreEvents["scan.done"], {
        timeline: result.timeline,
        repositories: result.repositories,
        durationMs: result.durationMs,
        problems: result.problems,
      });
      prune(session, services, result);
      void services.live?.watchScan(session);
      void scheduleStatusForScan(session, services, result.checkouts);
    });
    return ok({ scanRoot, folders: walked.folders, depthLimit: MAX_SCAN_DEPTH });
  });
}

function prune(session: Session, services: SessionServices, result: ScanResult): void {
  const store = services.store();
  if (!store) return;
  try {
    const pruned = pruneAfterScan(store, result);
    if (pruned.worktrees > 0 || pruned.snapshots > 0) {
      session.log.info("pruned review data", pruned);
    }
  } catch (error) {
    session.log.warn("could not prune review data", { error });
  }
}
