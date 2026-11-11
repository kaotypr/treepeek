import { GIT_SCAN_TIMEOUT_MS } from "../../shared/constants";
import type { WorktreeChoice } from "../../shared/domain/scan";
import type { Logger } from "../../shared/log";
import type { RepositoryResources } from "../cache/shared-state";
import { type GitOutput, type RunGitOptions, runGit } from "../git/run";
import type { ReviewStore } from "../store/review-store";

/** What one scan runs with. */
export interface ScanContext {
  /**
   * The real absolute paths being scanned, in the order the session gave them: each once,
   * and none inside another (`outermostRoots`).
   */
  readonly scanRoots: readonly string[];
  /** Which checkouts the scan lists besides the walked ones. */
  readonly worktrees: WorktreeChoice;
  /** Aborts the scan and kills its git processes. */
  readonly signal: AbortSignal;
  /**
   * The local store, for worktree identities and start overrides; `null` when it could not
   * be opened, in which case starts come from the reflog alone.
   */
  readonly store: ReviewStore | null;
  /**
   * The shared resources of the repository at `commonDir`, acquired for the session running
   * the scan (it releases them when they leave its scan or it closes).
   */
  repository(commonDir: string): RepositoryResources;
  readonly log: Logger;
  /** The clock identities are stamped with; tests pin it. */
  readonly now?: () => Date;
}

/** `runGit` with the scan's time limit (`GIT_SCAN_TIMEOUT_MS`). */
export function scanGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  options: Omit<RunGitOptions, "signal"> = {},
): Promise<GitOutput> {
  return runGit(cwd, args, { timeoutMs: GIT_SCAN_TIMEOUT_MS, ...options, signal });
}
