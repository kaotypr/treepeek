import { join } from "node:path";
import { GIT_SCAN_TIMEOUT_MS } from "../../shared/constants";
import {
  type Checkout,
  type HistoryCounts,
  isKnownStart,
  type Start,
  type Upstream,
} from "../../shared/domain/scan";
import type { Logger } from "../../shared/log";
import type { RepositoryResources } from "../cache/shared-state";
import { fileStamp, filesStamp, revalidate } from "../cache/stamps";
import { GitError } from "../git/errors";
import { oldestReflogEntry, type ReflogEntry } from "../git/parse/reflog";
import { parseStatusV2, type StatusSummary } from "../git/parse/status-v2";
import { resolveIdentity, worktreeId } from "../store/identity";
import type { ReviewStore } from "../store/review-store";
import { type ScanContext, scanGit } from "./context";
import { changedPaths, commitCount, isAncestor } from "./queries";
import type { ValidCandidate } from "./validate";

/** A resolved checkout, with what the core service keeps about it beside the domain view. */
export interface ScannedCheckout {
  readonly checkout: Checkout;
  readonly commonDir: string;
  readonly gitDir: string;
  /** Path relative to the scan root, `/`-separated (`""` when it is the root). */
  readonly relativePath: string;
  /** The identity review marks and the start override attach to. */
  readonly worktreeId: string;
  /** The oldest HEAD reflog entry that is an ancestor of HEAD, or `null` (before overrides). */
  readonly reflogStart: ReflogEntry | null;
}

/**
 * Resolves one checkout (git-service design, "The scan", step 4): its status, origin URL,
 * start and history counts.
 *
 * - The status is read fresh on every scan: until live refresh watches the working tree,
 *   nothing else would tell the cache that a file changed. The checkout's comparison lists
 *   that involve the index or the working tree are dropped for the same reason.
 * - The reflog start is cached, and read again when `logs/HEAD` changes (a commit, a
 *   recreated worktree, an expiry); the origin URL likewise follows the config files.
 * - The start goes through `resolveIdentity`, so a stored override wins and an expired
 *   reflog falls back to the one earlier identity for the path.
 * - Ancestry and history counts are commit-pair questions, cached for good.
 */
export async function resolveCheckout(
  candidate: ValidCandidate,
  ctx: ScanContext,
): Promise<ScannedCheckout> {
  const { repo } = candidate;
  const { signal } = ctx;
  if (repo.cache.statuses.peek(candidate.path) !== undefined) {
    repo.cache.statuses.delete(candidate.path);
  }
  // Comparison lists that involve the index or the working tree go stale the same way, so
  // a scan never shows an old list for a checkout it has just read again.
  repo.cache.comparisons(candidate.path).clear();
  const [status, originUrl] = await Promise.all([
    readStatus(repo, candidate.path, signal),
    readOrigin(repo, candidate, signal),
  ]);
  const reflogStart = await readReflogStart(repo, candidate, status.head, ctx);
  const identity = identify(ctx.store, candidate, reflogStart, ctx.log, ctx.now?.());
  const history = await readHistory(repo, identity.start, status.head, signal, ctx.log);
  return {
    checkout: {
      path: candidate.path,
      kind: candidate.kind,
      branch: status.branch ?? null,
      head: status.head,
      upstream: upstreamOf(status),
      originUrl,
      start: identity.start,
      working: { staged: status.staged, unstaged: status.unstaged, untracked: status.untracked },
      history,
    },
    commonDir: candidate.commonDir,
    gitDir: candidate.gitDir,
    relativePath: candidate.relativePath,
    worktreeId: identity.worktreeId,
    reflogStart,
  };
}

export interface RestartContext {
  repo: RepositoryResources;
  store: ReviewStore | null;
  signal: AbortSignal;
  log: Logger;
  now?: Date;
}

/**
 * The checkout again after its start override changed: the start comes from the identity
 * once more (the override, or the reflog start when cleared) and the history counts follow
 * it. Everything else is kept as the scan found it.
 */
export async function refreshStart(
  scanned: ScannedCheckout,
  ctx: RestartContext,
): Promise<ScannedCheckout> {
  const candidate = { path: scanned.checkout.path, commonDir: scanned.commonDir };
  const identity = identify(ctx.store, candidate, scanned.reflogStart, ctx.log, ctx.now);
  const history = await readHistory(
    ctx.repo,
    identity.start,
    scanned.checkout.head,
    ctx.signal,
    ctx.log,
  );
  return {
    ...scanned,
    worktreeId: identity.worktreeId,
    checkout: { ...scanned.checkout, start: identity.start, history },
  };
}

/** `status --porcelain=v2 -z --branch --untracked-files=all --no-renames`, via the cache. */
export function readStatus(
  repo: RepositoryResources,
  checkoutPath: string,
  signal: AbortSignal,
): Promise<StatusSummary> {
  return repo.cache.statuses.get(
    checkoutPath,
    async (computeSignal) => {
      const output = await scanGit(
        checkoutPath,
        ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--no-renames"],
        computeSignal,
      );
      return parseStatusV2(output.stdout);
    },
    signal,
  );
}

/**
 * `remote get-url origin`; a repository without `origin` (exit 2) has none. Cached until
 * the repository's or the worktree's config file changes.
 */
async function readOrigin(
  repo: RepositoryResources,
  candidate: ValidCandidate,
  signal: AbortSignal,
): Promise<string | null> {
  const stamp = await filesStamp([
    join(candidate.commonDir, "config"),
    join(candidate.gitDir, "config.worktree"),
  ]);
  revalidate(repo.cache.origins, repo.cache.stamps.origins, candidate.path, stamp);
  return repo.cache.origins.get(
    candidate.path,
    async (computeSignal) => {
      const output = await scanGit(candidate.path, ["remote", "get-url", "origin"], computeSignal, {
        okExitCodes: [0, 2],
      });
      if (output.code !== 0) return null;
      const url = output.stdout.toString("utf8").replace(/\r?\n$/, "");
      return url === "" ? null : url;
    },
    signal,
  );
}

/**
 * The oldest HEAD reflog entry, kept only when it is an ancestor of HEAD (domain model,
 * Start). An unborn branch has none. A reflog Git cannot read (too large, say) counts as
 * none rather than hiding the checkout.
 */
async function readReflogStart(
  repo: RepositoryResources,
  candidate: ValidCandidate,
  head: string | null,
  ctx: ScanContext,
): Promise<ReflogEntry | null> {
  if (head === null) return null;
  try {
    const stamp = await fileStamp(join(candidate.gitDir, "logs", "HEAD"));
    revalidate(repo.cache.starts, repo.cache.stamps.starts, candidate.path, stamp);
    const oldest = await repo.cache.starts.get(
      candidate.path,
      async (computeSignal) => {
        const output = await scanGit(
          candidate.path,
          ["reflog", "show", "--date=iso-strict", "--format=%H%x09%gd", "-z", "HEAD"],
          computeSignal,
        );
        return oldestReflogEntry(output.stdout);
      },
      ctx.signal,
    );
    if (!oldest) return null;
    return (await isAncestor(repo, oldest.commit, head, { signal: ctx.signal })) ? oldest : null;
  } catch (error) {
    if (ctx.signal.aborted || isCancelled(error)) throw error;
    ctx.log.warn("could not read a checkout's reflog start", { path: candidate.path, error });
    return null;
  }
}

/** The identity and start; without a usable store, the reflog start alone. */
function identify(
  store: ReviewStore | null,
  candidate: { path: string; commonDir: string },
  reflogStart: ReflogEntry | null,
  log: Logger,
  now?: Date,
): { worktreeId: string; start: Start } {
  const input = { commonDir: candidate.commonDir, checkoutPath: candidate.path, reflogStart };
  if (store) {
    try {
      return resolveIdentity(store, input, now);
    } catch (error) {
      log.error("the local store failed; using the reflog start", { path: candidate.path, error });
    }
  }
  return {
    worktreeId: worktreeId(candidate.commonDir, candidate.path, reflogStart?.commit ?? null),
    start: reflogStart ? { ...reflogStart, source: "reflog" } : { unknown: true },
  };
}

/** Commits and files from the start to HEAD; `null` without a start or a HEAD. */
async function readHistory(
  repo: RepositoryResources,
  start: Start,
  head: string | null,
  signal: AbortSignal,
  log: Logger,
): Promise<HistoryCounts | null> {
  if (!isKnownStart(start) || head === null) return null;
  const options = { signal, timeoutMs: GIT_SCAN_TIMEOUT_MS };
  try {
    const [commits, paths] = await Promise.all([
      commitCount(repo, start.commit, head, options),
      changedPaths(repo, start.commit, head, options),
    ]);
    return { commits, files: paths.length };
  } catch (error) {
    if (signal.aborted || isCancelled(error)) throw error;
    log.warn("could not count a checkout's history", { head, start: start.commit, error });
    return null;
  }
}

function upstreamOf(status: StatusSummary): Upstream | null {
  // Without ahead/behind the upstream is gone: there is nothing to compare with.
  if (status.upstream === undefined || status.ahead === undefined || status.behind === undefined) {
    return null;
  }
  return { ref: status.upstream, ahead: status.ahead, behind: status.behind };
}

function isCancelled(error: unknown): boolean {
  return error instanceof GitError && error.code === "cancelled";
}
