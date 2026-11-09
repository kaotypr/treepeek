import { afterEach, describe, expect, it } from "vitest";
import { INVALIDATED_BY, pairKey, RepoCache } from "../../../../src/core/cache/repo-cache";
import { parseStatusV2, type StatusSummary } from "../../../../src/core/git/parse/status-v2";
import { runGit } from "../../../../src/core/git/run";
import { CHANGE_KINDS, type ChangeKind } from "../../../../src/shared/domain/change";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { fixture } from "../../../support/git-fixture";

const A = "/repos/app";
const B = "/repos/app-feature";
const live = () => new AbortController().signal;

const status = (head: string): StatusSummary => ({
  head,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  unmerged: 0,
});

/** A cache with something stored in every map, for checkouts A and B. */
function filled(): RepoCache {
  const cache = new RepoCache("/repos/app/.git");
  cache.worktreeList.set(cache.commonDir, []);
  for (const path of [A, B]) {
    cache.starts.set(path, { commit: "s".repeat(40), observedAt: "2025-01-01T00:00:00Z" });
    cache.statuses.set(path, status("h".repeat(40)));
    cache.comparisons(path).set("review:s", []);
  }
  cache.immutable.ancestry.set(pairKey("a", "b"), true);
  cache.immutable.counts.set(pairKey("a", "b"), 3);
  cache.immutable.nameLists.set(pairKey("a", "b"), ["x"]);
  cache.immutable.rawDiffs.set(pairKey("a", "b"), []);
  return cache;
}

/** Which of A's caches survive, plus whether B and the commit-pair results do. */
function survivors(cache: RepoCache) {
  return {
    worktreeList: cache.worktreeList.has(cache.commonDir),
    start: cache.starts.has(A),
    status: cache.statuses.has(A),
    comparison: cache.comparisons(A).has("review:s"),
    otherCheckout:
      cache.starts.has(B) && cache.statuses.has(B) && cache.comparisons(B).has("review:s"),
    immutable:
      cache.immutable.ancestry.has(pairKey("a", "b")) &&
      cache.immutable.counts.has(pairKey("a", "b")) &&
      cache.immutable.nameLists.has(pairKey("a", "b")) &&
      cache.immutable.rawDiffs.has(pairKey("a", "b")),
  };
}

describe("RepoCache.invalidate", () => {
  it.each(CHANGE_KINDS)("follows the cache table for a %s change", (kind: ChangeKind) => {
    const cache = filled();
    cache.invalidate(A, [kind]);
    const kept = survivors(cache);
    expect(kept).toEqual({
      worktreeList: !INVALIDATED_BY.worktreeList.includes(kind),
      start: !INVALIDATED_BY.start.includes(kind),
      status: !INVALIDATED_BY.status.includes(kind),
      comparison: !INVALIDATED_BY.comparison.includes(kind),
      otherCheckout: true,
      immutable: true,
    });
  });

  it("matches the git-service design's table", () => {
    expect(INVALIDATED_BY.worktreeList).toEqual(["structure", "removed"]);
    expect(INVALIDATED_BY.start).toEqual(["reflog", "head", "removed"]);
    expect(INVALIDATED_BY.status).toEqual(["head", "index", "workingTree", "upstream", "removed"]);
    expect(INVALIDATED_BY.comparison).toEqual(["head", "index", "workingTree", "removed"]);
  });

  it("takes several kinds at once", () => {
    const cache = filled();
    cache.invalidate(A, ["reflog", "index"]);
    expect(survivors(cache)).toMatchObject({ start: false, status: false, comparison: false });
  });

  it("leaves everything alone for a refs change", () => {
    const cache = filled();
    cache.invalidate(A, ["refs"]);
    expect(Object.values(survivors(cache)).every(Boolean)).toBe(true);
  });
});

describe("RepoCache.invalidateRepository", () => {
  it("applies the kinds to every checkout and keeps commit-pair results", () => {
    const cache = filled();
    cache.invalidateRepository(["index"]);
    for (const path of [A, B]) {
      expect(cache.statuses.has(path)).toBe(false);
      expect(cache.comparisons(path).has("review:s")).toBe(false);
      expect(cache.starts.has(path)).toBe(true);
    }
    expect(cache.worktreeList.has(cache.commonDir)).toBe(true);
    expect(survivors(cache).immutable).toBe(true);
  });

  it("drops the worktree list on a structure change even with no checkout cached", () => {
    const cache = new RepoCache("/repos/app/.git");
    cache.worktreeList.set(cache.commonDir, []);
    cache.invalidateRepository(["structure"]);
    expect(cache.worktreeList.has(cache.commonDir)).toBe(false);
  });
});

describe("RepoCache with real git", () => {
  afterEach(() => resetGitRuntime());

  it("serves a cached status until an index change invalidates it", async () => {
    setTestGit();
    const fx = fixture();
    try {
      const app = fx.repo("app").commit({ "a.txt": "1\n" });
      const cache = new RepoCache(app.commonDir);
      let runs = 0;
      const readStatus = () =>
        cache.statuses.get(
          app.path,
          async (signal) => {
            runs += 1;
            const output = await runGit(
              app.path,
              [
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
                "--no-renames",
              ],
              { signal },
            );
            return parseStatusV2(output.stdout);
          },
          live(),
        );

      expect((await readStatus()).staged).toBe(0);
      app.write({ "new.txt": "n\n" }).stage(["new.txt"]);
      // Unchanged as far as the cache knows: no new git process, the stale answer.
      expect((await readStatus()).staged).toBe(0);
      expect(runs).toBe(1);

      cache.invalidate(app.path, ["index"]);
      expect((await readStatus()).staged).toBe(1);
      expect(runs).toBe(2);
    } finally {
      fx.cleanup();
    }
  });
});
