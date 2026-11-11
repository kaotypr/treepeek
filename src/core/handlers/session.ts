import { isAbsolute } from "node:path";
import type { ScanRootProblem } from "../../shared/domain/scan";
import { coreCalls, err, ok, type Result } from "../../shared/ipc";
import { requireGit } from "../git/runtime";
import { checkScanRoots } from "../scan/roots";
import type { Session } from "../sessions/session";
import { failWith } from "./errors";

const ROOT_MESSAGES: Readonly<Record<ScanRootProblem, string>> = {
  missing: "The scan root does not exist.",
  notAFolder: "The scan root is not a folder.",
  unreadable: "Treepeek is not allowed to read this folder.",
};

/**
 * The `invalidRequest` for a folder that cannot be scanned: `detail.scanRoot` says why,
 * and `detail.path` names the root, as the session was given it.
 */
export function scanRootError(problem: ScanRootProblem, path: string): Result<never> {
  return err("invalidRequest", ROOT_MESSAGES[problem], { scanRoot: problem, path });
}

/**
 * `session.open {scanRoots, worktrees?}`: every root must be an absolute path to an
 * existing folder whose entries can be read; otherwise `invalidRequest` names the first
 * that is not (`scanRootError`). The roots are kept as real paths, each once, without a
 * root that lies inside another (`checkScanRoots`); `worktrees` defaults to `all`. Fails
 * `gitNotFound` or `gitTooOld` while no usable git is found, so the window can show the
 * setup screen.
 */
export function registerSessionHandlers(session: Session): void {
  session.rpc.onCall(coreCalls["session.open"], async (_ctx, request) => {
    for (const path of request.scanRoots) {
      if (!isAbsolute(path) || path.includes("\0")) {
        return err("invalidRequest", "The scan root must be an absolute path.", { path });
      }
    }
    const checked = await checkScanRoots(request.scanRoots);
    if (!checked.ok) return scanRootError(checked.problem, checked.path);
    const worktrees = request.worktrees ?? "all";
    try {
      const git = await requireGit();
      const sessionId = session.open(checked.roots, worktrees);
      session.log.info("session scan roots set", { scanRoots: checked.roots, worktrees });
      return ok({ sessionId, gitVersion: git.version });
    } catch (error) {
      return failWith(error);
    }
  });
}
