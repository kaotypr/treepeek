import type { ChangeKind } from "../../shared/domain/change";
import type { FileChange } from "../../shared/domain/compare";
import type { RawEntry } from "../git/parse/raw-diff";
import type { ReflogEntry } from "../git/parse/reflog";
import type { StatusSummary } from "../git/parse/status-v2";
import type { WorktreeEntry } from "../git/parse/worktree-list";
import { Memo } from "./memo";

/**
 * How many commit-pair results each immutable cache keeps. They never go stale, so the
 * limits only bound memory; raw diffs are the largest values, so they get the fewest.
 */
export const IMMUTABLE_CACHE_LIMITS = Object.freeze({
  ancestry: 20_000,
  counts: 20_000,
  nameLists: 2_000,
  rawDiffs: 500,
});

/** The mutable caches, by what invalidates them. */
export type MutableCache = "worktreeList" | "start" | "status" | "comparison";

/**
 * The git-service design's cache table as change kinds. `removed` drops everything a
 * checkout has. Beyond the table:
 *
 * - the start also follows `head`, because it is the oldest reflog entry that is still an
 *   ancestor of HEAD;
 * - the status also follows `upstream`, because it carries ahead/behind counts.
 *
 * Commit-pair results are never invalidated: commit ancestry and content do not change.
 */
export const INVALIDATED_BY: Readonly<Record<MutableCache, readonly ChangeKind[]>> = Object.freeze({
  worktreeList: Object.freeze<ChangeKind[]>(["structure", "removed"]),
  start: Object.freeze<ChangeKind[]>(["reflog", "head", "removed"]),
  status: Object.freeze<ChangeKind[]>(["head", "index", "workingTree", "upstream", "removed"]),
  comparison: Object.freeze<ChangeKind[]>(["head", "index", "workingTree", "removed"]),
});

/** The key of a commit-pair result: `left..right`. */
export function pairKey(left: string, right: string): string {
  return `${left}..${right}`;
}

/** Results keyed by commit pairs: content-addressed, so cached without expiry. */
export interface ImmutableCaches {
  /** `merge-base --is-ancestor a b`, keyed `pairKey(a, b)`. */
  readonly ancestry: Memo<string, boolean>;
  /** `rev-list --count left..right`, keyed `pairKey(left, right)`. */
  readonly counts: Memo<string, number>;
  /** `diff --name-only -z left right`, keyed `pairKey(left, right)`. */
  readonly nameLists: Memo<string, readonly string[]>;
  /** `diff --raw … left right` between two commits, keyed `pairKey(left, right)`. */
  readonly rawDiffs: Memo<string, readonly RawEntry[]>;
}

/**
 * Cached git results for one repository (one common dir), shared by every session through
 * `CoreState` (git-service design, "Caching").
 *
 * Comparison file lists that involve the index or the working tree go in
 * `comparisons(checkoutPath)`, keyed by the comparison and its resolved commit sides
 * (`review:<start>`), so a changed start or ref is a different key rather than something
 * to invalidate. Comparisons between two commits belong in `immutable.rawDiffs`.
 */
export class RepoCache {
  readonly commonDir: string;
  readonly immutable: ImmutableCaches;
  /** Git's worktree list for the repository, keyed by `commonDir`. */
  readonly worktreeList = new Memo<string, readonly WorktreeEntry[]>();
  /** Each checkout's start from its reflog (or `null`), keyed by checkout path. */
  readonly starts = new Memo<string, ReflogEntry | null>();
  /** Each checkout's `status --porcelain=v2` summary, keyed by checkout path. */
  readonly statuses = new Memo<string, StatusSummary>();
  readonly #comparisons = new Map<string, Memo<string, readonly FileChange[]>>();

  constructor(commonDir: string, limits: Partial<typeof IMMUTABLE_CACHE_LIMITS> = {}) {
    this.commonDir = commonDir;
    const bound = { ...IMMUTABLE_CACHE_LIMITS, ...limits };
    this.immutable = {
      ancestry: new Memo(bound.ancestry),
      counts: new Memo(bound.counts),
      nameLists: new Memo(bound.nameLists),
      rawDiffs: new Memo(bound.rawDiffs),
    };
  }

  /** The comparison file lists of one checkout, keyed by comparison and resolved sides. */
  comparisons(checkoutPath: string): Memo<string, readonly FileChange[]> {
    let memo = this.#comparisons.get(checkoutPath);
    if (!memo) {
      memo = new Memo();
      this.#comparisons.set(checkoutPath, memo);
    }
    return memo;
  }

  /** Forgets what `kinds` of change in one checkout make stale (`INVALIDATED_BY`). */
  invalidate(checkoutPath: string, kinds: readonly ChangeKind[]): void {
    const hit = (cache: MutableCache) => INVALIDATED_BY[cache].some((kind) => kinds.includes(kind));
    if (hit("worktreeList")) this.worktreeList.clear();
    if (hit("start")) this.starts.delete(checkoutPath);
    if (hit("status")) this.statuses.delete(checkoutPath);
    if (kinds.includes("removed")) this.#comparisons.delete(checkoutPath);
    else if (hit("comparison")) this.#comparisons.get(checkoutPath)?.clear();
  }

  /** Forgets what `kinds` of change make stale, for every checkout of the repository. */
  invalidateRepository(kinds: readonly ChangeKind[]): void {
    const checkouts = new Set([
      ...this.starts.keys(),
      ...this.statuses.keys(),
      ...this.#comparisons.keys(),
    ]);
    if (INVALIDATED_BY.worktreeList.some((kind) => kinds.includes(kind))) this.worktreeList.clear();
    for (const checkoutPath of checkouts) this.invalidate(checkoutPath, kinds);
  }

  /** Forgets everything, the immutable results included. */
  clear(): void {
    this.worktreeList.clear();
    this.starts.clear();
    this.statuses.clear();
    this.#comparisons.clear();
    for (const memo of Object.values(this.immutable)) memo.clear();
  }
}
