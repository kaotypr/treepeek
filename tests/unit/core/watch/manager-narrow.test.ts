import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WatchBackend, WatchEvent } from "../../../../src/core/watch/backends";
import { type WatchChange, WatchManager } from "../../../../src/core/watch/manager";
import type { WatchedScan, WatchTarget } from "../../../../src/core/watch/targets";
import { createLogger } from "../../../../src/shared/log";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

/**
 * A backend that records what it is asked to watch and lets the test deliver events. Like
 * a host's, it refuses a folder that is not there.
 */
class FakeBackend implements WatchBackend {
  readonly name: string;
  readonly nonRecursive: boolean;
  readonly attempts: { path: string; recursive: boolean }[] = [];
  readonly open = new Map<string, (events: WatchEvent[]) => void>();
  readonly errors = new Map<string, (error: Error, fatal: boolean) => void>();
  fails: (target: WatchTarget) => boolean;

  constructor(
    name: string,
    options: { nonRecursive?: boolean; fails?: (target: WatchTarget) => boolean } = {},
  ) {
    this.name = name;
    this.nonRecursive = options.nonRecursive ?? true;
    this.fails = options.fails ?? (() => false);
  }

  async subscribe(
    target: WatchTarget,
    onEvents: (events: WatchEvent[]) => void,
    onError: (error: Error, fatal: boolean) => void,
  ) {
    this.attempts.push({ path: target.path, recursive: target.recursive });
    if (!existsSync(target.path)) throw new Error(`${target.path} does not exist`);
    if (this.fails(target)) throw new Error(`${this.name} cannot watch ${target.path}`);
    this.open.set(target.path, onEvents);
    this.errors.set(target.path, onError);
    return {
      close: async () => {
        this.open.delete(target.path);
      },
    };
  }

  tries(path: string): number {
    return this.attempts.filter((attempt) => attempt.path === path).length;
  }

  emit(folder: string, ...events: WatchEvent[]): void {
    const deliver = this.open.get(folder);
    if (!deliver) throw new Error(`nothing watches ${folder}`);
    deliver(events);
  }
}

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
  wtB = repo.worktree("wt-b", { from: "main" });
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

function manager(backends: WatchBackend[]) {
  const changes: WatchChange[] = [];
  const lines: string[] = [];
  let pausedChanges = 0;
  const watch = new WatchManager({
    backends,
    log: createLogger({ scope: "test", sink: (line) => lines.push(line) }),
    onChange: (change) => changes.push(change),
    onPausedChange: () => {
      pausedChanges += 1;
    },
  });
  return { watch, changes, lines, paused: () => pausedChanges };
}

/** A manager watching `scan` with a narrow backend, ready for events under fake timers. */
async function started() {
  const backend = new FakeBackend("host");
  const made = manager([backend]);
  await made.watch.watchScan(1, scan);
  vi.useFakeTimers();
  return { backend, ...made };
}

describe("WatchManager with narrow targets", () => {
  it("routes a nested ref, a new worktree, a worktree's HEAD and its gitdir", async () => {
    const { backend, changes, watch } = await started();
    backend.emit(`${common}/refs`, {
      path: join(common, "refs/heads/feature/a"),
      type: "update",
    });
    vi.advanceTimersByTime(400);
    expect(changes.splice(0)).toEqual([
      { scope: "repository", commonDir: common, kinds: ["refs"], refs: ["refs/heads/feature/a"] },
    ]);

    backend.emit(`${common}/worktrees`, { path: join(common, "worktrees/wt-c"), type: "create" });
    vi.advanceTimersByTime(400);
    expect(changes.splice(0)).toEqual([
      { scope: "repository", commonDir: common, kinds: ["structure"], refs: [] },
    ]);

    backend.emit(gitA, { path: join(gitA, "HEAD"), type: "update" });
    backend.emit(`${gitA}/logs`, { path: join(gitA, "logs/HEAD"), type: "update" });
    backend.emit(common, { path: join(common, "index"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes.splice(0)).toEqual([
      { scope: "checkout", checkoutPath: wtA.path, kinds: ["head", "reflog"] },
      { scope: "checkout", checkoutPath: repo.path, kinds: ["index"] },
    ]);

    // Only the worktree's own watch sees its `gitdir` move now.
    backend.emit(gitB, { path: join(gitB, "gitdir"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes.splice(0)).toEqual([
      { scope: "repository", commonDir: common, kinds: ["structure"], refs: [] },
    ]);
    // A git dir's watch does not speak for the repository's refs.
    backend.emit(gitB, { path: join(common, "refs/heads/wt-b"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes).toEqual([]);
    vi.useRealTimers();
    await watch.dispose();
  });

  it("re-reads a worktree after its git dir lost events, and the repository after refs/ did", async () => {
    const { backend, changes, watch } = await started();
    backend.errors.get(gitA)?.(new Error("the host dropped events"), false);
    vi.advanceTimersByTime(400);
    expect(changes.splice(0)).toEqual([
      { scope: "checkout", checkoutPath: wtA.path, kinds: ["head", "index", "reflog"] },
    ]);

    backend.errors.get(`${common}/refs`)?.(new Error("the host dropped events"), false);
    vi.advanceTimersByTime(400);
    expect(changes).toContainEqual({
      scope: "repository",
      commonDir: common,
      kinds: ["refs", "structure"],
      refs: null,
    });
    expect(
      changes
        .filter((change) => change.scope === "checkout")
        .map((change) => change.scope === "checkout" && change.checkoutPath)
        .sort(),
    ).toEqual([repo.path, wtA.path, wtB.path].sort());
    vi.useRealTimers();
    await watch.dispose();
  });

  it("does not pause on an optional folder that is not there, and tries it again on the next scan", async () => {
    const solo = fx.repo("solo").commit({ "s.txt": "s\n" });
    const soloScan: WatchedScan = {
      scanRoots: [fx.root],
      checkouts: [{ path: solo.path, gitDir: solo.commonDir, commonDir: solo.commonDir }],
    };
    const worktrees = `${solo.commonDir}/worktrees`;
    const backend = new FakeBackend("host");
    const { watch, lines, paused } = manager([backend]);
    await watch.watchScan(1, soloScan);
    expect(backend.tries(worktrees)).toBe(1);
    expect(watch.paused(1)).toEqual([]);
    expect(paused()).toBe(0);
    expect(watch.subscriptions().map((item) => item.path)).not.toContain(worktrees);
    expect(lines.filter((line) => line.includes("could not watch a folder"))).toEqual([]);
    expect(lines.filter((line) => line.includes("live refresh unavailable"))).toEqual([]);

    // A rescan wanting it again tries again; once the folder is there, it is watched.
    await watch.watchScan(1, soloScan);
    expect(backend.tries(worktrees)).toBe(2);
    const wt = solo.outsideWorktree("solo-wt", { from: "main" });
    await watch.watchScan(1, soloScan);
    expect(backend.tries(worktrees)).toBe(3);
    expect(backend.open.has(worktrees)).toBe(true);
    expect(watch.paused(1)).toEqual([]);
    solo.repoGit(["worktree", "remove", "--force", wt.path]);
    await watch.dispose();
  });

  it("still pauses an optional folder that is there but cannot be watched, and a missing required one", async () => {
    const missingGitDir = join(common, "worktrees/gone");
    const backend = new FakeBackend("host", {
      fails: (target) => target.path === `${common}/logs`,
    });
    const { watch, lines } = manager([backend]);
    const withGone: WatchedScan = {
      ...scan,
      checkouts: [
        ...scan.checkouts,
        { path: fx.outsidePath("gone"), gitDir: missingGitDir, commonDir: common },
      ],
    };
    await watch.watchScan(1, withGone);
    expect(
      watch
        .paused(1)
        .map((item) => [item.path, item.reason])
        .sort(),
    ).toEqual(
      [
        [`${common}/logs`, "watcherError"],
        [missingGitDir, "watcherError"],
        // The missing checkout's working tree cannot be watched either.
        [fx.outsidePath("gone"), "watcherError"],
      ].sort(),
    );
    expect(lines.filter((line) => line.includes("live refresh unavailable"))).toHaveLength(3);
    // Those keep today's rule: no retry on a rescan, only on resume.
    await watch.watchScan(1, withGone);
    expect(backend.tries(missingGitDir)).toBe(1);
    expect(backend.tries(`${common}/logs`)).toBe(1);
    await watch.resume(1);
    expect(backend.tries(missingGitDir)).toBe(2);
    expect(backend.tries(`${common}/logs`)).toBe(2);
    await watch.dispose();
  });

  it("keeps today's layout when a backend in the list needs recursion", async () => {
    for (const order of ["narrow first", "recursive first"]) {
      const host = new FakeBackend("host", { fails: (target) => target.path === wtB.path });
      const recursiveOnly = new FakeBackend("fallback", { nonRecursive: false });
      const backends = order === "narrow first" ? [host, recursiveOnly] : [recursiveOnly, host];
      const { watch } = manager(backends);
      const first = backends[0];
      if (!first) throw new Error("no backend");
      // Before anything is watched: the first one.
      expect(watch.backend(), order).toBe(first.name);
      await watch.watchScan(1, scan);
      // The root, the common dir as a whole and three working trees, all recursive.
      expect(first.attempts.map((attempt) => attempt.path).sort(), order).toEqual(
        [fx.root, common, repo.path, wtA.path, wtB.path].sort(),
      );
      expect(first.attempts.every((attempt) => attempt.recursive)).toBe(true);
      // Narrow first, the host could not watch one folder and `fallback` did; the other way
      // round, `fallback` watched them all. Either way it is the one furthest down in use.
      expect(watch.backend(), order).toBe("fallback");
      await watch.dispose();
    }
  });

  it("names the one backend a host passed", async () => {
    const { watch } = manager([new FakeBackend("host")]);
    expect(watch.backend()).toBe("host");
    await watch.watchScan(1, scan);
    expect(watch.backend()).toBe("host");
    expect(watch.subscriptions().every((item) => item.backend === "host")).toBe(true);
    await watch.dispose();
  });
});
