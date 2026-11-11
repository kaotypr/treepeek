import { MAX_SCAN_DEPTH, SKIP_DIRS } from "../../shared/constants";
import type {
  Repository,
  ScanProblem,
  ScanRoot,
  TimelineEntry,
  WorktreeChoice,
} from "../../shared/domain/scan";
import type { WorktreeEntry } from "../git/parse/worktree-list";
import { asIpcError, GitError } from "../git/errors";
import type { ScanContext } from "./context";
import { isAncestor } from "./queries";
import { buildRepositories } from "./repositories";
import { resolveCheckout, type ScannedCheckout } from "./resolve-checkout";
import { buildTimeline } from "./timeline";
import { deriveCheckouts, validateCandidates } from "./validate";
import { type WalkResult, walk } from "./walk";

/** Everything one scan found. */
export interface ScanResult {
  /** Each scan root with its folder tree, in the session's order. */
  roots: ScanRoot[];
  /** Which checkouts the scan listed besides the walked ones. */
  worktrees: WorktreeChoice;
  /** In timeline order. */
  checkouts: ScannedCheckout[];
  timeline: TimelineEntry[];
  repositories: Repository[];
  problems: ScanProblem[];
  /**
   * The real paths of every checkout Git lists, inside a scan root or not, by common dir
   * (pruning forgets identities Git no longer lists).
   */
  listedCheckouts: ReadonlyMap<string, ReadonlySet<string>>;
  /** From the start of the walk to the end of the timeline. */
  durationMs: number;
}

/** One scan root's walk. */
export interface RootWalk extends WalkResult {
  /** The scan root: a real absolute path. */
  path: string;
}

/** Step 1: each root's folder tree and candidate checkouts, in the context's order. */
export async function walkScanRoots(ctx: ScanContext): Promise<RootWalk[]> {
  const walked: RootWalk[] = [];
  // One root at a time: each walk already reads many folders at once.
  for (const path of ctx.scanRoots) {
    const result = await walk(path, {
      maxDepth: MAX_SCAN_DEPTH,
      skip: SKIP_DIRS,
      signal: ctx.signal,
    });
    walked.push({ path, ...result });
  }
  return walked;
}

/** The candidates of every root's walk, each once. */
export function walkedCandidates(walked: readonly RootWalk[]): string[] {
  return [...new Set(walked.flatMap((root) => root.candidates))];
}

/** Each root's folder tree, as `scan.start` answers it. */
export function scanRootsOf(walked: readonly RootWalk[]): ScanRoot[] {
  return walked.map((root) => ({ path: root.path, folders: root.folders }));
}

/**
 * Steps 2 to 5 (git-service design, "The scan"): validates the walks' candidates, adds the
 * checkouts their repositories' worktree lists hold elsewhere (unless the session asked for
 * the walked ones only), resolves each checkout through the git queue and hands it to
 * `onCheckout` the moment it resolves, then builds one timeline and the repositories.
 * Repositories found from different roots merge by their common dir.
 *
 * A checkout that fails to resolve becomes a problem instead of failing the scan. Throws a
 * `cancelled` `GitError` when the scan's signal aborts.
 */
export async function resolveScan(
  ctx: ScanContext,
  walked: readonly RootWalk[],
  startedAt: number,
  onCheckout: (checkout: ScannedCheckout) => void,
): Promise<ScanResult> {
  const candidates = walkedCandidates(walked);
  const validation = await validateCandidates(candidates, ctx);
  const found = new Map<string, readonly WorktreeEntry[]>();
  for (const candidate of validation.valid) {
    const entries = validation.worktreeLists.get(candidate.commonDir);
    if (entries) found.set(candidate.commonDir, entries);
  }
  const derived = await deriveCheckouts(found, new Set(candidates), ctx);
  if (ctx.signal.aborted) throw cancelled();
  const problems = [...validation.problems, ...derived.problems];

  const resolved = await Promise.all(
    [...validation.valid, ...derived.valid].map(async (candidate) => {
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
    roots: scanRootsOf(walked),
    worktrees: ctx.worktrees,
    checkouts: ordered,
    timeline,
    repositories: buildRepositories(
      ordered.map((item) => ({ path: item.checkout.path, commonDir: item.commonDir })),
      validation.worktreeLists,
    ),
    problems: problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    listedCheckouts: validation.listed,
    durationMs: Date.now() - startedAt,
  };
}

export interface ScanEvents {
  /** Each root's folder tree, before any checkout. */
  onFolders?(walked: readonly RootWalk[]): void;
  onCheckout?(checkout: ScannedCheckout): void;
}

/** A whole scan in one call: walk, then resolve (tools and tests). */
export async function runScan(ctx: ScanContext, events: ScanEvents = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const walked = await walkScanRoots(ctx);
  events.onFolders?.(walked);
  return resolveScan(ctx, walked, startedAt, (checkout) => events.onCheckout?.(checkout));
}

function cancelled(): GitError {
  return new GitError("cancelled", "The scan was cancelled.");
}
