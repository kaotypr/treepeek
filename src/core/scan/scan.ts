import { MAX_SCAN_DEPTH, SKIP_DIRS } from "../../shared/constants";
import type { FolderNode, Repository, ScanProblem, TimelineEntry } from "../../shared/domain/scan";
import { asIpcError, GitError } from "../git/errors";
import type { ScanContext } from "./context";
import { isAncestor } from "./queries";
import { buildRepositories } from "./repositories";
import { resolveCheckout, type ScannedCheckout } from "./resolve-checkout";
import { buildTimeline } from "./timeline";
import { validateCandidates } from "./validate";
import { type WalkResult, walk } from "./walk";

/** Everything one scan found. */
export interface ScanResult {
  scanRoot: string;
  folders: FolderNode[];
  /** In timeline order. */
  checkouts: ScannedCheckout[];
  timeline: TimelineEntry[];
  repositories: Repository[];
  problems: ScanProblem[];
  /**
   * The real paths of every checkout Git lists, inside the scan root or not, by common dir
   * (pruning forgets identities Git no longer lists).
   */
  listedCheckouts: ReadonlyMap<string, ReadonlySet<string>>;
  /** From the start of the walk to the end of the timeline. */
  durationMs: number;
}

/** Step 1: the folder tree and the candidate checkouts. */
export function walkScanRoot(ctx: ScanContext): Promise<WalkResult> {
  return walk(ctx.scanRoot, { maxDepth: MAX_SCAN_DEPTH, skip: SKIP_DIRS, signal: ctx.signal });
}

/**
 * Steps 2 to 5 (git-service design, "The scan"): validates the walk's candidates, resolves
 * each checkout through the git queue and hands it to `onCheckout` the moment it resolves,
 * then builds the timeline and the repositories.
 *
 * A checkout that fails to resolve becomes a problem instead of failing the scan. Throws a
 * `cancelled` `GitError` when the scan's signal aborts.
 */
export async function resolveScan(
  ctx: ScanContext,
  walked: WalkResult,
  startedAt: number,
  onCheckout: (checkout: ScannedCheckout) => void,
): Promise<ScanResult> {
  const { valid, problems, worktreeLists, listed } = await validateCandidates(
    walked.candidates,
    ctx,
  );

  const resolved = await Promise.all(
    valid.map(async (candidate) => {
      try {
        const scanned = await resolveCheckout(candidate, ctx);
        if (!ctx.signal.aborted) onCheckout(scanned);
        return scanned;
      } catch (error) {
        if (ctx.signal.aborted) throw cancelled();
        const ipc = asIpcError(error);
        ctx.log.warn("could not resolve a checkout", { path: candidate.path, error });
        problems.push({ path: candidate.path, code: ipc.code, message: ipc.message });
        return null;
      }
    }),
  );
  if (ctx.signal.aborted) throw cancelled();
  const scanned = resolved.filter((item): item is ScannedCheckout => item !== null);

  const byPath = new Map(scanned.map((item) => [item.checkout.path, item]));
  const timeline = await buildTimeline(
    scanned.map((item) => ({
      checkoutPath: item.checkout.path,
      commonDir: item.commonDir,
      relativePath: item.relativePath,
      start: item.checkout.start,
      head: item.checkout.head,
    })),
    (commonDir, ancestor, descendant) =>
      isAncestor(ctx.repository(commonDir), ancestor, descendant, { signal: ctx.signal }).catch(
        (error: unknown) => {
          if (ctx.signal.aborted) throw cancelled();
          ctx.log.warn("could not check a timeline relation", { commonDir, error });
          return false;
        },
      ),
  );
  if (ctx.signal.aborted) throw cancelled();

  const ordered = timeline.flatMap((entry) => {
    const item = byPath.get(entry.checkoutPath);
    return item ? [item] : [];
  });
  return {
    scanRoot: ctx.scanRoot,
    folders: walked.folders,
    checkouts: ordered,
    timeline,
    repositories: buildRepositories(
      ordered.map((item) => ({ path: item.checkout.path, commonDir: item.commonDir })),
      worktreeLists,
    ),
    problems: problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    listedCheckouts: listed,
    durationMs: Date.now() - startedAt,
  };
}

export interface ScanEvents {
  /** The folder tree, before any checkout. */
  onFolders?(walked: WalkResult): void;
  onCheckout?(checkout: ScannedCheckout): void;
}

/** A whole scan in one call: walk, then resolve (tools and tests). */
export async function runScan(ctx: ScanContext, events: ScanEvents = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const walked = await walkScanRoot(ctx);
  events.onFolders?.(walked);
  return resolveScan(ctx, walked, startedAt, (checkout) => events.onCheckout?.(checkout));
}

function cancelled(): GitError {
  return new GitError("cancelled", "The scan was cancelled.");
}
