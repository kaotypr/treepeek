import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isIgnored as exportedIsIgnored } from "../../../../src/core/service";
import { fsWatchBackend, type WatchEvent } from "../../../../src/core/watch/backends";
import {
  isIgnored,
  targetKey,
  type WatchedScan,
  type WatchTarget,
  watchTargets,
} from "../../../../src/core/watch/targets";
import { MAX_SCAN_DEPTH } from "../../../../src/shared/constants";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

// The `fs.watch` backend is driven by hand below: its watcher reports exactly the names a
// test hands it. Everything else in `node:fs` is the real thing.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

let fx: Fixture;
let repo: FixtureRepo;
let wtA: FixtureCheckout;
let wtB: FixtureCheckout;
let common: string;
let gitA: string;
let gitB: string;
let scan: WatchedScan;

beforeAll(() => {
  fx = fixture();
  repo = fx.repo("app").commit({ "a.txt": "a\n" });
  wtA = repo.worktree("wt-a", { from: "main", branch: "feature/a" });
  wtB = repo.worktree("nested/wt-b", { from: "main" });
  common = repo.commonDir;
  gitA = join(common, "worktrees/wt-a");
  gitB = join(common, "worktrees/wt-b");
  scan = {
    scanRoots: [fx.root],
    checkouts: [
      { path: repo.path, gitDir: common, commonDir: common },
      { path: wtA.path, gitDir: gitA, commonDir: common },
      { path: wtB.path, gitDir: gitB, commonDir: common },
    ],
  };
});
afterAll(() => fx.cleanup());
afterEach(() => vi.useRealTimers());

/** What each target is, without its ignore lists. */
function shape(target: WatchTarget) {
  return {
    kind: target.kind,
    path: target.path,
    owner: target.owner,
    recursive: target.recursive,
    optional: target.optional,
    maxDepth: target.maxDepth,
  };
}

function find(targets: readonly WatchTarget[], kind: WatchTarget["kind"], path: string) {
  const target = targets.find((item) => targetKey(item) === targetKey({ kind, path }));
  if (!target) throw new Error(`no ${kind} target for ${path}`);
  return target;
}

describe("the narrow layout", () => {
  it("watches each git dir's own files without recursion, and only refs/ with it", () => {
    const targets = watchTargets(scan, { narrow: true });
    const recursive = { recursive: true, optional: false, maxDepth: null };
    const flat = { recursive: false, optional: false, maxDepth: 1 };
    const optional = { recursive: false, optional: true, maxDepth: 1 };
    expect(targets.map(shape)).toEqual([
      { kind: "root", path: fx.root, owner: fx.root, ...recursive, maxDepth: MAX_SCAN_DEPTH + 1 },
      { kind: "common", path: common, owner: common, ...flat },
      { kind: "common", path: `${common}/logs`, owner: common, ...optional },
      { kind: "common", path: `${common}/refs`, owner: common, ...recursive },
      { kind: "common", path: `${common}/worktrees`, owner: common, ...optional },
      { kind: "gitDir", path: gitA, owner: gitA, ...flat },
      { kind: "gitDir", path: `${gitA}/logs`, owner: gitA, ...optional },
      { kind: "gitDir", path: gitB, owner: gitB, ...flat },
      { kind: "gitDir", path: `${gitB}/logs`, owner: gitB, ...optional },
      { kind: "workingTree", path: repo.path, owner: repo.path, ...recursive },
      { kind: "workingTree", path: wtA.path, owner: wtA.path, ...recursive },
      { kind: "workingTree", path: wtB.path, owner: wtB.path, ...recursive },
    ]);
    expect(new Set(targets.map(targetKey)).size).toBe(targets.length);
    // Nothing watches a common dir, or anything in it but refs/, with recursion.
    expect(
      targets
        .filter((target) => target.recursive && target.path.startsWith(common))
        .map((target) => target.path),
    ).toEqual([`${common}/refs`]);
  });

  it("gives an outside checkout the same repository watches as one inside", () => {
    const outside = fx.outsidePath("agents/wt-out");
    const gitOut = join(common, "worktrees/wt-out");
    const targets = watchTargets(
      {
        scanRoots: [fx.root],
        checkouts: [...scan.checkouts, { path: outside, gitDir: gitOut, commonDir: common }],
      },
      { narrow: true },
    );
    expect(shape(find(targets, "gitDir", gitOut))).toMatchObject({ recursive: false });
    expect(shape(find(targets, "gitDir", `${gitOut}/logs`))).toMatchObject({ optional: true });
    expect(shape(find(targets, "workingTree", outside))).toMatchObject({ recursive: true });
  });

  it("keeps today's layout, every target recursive, unless asked", () => {
    const separate = fx.outsidePath("separate-git-dir");
    for (const targets of [
      watchTargets(scan),
      watchTargets(scan, { narrow: false }),
      watchTargets({
        scanRoots: [fx.root],
        checkouts: [{ path: repo.path, gitDir: separate, commonDir: common }],
      }),
    ]) {
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target.recursive, target.path).toBe(true);
        expect(target.optional, target.path).toBe(false);
        expect(target.owner, target.path).toBe(target.path);
      }
    }
  });

  it("leaves out what lies below a folder watched without recursion", () => {
    const targets = watchTargets(scan, { narrow: true });
    const own = find(targets, "common", common);
    expect(isIgnored(own, join(common, "HEAD"))).toBe(false);
    expect(isIgnored(own, join(common, "packed-refs"))).toBe(false);
    expect(isIgnored(own, join(common, "worktrees"))).toBe(false);
    expect(isIgnored(own, join(common, "refs/heads/main"))).toBe(true);
    expect(isIgnored(own, join(common, "worktrees/wt-a/index"))).toBe(true);
    expect(isIgnored(own, join(common, "objects"))).toBe(true);
    const worktree = find(targets, "gitDir", gitA);
    expect(isIgnored(worktree, join(gitA, "HEAD"))).toBe(false);
    expect(isIgnored(worktree, join(gitA, "gitdir"))).toBe(false);
    expect(isIgnored(worktree, join(gitA, "logs/HEAD"))).toBe(true);
    const refs = find(targets, "common", `${common}/refs`);
    expect(isIgnored(refs, join(common, "refs/heads/feature/a"))).toBe(false);
  });
});

/**
 * Paths below the fixture with whether each target's watcher leaves them out, in both
 * layouts: `[target kind, target path, path, ignored]`.
 */
function table(narrow: boolean): [WatchTarget["kind"], string, string, boolean][] {
  const both: [WatchTarget["kind"], string, string, boolean][] = [
    ["root", fx.root, join(fx.root, "new-wt"), false],
    ["root", fx.root, join(fx.root, "new-wt/.git"), false],
    ["root", fx.root, join(fx.root, "app/.git/HEAD"), true],
    ["root", fx.root, join(fx.root, "x/node_modules"), true],
    ["root", fx.root, join(fx.root, "1/2/3/4/5/6/7/8/9"), true],
    ["workingTree", wtA.path, join(wtA.path, "src/a.ts"), false],
    ["workingTree", wtA.path, join(wtA.path, "node_modules/x/index.js"), true],
    ["workingTree", wtA.path, join(wtA.path, "src/dist/bundle.js"), true],
    ["workingTree", repo.path, join(repo.path, ".git/index"), true],
  ];
  if (!narrow) {
    return [
      ...both,
      ["common", common, join(common, "HEAD"), false],
      ["common", common, join(common, "refs/heads/feature/a"), false],
      ["common", common, join(common, "worktrees/wt-a/index"), false],
      ["common", common, join(common, "logs/HEAD"), false],
      ["common", common, join(common, "objects/ab/cdef"), true],
      ["common", common, join(common, "logs/refs/heads/main"), true],
    ];
  }
  return [
    ...both,
    ["common", common, join(common, "HEAD"), false],
    ["common", common, join(common, "index"), false],
    ["common", common, join(common, "worktrees"), false],
    ["common", common, join(common, "objects"), true],
    ["common", common, join(common, "refs/heads/main"), true],
    ["common", `${common}/logs`, join(common, "logs/HEAD"), false],
    ["common", `${common}/logs`, join(common, "logs/refs/heads/main"), true],
    ["common", `${common}/refs`, join(common, "refs/heads/feature/a"), false],
    ["common", `${common}/worktrees`, join(common, "worktrees/wt-c"), false],
    ["common", `${common}/worktrees`, join(common, "worktrees/wt-a/HEAD"), true],
    ["gitDir", gitA, join(gitA, "HEAD"), false],
    ["gitDir", gitA, join(gitA, "logs/HEAD"), true],
    ["gitDir", `${gitA}/logs`, join(gitA, "logs/HEAD"), false],
  ];
}

/**
 * The paths the core's `fs.watch` backend passes on for `target` when its watcher reports
 * each of `paths`.
 */
async function passedByFsWatch(target: WatchTarget, paths: readonly string[]): Promise<string[]> {
  type Listener = (type: string, name: string | null) => void;
  let report: Listener | undefined;
  vi.mocked(watch).mockImplementationOnce(((
    _path: string,
    _options: object,
    listener: Listener,
  ) => {
    report = listener;
    return Object.assign(new EventEmitter(), { close: () => undefined });
  }) as unknown as typeof watch);
  const received: WatchEvent[] = [];
  vi.useFakeTimers();
  const subscription = await fsWatchBackend.subscribe(
    target,
    (events) => received.push(...events),
    () => undefined,
  );
  for (const path of paths) report?.("change", relative(target.path, path));
  vi.advanceTimersByTime(100);
  await subscription.close();
  vi.useRealTimers();
  return received.map((event) => event.path);
}

describe("the isIgnored a host filters with", () => {
  it("is the one the core's own backends use", () => {
    expect(exportedIsIgnored).toBe(isIgnored);
  });

  for (const narrow of [false, true]) {
    it(`agrees with the fs.watch backend on a table of paths (${narrow ? "narrow" : "today's"} layout)`, async () => {
      const targets = watchTargets(scan, { narrow });
      const rows = table(narrow);
      for (const [kind, path, event, ignored] of rows) {
        expect(exportedIsIgnored(find(targets, kind, path), event), event).toBe(ignored);
      }
      const byTarget = new Map<string, { target: WatchTarget; events: string[] }>();
      for (const [kind, path, event] of rows) {
        const target = find(targets, kind, path);
        const entry = byTarget.get(targetKey(target)) ?? { target, events: [] };
        entry.events.push(event);
        byTarget.set(targetKey(target), entry);
      }
      for (const { target, events } of byTarget.values()) {
        const passed = await passedByFsWatch(target, events);
        expect(passed, target.path).toEqual(
          events.filter((event) => !exportedIsIgnored(target, event)),
        );
      }
    });
  }
});
