import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWatchIndex, classify } from "../../../../src/core/watch/classify";
import {
  isIgnored,
  parcelIgnore,
  targetKey,
  type WatchedScan,
  watchTargets,
} from "../../../../src/core/watch/targets";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

let fx: Fixture;
let repo: FixtureRepo;
let wtA: FixtureCheckout;
let wtB: FixtureCheckout;
let scan: WatchedScan;

beforeAll(() => {
  fx = fixture();
  repo = fx.repo("app").commit({ "a.txt": "a\n" });
  wtA = repo.worktree("wt-a", { from: "main" });
  wtB = repo.worktree("nested/wt-b", { from: "main" });
  scan = {
    scanRoot: fx.root,
    checkouts: [
      { path: repo.path, gitDir: repo.commonDir, commonDir: repo.commonDir },
      { path: wtA.path, gitDir: join(repo.commonDir, "worktrees/wt-a"), commonDir: repo.commonDir },
      { path: wtB.path, gitDir: join(repo.commonDir, "worktrees/wt-b"), commonDir: repo.commonDir },
    ],
  };
});
afterAll(() => fx.cleanup());

describe("watchTargets", () => {
  it("watches the root, the common dir and each working tree, once each", () => {
    const targets = watchTargets(scan);
    expect(targets.map((target) => [target.kind, target.path])).toEqual([
      ["root", fx.root],
      ["common", repo.commonDir],
      ["workingTree", repo.path],
      ["workingTree", wtA.path],
      ["workingTree", wtB.path],
    ]);
    expect(new Set(targets.map(targetKey)).size).toBe(targets.length);
  });

  it("gives a git dir outside its common dir a watch of its own", () => {
    const outside = fx.outsidePath("separate-git-dir");
    const targets = watchTargets({
      scanRoot: fx.root,
      checkouts: [{ path: repo.path, gitDir: outside, commonDir: repo.commonDir }],
    });
    expect(targets.map((target) => target.kind)).toEqual([
      "root",
      "common",
      "gitDir",
      "workingTree",
    ]);
  });

  it("leaves out .git, skip-listed folders, objects and what lies past the depth limit", () => {
    const [root, common, main] = watchTargets(scan);
    if (!root || !common || !main) throw new Error("missing targets");
    expect(isIgnored(main, join(repo.path, ".git/index"))).toBe(true);
    expect(isIgnored(main, join(repo.path, "node_modules/x/index.js"))).toBe(true);
    expect(isIgnored(main, join(repo.path, "src/dist/bundle.js"))).toBe(true);
    expect(isIgnored(main, join(repo.path, "src/a.ts"))).toBe(false);
    expect(isIgnored(common, join(repo.commonDir, "objects/ab/cdef"))).toBe(true);
    expect(isIgnored(common, join(repo.commonDir, "logs/refs/heads/main"))).toBe(true);
    expect(isIgnored(common, join(repo.commonDir, "refs/heads/main"))).toBe(false);
    expect(isIgnored(common, join(repo.commonDir, "worktrees/wt-a/index"))).toBe(false);
    // The root sees a `.git` appear, but nothing inside one.
    expect(isIgnored(root, join(fx.root, "new/.git"))).toBe(false);
    expect(isIgnored(root, join(fx.root, "app/.git/HEAD"))).toBe(true);
    expect(isIgnored(root, join(fx.root, "a/node_modules"))).toBe(true);
    expect(isIgnored(root, join(fx.root, "1/2/3/4/5/6/7/.git"))).toBe(false);
    expect(isIgnored(root, join(fx.root, "1/2/3/4/5/6/7/8/9"))).toBe(true);
  });

  it("gives FSEvents at most 8 paths to exclude, the rest as globs", () => {
    const main = watchTargets(scan).find((target) => target.kind === "workingTree");
    if (!main) throw new Error("no working tree");
    const ignore = parcelIgnore(main);
    expect(ignore.filter((entry) => entry.startsWith("/"))).toHaveLength(8);
    expect(ignore).toContain(`${repo.path}/.git`);
    expect(ignore.some((entry) => entry.includes("venv"))).toBe(true);
  });
});

describe("classify", () => {
  const at = (...parts: string[]) => join(...parts);

  it("maps a main checkout's git dir files to its own kinds", () => {
    const index = buildWatchIndex([scan]);
    expect(classify(at(repo.commonDir, "HEAD"), index)).toEqual({
      kind: "head",
      checkoutPath: repo.path,
    });
    expect(classify(at(repo.commonDir, "index"), index)).toEqual({
      kind: "index",
      checkoutPath: repo.path,
    });
    expect(classify(at(repo.commonDir, "logs/HEAD"), index)).toEqual({
      kind: "reflog",
      checkoutPath: repo.path,
    });
  });

  it("maps a linked worktree's admin folder to that worktree", () => {
    const index = buildWatchIndex([scan]);
    expect(classify(at(repo.commonDir, "worktrees/wt-a/index"), index)).toEqual({
      kind: "index",
      checkoutPath: wtA.path,
    });
    expect(classify(at(repo.commonDir, "worktrees/wt-a/HEAD"), index)).toEqual({
      kind: "head",
      checkoutPath: wtA.path,
    });
    expect(classify(at(repo.commonDir, "worktrees/wt-b/logs/HEAD"), index)).toEqual({
      kind: "reflog",
      checkoutPath: wtB.path,
    });
    expect(classify(at(repo.commonDir, "worktrees/wt-a/ORIG_HEAD"), index)).toBeNull();
  });

  it("maps refs and packed-refs to the repository, naming the ref when it can", () => {
    const index = buildWatchIndex([scan]);
    expect(classify(at(repo.commonDir, "refs/heads/x"), index)).toEqual({
      kind: "refs",
      commonDir: repo.commonDir,
      ref: "refs/heads/x",
    });
    expect(classify(at(repo.commonDir, "refs/remotes/origin/main"), index)).toEqual({
      kind: "refs",
      commonDir: repo.commonDir,
      ref: "refs/remotes/origin/main",
    });
    expect(classify(at(repo.commonDir, "packed-refs"), index)).toEqual({
      kind: "refs",
      commonDir: repo.commonDir,
    });
    expect(classify(at(repo.commonDir, "refs/heads/x.lock"), index)).toBeNull();
  });

  it("maps worktrees added or removed to structure", () => {
    const index = buildWatchIndex([scan]);
    for (const path of [
      "worktrees",
      "worktrees/new",
      "worktrees/new/HEAD",
      "worktrees/wt-a/gitdir",
    ]) {
      expect(classify(at(repo.commonDir, path), index), path).toEqual({
        kind: "structure",
        commonDir: repo.commonDir,
      });
    }
  });

  it("ignores objects, other reflogs and lock files", () => {
    const index = buildWatchIndex([scan]);
    for (const path of ["objects/ab/cdef", "logs/refs/heads/main", "index.lock", "config"]) {
      expect(classify(at(repo.commonDir, path), index), path).toBeNull();
    }
  });

  it("maps edits to the working tree they are in, but not skip-listed folders", () => {
    const index = buildWatchIndex([scan]);
    expect(classify(at(wtA.path, "src/a.ts"), index)).toEqual({
      kind: "workingTree",
      checkoutPath: wtA.path,
    });
    expect(classify(at(repo.path, "a.txt"), index)).toEqual({
      kind: "workingTree",
      checkoutPath: repo.path,
    });
    expect(classify(at(wtA.path, "node_modules/x.js"), index)).toBeNull();
    expect(classify(at(wtA.path, ".git"), index)).toEqual({ kind: "structure", scanRoot: fx.root });
  });

  it("maps folders appearing under the root, or a checkout going, to structure", () => {
    const index = buildWatchIndex([scan]);
    expect(classify(at(fx.root, "new-wt"), index)).toEqual({
      kind: "structure",
      scanRoot: fx.root,
    });
    expect(classify(at(fx.root, "new-wt/.git"), index)).toEqual({
      kind: "structure",
      scanRoot: fx.root,
    });
    expect(classify(wtA.path, index)).toEqual({ kind: "structure", scanRoot: fx.root });
    expect(classify(at(fx.root, "x/node_modules"), index)).toBeNull();
    expect(classify(at(fx.root, "1/2/3/4/5/6/7/8/9"), index)).toBeNull();
    expect(classify(fx.outsidePath("elsewhere"), index)).toBeNull();
  });
});
