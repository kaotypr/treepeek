import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { coreCalls, err, ok } from "../../shared/ipc";
import { requireGit } from "../git/runtime";
import type { Session } from "../sessions/session";
import { failWith } from "./errors";

/**
 * `session.open {scanRoot}`: the scan root must be an absolute path to an existing folder,
 * and is kept as its real path. Fails `gitNotFound` or `gitTooOld` while no usable git is
 * found, so the window can show the setup screen.
 */
export function registerSessionHandlers(session: Session): void {
  session.rpc.onCall(coreCalls["session.open"], async (_ctx, request) => {
    if (!isAbsolute(request.scanRoot) || request.scanRoot.includes("\0")) {
      return err("invalidRequest", "The scan root must be an absolute path.");
    }
    let scanRoot: string;
    try {
      scanRoot = await realpath(request.scanRoot);
      if (!(await stat(scanRoot)).isDirectory()) {
        return err("invalidRequest", "The scan root is not a folder.");
      }
    } catch {
      return err("invalidRequest", "The scan root does not exist.");
    }
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
