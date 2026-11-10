import { isAbsolute } from "node:path";
import type { ScanRootProblem } from "../../shared/domain/scan";
import { coreCalls, err, ok, type Result } from "../../shared/ipc";
import { requireGit } from "../git/runtime";
import { checkScanRoot } from "../scan/root";
import type { Session } from "../sessions/session";
import { failWith } from "./errors";

const ROOT_MESSAGES: Readonly<Record<ScanRootProblem, string>> = {
  missing: "The scan root does not exist.",
  notAFolder: "The scan root is not a folder.",
  unreadable: "Treepeek is not allowed to read this folder.",
};

/** The `invalidRequest` for a folder that cannot be scanned, with `detail.scanRoot`. */
export function scanRootError(problem: ScanRootProblem): Result<never> {
  return err("invalidRequest", ROOT_MESSAGES[problem], { scanRoot: problem });
}

/**
 * `session.open {scanRoot}`: the scan root must be an absolute path to an existing folder
 * whose entries can be read, and is kept as its real path; otherwise `invalidRequest` with
 * `detail.scanRoot` naming why. Fails `gitNotFound` or `gitTooOld` while no usable git is
 * found, so the window can show the setup screen.
 */
export function registerSessionHandlers(session: Session): void {
  session.rpc.onCall(coreCalls["session.open"], async (_ctx, request) => {
    if (!isAbsolute(request.scanRoot) || request.scanRoot.includes("\0")) {
      return err("invalidRequest", "The scan root must be an absolute path.");
    }
    const root = await checkScanRoot(request.scanRoot);
    if (!root.ok) return scanRootError(root.problem);
    const scanRoot = root.real;
    try {
      const git = await requireGit();
      const sessionId = session.open(scanRoot);
      session.log.info("session scan root set", { scanRoot });
      return ok({ sessionId, gitVersion: git.version });
    } catch (error) {
      return failWith(error);
    }
  });
}
