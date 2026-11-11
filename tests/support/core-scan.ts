/**
 * Runs the core service's scan in unit tests: a `ScanContext` over a `CoreState`, and the
 * expectations tests compare it with (Git's own worktree list, reflog starts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreState } from "../../src/core/cache/shared-state";
import type { ScanContext } from "../../src/core/scan/context";
import { outermostRoots } from "../../src/core/scan/roots";
import { runScan, type ScanResult } from "../../src/core/scan/scan";
import { openReviewStore } from "../../src/core/store/open-store";
import type { ReviewStore } from "../../src/core/store/review-store";
import type { WorktreeChoice } from "../../src/shared/domain/scan";
import { createLogger, type Logger } from "../../src/shared/log";
import { gitIn } from "./git";

/** A logger that writes nowhere. */
export function quietLogger(): Logger {
  return createLogger({ scope: "test", sink: () => undefined });
}

export interface ScanOptions {
  state?: CoreState;
  store?: ReviewStore | null;
  holder?: number;
  signal?: AbortSignal;
  /** Which checkouts to list besides the walked ones. Default `all`, as `session.open`. */
  worktrees?: WorktreeChoice;
}

/**
 * A scan context for `roots` (real paths, deduplicated and without nested roots as
 * `session.open` does), acquiring repositories from `state` as `holder`.
 */
export function scanContext(
  roots: string | readonly string[],
  options: ScanOptions = {},
): ScanContext {
  const state = options.state ?? new CoreState();
  const holder = options.holder ?? 1;
  return {
    scanRoots: outermostRoots(typeof roots === "string" ? [roots] : roots),
    worktrees: options.worktrees ?? "all",
    signal: options.signal ?? new AbortController().signal,
    store: options.store ?? null,
    repository: (commonDir) => state.acquireRepository(holder, commonDir),
    log: quietLogger(),
  };
}

/** Scans `roots` in one call. */
export function scan(
  roots: string | readonly string[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  return runScan(scanContext(roots, options));
}

/** Non-bare checkout paths Git lists for the repository in `cwd`, as Git prints them. */
export function gitWorktreePaths(cwd: string): string[] {
  const out = gitIn(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const paths: string[] = [];
  let path: string | null = null;
  let bare = false;
  for (const field of out.split("\0")) {
    if (field.startsWith("worktree ")) {
      path = field.slice("worktree ".length);
      bare = false;
    } else if (field === "bare") {
      bare = true;
    } else if (field === "" && path !== null) {
      if (!bare) paths.push(path);
      path = null;
    }
  }
  return paths;
}

/** The oldest HEAD reflog entry of a checkout, as `{commit, observedAt}` in UTC. */
export function oldestReflog(cwd: string): { commit: string; observedAt: string } | null {
  const out = gitIn(cwd, ["reflog", "show", "--date=iso-strict", "--format=%H %gd", "HEAD"]);
  const last = out.trim().split("\n").filter(Boolean).at(-1);
  if (!last) return null;
  const [commit = "", selector = ""] = last.split(" ");
  const date = selector.slice(selector.indexOf("{") + 1, -1);
  return { commit, observedAt: new Date(date).toISOString().replace(".000Z", "Z") };
}

/** A local store in a fresh temporary user data folder. */
export function tempStore(): {
  store: ReviewStore;
  userData: string;
  reopen(): ReviewStore;
  dispose(): void;
} {
  const userData = mkdtempSync(join(tmpdir(), "treepeek-store-"));
  let store = openReviewStore(userData);
  return {
    get store() {
      return store;
    },
    userData,
    reopen() {
      store.close();
      store = openReviewStore(userData);
      return store;
    },
    dispose() {
      try {
        store.close();
      } catch {
        // Already closed.
      }
      rmSync(userData, { recursive: true, force: true });
    },
  };
}
