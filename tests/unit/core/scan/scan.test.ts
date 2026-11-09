import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CoreState } from "../../../../src/core/cache/shared-state";
import { spawnCount } from "../../../../src/core/git/process";
import type { ScanResult } from "../../../../src/core/scan/scan";
import { isKnownStart } from "../../../../src/shared/domain/scan";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { gitWorktreePaths, oldestReflog, scan, tempStore } from "../../../support/core-scan";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

/**
 * One scan folder holding most of what a scan must get right: a main checkout with linked
 * worktrees (one made from another's branch), a bare repository with a worktree, a detached
 * HEAD, stale `.git` files, and repositories the walk must not reach.
 */
let fx: Fixture;
let elsewhere: Fixture;
let app: FixtureRepo;
let featureA: FixtureCheckout;
let featureB: FixtureCheckout;
let svc: FixtureRepo;
let svcMain: FixtureCheckout;
let lib: FixtureRepo;
let libDetached: FixtureCheckout;
let deep7: FixtureRepo;
let result: ScanResult;
const states: CoreState[] = [];

function coreState(): CoreState {
  const state = new CoreState();
  states.push(state);
  return state;
}

beforeAll(async () => {
  setTestGit();
  fx = fixture();
  elsewhere = fixture();
  app = fx.repo("app").commit({ "README.md": "hello\n" });
  featureA = app.worktree("work/feature-a", { from: "main" });
  featureA.commit({ "a.txt": "a\n" }).commit({ "a.txt": "a2\n", "b.txt": "b\n" });
  featureB = app.worktree("work/feature-b", { from: "feature-a", branch: "feature-b" });
  // Main moves on after feature-a began, so feature-a is parallel to it.
  app.commit({ "README.md": "hello again\n" });

  svc = fx.repo("svc").commit({ "x.txt": "x\n" }).bare();
  svcMain = svc.worktree("svc-main", { from: "main" });

  lib = fx.repo("lib").commit({ "l.txt": "l\n" });
  libDetached = lib.worktree("lib-detached", { from: "HEAD", detach: true });

  deep7 = fx.repo("e1/e2/e3/e4/e5/e6/e7").commit({ "deep.txt": "7\n" });
  fx.repo("d1/d2/d3/d4/d5/d6/d7/d8").commit({ "deeper.txt": "8\n" });
  fx.repo("node_modules/dep").commit({ "dep.txt": "d\n" });
  fx.repo("tools/build/inner").commit({ "inner.txt": "i\n" });

  app.staleGitFile("stale/dangling");
  app.staleGitFile("stale/copied", { kind: "copied" });

  const outsideRepo = elsewhere.repo("ext").commit({ "ext.txt": "e\n" });
  symlinkSync(outsideRepo.path, fx.path("ext-link"));
  symlinkSync(app.path, fx.path("app-alias"));

  result = await scan(fx.root, { state: coreState() });
});

afterEach(() => {
  for (const state of states.splice(0)) state.close();
});

afterAll(() => {
  fx.cleanup();
  elsewhere.cleanup();
  resetGitRuntime();
});

const paths = (scanResult: ScanResult) => scanResult.checkouts.map((item) => item.checkout.path);
const checkout = (scanResult: ScanResult, path: string) => {
  const found = scanResult.checkouts.find((item) => item.checkout.path === path);
  if (!found) throw new Error(`no checkout at ${path}`);
  return found.checkout;
};

describe("scan", () => {
  it("finds exactly the checkouts Git lists under the root that the walk can reach", () => {
    const expected = [app, svc, lib, deep7]
      .flatMap((repo) => gitWorktreePaths(repo.isBare ? repo.commonDir : repo.path))
      .filter((path) => path.startsWith(`${fx.root}/`));
    expect(new Set(paths(result))).toEqual(new Set(expected));
    expect(result.problems).toEqual([]);
  });

  it("ignores stale .git files: a dangling one and a copied one Git does not list", () => {
    const found = paths(result);
    expect(found).not.toContain(fx.path("stale/dangling"));
    expect(found).not.toContain(fx.path("stale/copied"));
    // The walk saw them as candidates; validation dropped them.
    const folder = result.folders.find((node) => node.relativePath === "stale/copied");
    expect(folder?.checkoutPath).toBe(fx.path("stale/copied"));
  });

  it("does not enter skip-listed folders, folders deeper than 7, or symlinks", () => {
    const relative = result.folders.map((node) => node.relativePath);
    expect(relative).toContain("e1/e2/e3/e4/e5/e6/e7");
    expect(relative).not.toContain("node_modules");
    expect(relative).not.toContain("node_modules/dep");
    expect(relative).toContain("tools");
    expect(relative).not.toContain("tools/build");
    expect(relative).toContain("d1/d2/d3/d4/d5/d6/d7");
    expect(relative).not.toContain("d1/d2/d3/d4/d5/d6/d7/d8");
    expect(relative).not.toContain("ext-link");
    expect(relative).not.toContain("app-alias");
    expect(paths(result)).toContain(deep7.path);
    for (const path of paths(result)) expect(path.startsWith(`${fx.root}/`)).toBe(true);
  });

  it("lists a bare repository's folder without entering its object store", () => {
    const relative = result.folders.map((node) => node.relativePath);
    expect(relative).toContain("svc.git");
    expect(relative.some((path) => path.startsWith("svc.git/"))).toBe(false);
  });

  it("builds the folder tree with depths, parents and the root", () => {
    const [root] = result.folders;
    expect(root).toEqual({
      name: fx.root.split("/").at(-1),
      relativePath: "",
      depth: 0,
      parent: null,
      checkoutPath: null,
    });
    expect(result.folders.find((node) => node.relativePath === "work/feature-a")).toEqual({
      name: "feature-a",
      relativePath: "work/feature-a",
      depth: 2,
      parent: "work",
      checkoutPath: featureA.path,
    });
  });

  it("takes the start from the oldest reflog entry, labelled as the reflog's", () => {
    for (const target of [app, featureA, featureB, svcMain, lib, libDetached]) {
      const found = checkout(result, target.path);
      expect(found.start).toEqual({ ...oldestReflog(target.path), source: "reflog" });
    }
    expect(checkout(result, featureB.path).start).toMatchObject({ commit: featureA.head() });
  });

  it("reads branch, HEAD, kind, working counts and history", () => {
    const a = checkout(result, featureA.path);
    expect(a).toMatchObject({
      kind: "linked",
      branch: "feature-a",
      head: featureA.head(),
      upstream: null,
      originUrl: null,
      working: { staged: 0, unstaged: 0, untracked: 0 },
      history: { commits: 2, files: 2 },
    });
    expect(checkout(result, app.path)).toMatchObject({ kind: "main", branch: "main" });
    expect(checkout(result, libDetached.path)).toMatchObject({ branch: null, kind: "linked" });
    expect(checkout(result, featureB.path).history).toEqual({ commits: 0, files: 0 });
  });

  it("orders and numbers the timeline by start, with first, after and parallel relations", () => {
    const sequence = result.timeline.map((entry) => entry.checkoutPath);
    expect(sequence).toEqual([
      app.path,
      featureA.path,
      featureB.path,
      svcMain.path,
      lib.path,
      libDetached.path,
      deep7.path,
    ]);
    expect(result.timeline.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const byPath = new Map(result.timeline.map((entry) => [entry.checkoutPath, entry]));
    expect(byPath.get(app.path)).toMatchObject({ relation: "first", predecessor: null });
    expect(byPath.get(featureA.path)).toMatchObject({
      relation: "parallel",
      predecessor: app.path,
    });
    expect(byPath.get(featureB.path)).toMatchObject({
      relation: "after",
      predecessor: featureA.path,
    });
    expect(byPath.get(svcMain.path)).toMatchObject({ relation: "first", predecessor: null });
    expect(byPath.get(libDetached.path)).toMatchObject({
      relation: "after",
      predecessor: lib.path,
    });
    expect(paths(result)).toEqual(sequence);
  });

  it("names repositories after the main checkout, and a bare one without .git", () => {
    const names = new Map(result.repositories.map((repo) => [repo.displayName, repo.checkouts]));
    expect(names.get("app")).toEqual([app.path, featureA.path, featureB.path]);
    expect(names.get("svc")).toEqual([svcMain.path]);
    expect(names.get("lib")).toEqual([lib.path, libDetached.path]);
    expect(names.get("e7")).toEqual([deep7.path]);
    expect(result.repositories.map((repo) => repo.commonDir)).toContain(svc.commonDir);
  });

  it("runs at least 50% fewer git processes when scanning an unchanged folder again", async () => {
    const state = coreState();
    const beforeFirst = spawnCount();
    const first = await scan(fx.root, { state });
    const firstCount = spawnCount() - beforeFirst;
    const beforeSecond = spawnCount();
    const second = await scan(fx.root, { state });
    const secondCount = spawnCount() - beforeSecond;
    expect(paths(second)).toEqual(paths(first));
    expect(second.timeline).toEqual(first.timeline);
    expect(secondCount).toBeLessThanOrEqual(firstCount / 2);
  });

  it("finds a worktree added after a scan even though the worktree list was cached", async () => {
    const local = fixture();
    try {
      const repo = local.repo("r").commit({ "a.txt": "1\n" });
      const state = coreState();
      expect(paths(await scan(local.root, { state }))).toEqual([repo.path]);
      const added = repo.worktree("r-new", { from: "main" });
      expect(paths(await scan(local.root, { state }))).toEqual([repo.path, added.path]);
    } finally {
      local.cleanup();
    }
  });

  it("sees new working-tree changes and a new start on a rescan", async () => {
    const local = fixture();
    try {
      const repo = local.repo("r").commit({ "a.txt": "1\n" });
      const wt = repo.worktree("r-wt", { from: "main" });
      const state = coreState();
      const before = checkout(await scan(local.root, { state }), wt.path);
      expect(before.working.untracked).toBe(0);
      wt.write({ "new.txt": "n\n" });
      repo.repoGit(["worktree", "remove", "--force", wt.path]);
      repo.commit({ "a.txt": "2\n" });
      const again = repo.worktree("r-wt", { from: "main", branch: "r-wt-2" });
      again.write({ "new.txt": "n\n" });
      const after = checkout(await scan(local.root, { state }), again.path);
      expect(after.working.untracked).toBe(1);
      expect(after.start).toMatchObject({ commit: repo.head() });
      expect(after.start).not.toEqual(before.start);
    } finally {
      local.cleanup();
    }
  });
});

describe("scan starts", () => {
  it("is unknown after the reflog expires, with no history", async () => {
    const local = fixture();
    try {
      const repo = local.repo("r").commit({ "a.txt": "1\n" });
      const wt = repo.worktree("r-wt", { from: "main" });
      wt.commit({ "b.txt": "2\n" });
      repo.expireReflog();
      const scanned = await scan(local.root, { state: coreState() });
      for (const path of [repo.path, wt.path]) {
        expect(checkout(scanned, path).start).toEqual({ unknown: true });
        expect(checkout(scanned, path).history).toBeNull();
      }
      // Unknown starts go last, ordered by relative path; nothing can be `after` them.
      expect(scanned.timeline.map((entry) => [entry.checkoutPath, entry.relation])).toEqual([
        [repo.path, "first"],
        [wt.path, "parallel"],
      ]);
    } finally {
      local.cleanup();
    }
  });

  it("is unknown when the oldest reflog entry is not an ancestor of HEAD", async () => {
    const local = fixture();
    try {
      const repo = local.repo("r").commit({ "a.txt": "1\n" });
      const wt = repo.worktree("r-wt", { from: "main" });
      wt.git(["switch", "--quiet", "--orphan", "fresh"], { records: true });
      wt.commit({ "c.txt": "3\n" });
      const scanned = await scan(local.root, { state: coreState() });
      expect(checkout(scanned, wt.path).start).toEqual({ unknown: true });
      expect(isKnownStart(checkout(scanned, repo.path).start)).toBe(true);
    } finally {
      local.cleanup();
    }
  });

  it("keeps the recorded start after the reflog expires, through the local store", async () => {
    const local = fixture();
    const stored = tempStore();
    try {
      const repo = local.repo("r").commit({ "a.txt": "1\n" });
      const wt = repo.worktree("r-wt", { from: "main" });
      const state = coreState();
      const first = await scan(local.root, { state, store: stored.store });
      const before = first.checkouts.find((item) => item.checkout.path === wt.path);
      repo.expireReflog();
      const second = await scan(local.root, { state, store: stored.store });
      const after = second.checkouts.find((item) => item.checkout.path === wt.path);
      expect(after?.worktreeId).toBe(before?.worktreeId);
      expect(after?.checkout.start).toEqual({
        commit: before?.reflogStart?.commit,
        observedAt: before?.reflogStart?.observedAt,
        source: "override",
      });
    } finally {
      stored.dispose();
      local.cleanup();
    }
  });

  it("uses a stored start override over the reflog start", async () => {
    const local = fixture();
    const stored = tempStore();
    try {
      const repo = local.repo("r").commit({ "a.txt": "1\n" }).commit({ "a.txt": "2\n" });
      const state = coreState();
      const first = await scan(local.root, { state, store: stored.store });
      const scanned = first.checkouts[0];
      if (!scanned) throw new Error("no checkout");
      const base = repo.rev("HEAD~1");
      stored.store.setStartOverride(scanned.worktreeId, base);
      const second = await scan(local.root, { state, store: stored.store });
      expect(checkout(second, repo.path).start).toMatchObject({
        commit: base,
        source: "override",
      });
      expect(checkout(second, repo.path).history).toEqual({ commits: 1, files: 1 });
    } finally {
      stored.dispose();
      local.cleanup();
    }
  });
});

describe("scan edge cases", () => {
  it("scans a root that is itself a checkout, and a repository without commits", async () => {
    const local = fixture();
    try {
      const repo = local.repo("r");
      const scanned = await scan(repo.path, { state: coreState() });
      expect(scanned.folders.map((node) => node.relativePath)).toEqual([""]);
      expect(checkout(scanned, repo.path)).toMatchObject({
        head: null,
        branch: "main",
        start: { unknown: true },
        history: null,
      });
      expect(scanned.repositories).toEqual([
        { commonDir: join(repo.path, ".git"), displayName: "r", checkouts: [repo.path] },
      ]);
    } finally {
      local.cleanup();
    }
  });

  it("reads paths with spaces, non-ASCII characters and newlines", async () => {
    const local = fixture();
    try {
      const repo = local.repo("ünïcode repo").commit({ "a.txt": "1\n" });
      const odd = repo.worktree("odd\nname", { from: "main", branch: "odd" });
      odd.write({ "new file.txt": "x\n" });
      const scanned = await scan(local.root, { state: coreState() });
      expect(paths(scanned)).toEqual([repo.path, odd.path]);
      expect(checkout(scanned, odd.path).working.untracked).toBe(1);
      expect(scanned.repositories[0]?.displayName).toBe("ünïcode repo");
    } finally {
      local.cleanup();
    }
  });

  it("stops with cancelled when its signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scan(fx.root, { state: coreState(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
