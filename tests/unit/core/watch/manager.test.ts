import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendName, WatchBackend, WatchEvent } from "../../../../src/core/watch/backends";
import { type WatchChange, WatchManager } from "../../../../src/core/watch/manager";
import type { WatchedScan, WatchTarget } from "../../../../src/core/watch/targets";
import { createLogger } from "../../../../src/shared/log";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

/** A backend that records subscriptions and lets the test deliver events. */
class FakeBackend implements WatchBackend {
  readonly name: BackendName;
  readonly attempts: string[] = [];
  readonly open = new Map<string, (events: WatchEvent[]) => void>();
  readonly errors = new Map<string, (error: Error, fatal: boolean) => void>();
  closed = 0;
  fails: (target: WatchTarget) => boolean;

  constructor(name: BackendName, fails: (target: WatchTarget) => boolean = () => false) {
    this.name = name;
    this.fails = fails;
  }

  async subscribe(
    target: WatchTarget,
    onEvents: (events: WatchEvent[]) => void,
    onError: (error: Error, fatal: boolean) => void,
  ) {
    this.attempts.push(target.path);
    if (this.fails(target)) throw new Error(`${this.name} cannot watch ${target.path}`);
    this.open.set(target.path, onEvents);
    this.errors.set(target.path, onError);
    return {
      close: async () => {
        this.closed += 1;
        this.open.delete(target.path);
      },
    };
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
let scan: WatchedScan;

beforeAll(() => {
  fx = fixture();
  repo = fx.repo("app").commit({ "a.txt": "a\n" });
  wtA = repo.worktree("wt-a", { from: "main" });
  wtB = repo.worktree("wt-b", { from: "main" });
  scan = {
    scanRoots: [fx.root],
    checkouts: [
      { path: repo.path, gitDir: repo.commonDir, commonDir: repo.commonDir },
      { path: wtA.path, gitDir: join(repo.commonDir, "worktrees/wt-a"), commonDir: repo.commonDir },
      { path: wtB.path, gitDir: join(repo.commonDir, "worktrees/wt-b"), commonDir: repo.commonDir },
    ],
  };
});
afterAll(() => fx.cleanup());

function logSink(): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, log: createLogger({ scope: "test", sink: (line) => lines.push(line) }) };
}

function manager(backends: WatchBackend[], options: { storm?: number } = {}) {
  const changes: WatchChange[] = [];
  let pausedChanges = 0;
  const { lines, log } = logSink();
  const watch = new WatchManager({
    backends,
    log,
    onChange: (change) => changes.push(change),
    onPausedChange: () => {
      pausedChanges += 1;
    },
    ...(options.storm === undefined ? {} : { stormThreshold: options.storm }),
  });
  return { watch, changes, lines, paused: () => pausedChanges };
}

describe("WatchManager subscriptions", () => {
  it("opens one subscription per target, shares them between sessions, and releases them", async () => {
    const backend = new FakeBackend("fsevents");
    const { watch } = manager([backend]);
    await watch.watchScan(1, scan);
    // The root, the common dir (which carries every git dir here) and three working trees.
    expect(backend.attempts).toHaveLength(5);
    expect(watch.subscriptions()).toHaveLength(5);
    await watch.watchScan(2, scan);
    expect(backend.attempts).toHaveLength(5);
    expect(watch.subscriptions().every((item) => item.holders === 2)).toBe(true);
    await watch.release(1);
    expect(backend.open.size).toBe(5);
    await watch.release(2);
    expect(backend.open.size).toBe(0);
    expect(backend.closed).toBe(5);
    expect(watch.subscriptions()).toEqual([]);
  });

  it("follows a scan that lost a checkout, keeping the rest", async () => {
    const backend = new FakeBackend("fsevents");
    const { watch } = manager([backend]);
    await watch.watchScan(1, scan);
    await watch.watchScan(1, { ...scan, checkouts: scan.checkouts.slice(0, 2) });
    expect(backend.attempts).toHaveLength(5);
    expect(backend.closed).toBe(1);
    expect(backend.open.has(wtB.path)).toBe(false);
    await watch.dispose();
  });

  it("falls back to fs.watch when FSEvents fails, and reports which one watches", async () => {
    const fsevents = new FakeBackend("fsevents", () => true);
    const fsWatch = new FakeBackend("fs.watch");
    const { watch, changes } = manager([fsevents, fsWatch]);
    await watch.watchScan(1, scan);
    expect(fsevents.attempts).toHaveLength(5);
    expect(fsWatch.attempts).toHaveLength(5);
    expect(watch.backend()).toBe("fs.watch");
    vi.useFakeTimers();
    try {
      fsWatch.emit(wtA.path, { path: join(wtA.path, "x.txt"), type: "update" });
      vi.advanceTimersByTime(400);
    } finally {
      vi.useRealTimers();
    }
    expect(changes).toEqual([
      { scope: "checkout", checkoutPath: wtA.path, kinds: ["workingTree"] },
    ]);
    await watch.dispose();
  });

  it("reports a folder no backend can watch, once per backend, and tries again only on resume", async () => {
    const fails = (target: WatchTarget) => target.path === wtA.path;
    const fsevents = new FakeBackend("fsevents", fails);
    const fsWatch = new FakeBackend("fs.watch", fails);
    const { watch, lines, paused } = manager([fsevents, fsWatch]);
    await watch.watchScan(1, scan);
    expect(fsevents.attempts.filter((path) => path === wtA.path)).toHaveLength(1);
    expect(fsWatch.attempts.filter((path) => path === wtA.path)).toHaveLength(1);
    expect(watch.paused(1)).toEqual([
      { path: wtA.path, reason: "watcherError", since: expect.any(Number) },
    ]);
    expect(paused()).toBe(1);
    expect(lines.filter((line) => line.includes("could not watch a folder"))).toHaveLength(2);
    expect(lines.filter((line) => line.includes("live refresh unavailable"))).toHaveLength(1);
    // A rescan of the same scan does not try again.
    await watch.watchScan(1, scan);
    expect(fsevents.attempts.filter((path) => path === wtA.path)).toHaveLength(1);
    await watch.resume(1);
    expect(fsevents.attempts.filter((path) => path === wtA.path)).toHaveLength(2);
    await watch.dispose();
  });
});

describe("WatchManager events", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function started(storm?: number) {
    const backend = new FakeBackend("fsevents");
    const made = manager([backend], storm === undefined ? {} : { storm });
    vi.useRealTimers();
    await made.watch.watchScan(1, scan);
    vi.useFakeTimers();
    return { backend, ...made };
  }

  it("routes each watch's own signals, debounced per checkout and repository", async () => {
    const { backend, changes } = await started();
    backend.emit(repo.commonDir, {
      path: join(repo.commonDir, "worktrees/wt-a/index"),
      type: "update",
    });
    backend.emit(repo.commonDir, {
      path: join(repo.commonDir, "worktrees/wt-a/logs/HEAD"),
      type: "update",
    });
    backend.emit(repo.commonDir, { path: join(repo.commonDir, "refs/heads/wt-a"), type: "update" });
    backend.emit(wtA.path, { path: join(wtA.path, "a.txt"), type: "update" });
    // The root watch sees the same edit; it only speaks for folders appearing or going.
    backend.emit(fx.root, { path: join(wtA.path, "a.txt"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({
      scope: "checkout",
      checkoutPath: wtA.path,
      kinds: ["index", "reflog", "workingTree"],
    });
    expect(changes).toContainEqual({
      scope: "repository",
      commonDir: repo.commonDir,
      kinds: ["refs"],
      refs: ["refs/heads/wt-a"],
    });
  });

  it("turns a new worktree into one structure change per place that saw it", async () => {
    const { backend, changes } = await started();
    backend.emit(fx.root, { path: join(fx.root, "wt-c"), type: "create" });
    backend.emit(fx.root, { path: join(fx.root, "wt-c/.git"), type: "create" });
    backend.emit(repo.commonDir, { path: join(repo.commonDir, "worktrees/wt-c"), type: "create" });
    // A file written in a plain folder is not a folder appearing.
    backend.emit(fx.root, { path: join(fx.root, "notes.txt"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes).toEqual([
      { scope: "root", scanRoot: fx.root, kinds: ["structure"] },
      { scope: "repository", commonDir: repo.commonDir, kinds: ["structure"], refs: [] },
    ]);
  });

  it("tells which root a folder appeared in, and an outside checkout's edits apart", async () => {
    const backend = new FakeBackend("fsevents");
    const made = manager([backend]);
    const other = fx.outsidePath("second-root");
    const outsideWt = fx.outsidePath("agents/wt-out");
    vi.useRealTimers();
    await made.watch.watchScan(1, {
      scanRoots: [fx.root, other],
      checkouts: [
        ...scan.checkouts,
        {
          path: outsideWt,
          gitDir: join(repo.commonDir, "worktrees/wt-out"),
          commonDir: repo.commonDir,
        },
      ],
    });
    vi.useFakeTimers();
    expect(backend.open.has(other)).toBe(true);
    expect(backend.open.has(outsideWt)).toBe(true);
    backend.emit(other, { path: join(other, "new-wt"), type: "create" });
    backend.emit(outsideWt, { path: join(outsideWt, "a.txt"), type: "update" });
    backend.emit(repo.commonDir, {
      path: join(repo.commonDir, "worktrees/wt-out/HEAD"),
      type: "update",
    });
    vi.advanceTimersByTime(400);
    expect(made.changes).toHaveLength(2);
    expect(made.changes).toContainEqual({ scope: "root", scanRoot: other, kinds: ["structure"] });
    expect(made.changes).toContainEqual({
      scope: "checkout",
      checkoutPath: outsideWt,
      kinds: ["workingTree", "head"],
    });
  });

  it("pauses a checkout's working-tree refresh in a storm, keeping its git-dir signals", async () => {
    const { backend, changes, watch, paused } = await started(100);
    const many = Array.from({ length: 150 }, (_, index) => ({
      path: join(wtA.path, `build-out/f${index}`),
      type: "create" as const,
    }));
    backend.emit(wtA.path, ...many.slice(0, 60));
    backend.emit(wtA.path, ...many.slice(60));
    expect(watch.paused(1)).toEqual([
      { path: wtA.path, reason: "eventStorm", since: expect.any(Number) },
    ]);
    expect(paused()).toBe(1);
    backend.emit(repo.commonDir, {
      path: join(repo.commonDir, "worktrees/wt-a/index"),
      type: "update",
    });
    backend.emit(wtA.path, { path: join(wtA.path, "a.txt"), type: "update" });
    vi.advanceTimersByTime(2_000);
    expect(changes).toEqual([{ scope: "checkout", checkoutPath: wtA.path, kinds: ["index"] }]);
    vi.useRealTimers();
    await watch.resume(1);
    vi.useFakeTimers();
    expect(watch.paused(1)).toEqual([]);
    backend.emit(wtA.path, { path: join(wtA.path, "a.txt"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes.at(-1)).toEqual({
      scope: "checkout",
      checkoutPath: wtA.path,
      kinds: ["workingTree"],
    });
  });

  it("drops events while suspended", async () => {
    const { backend, changes, watch } = await started();
    watch.suspend(true);
    backend.emit(wtA.path, { path: join(wtA.path, "a.txt"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes).toEqual([]);
    watch.suspend(false);
    backend.emit(wtA.path, { path: join(wtA.path, "a.txt"), type: "update" });
    vi.advanceTimersByTime(400);
    expect(changes).toHaveLength(1);
  });

  it("reads again what a watch covers after it reports lost events", async () => {
    const { backend, changes } = await started();
    backend.errors.get(repo.commonDir)?.(new Error("Events were dropped"), false);
    vi.advanceTimersByTime(400);
    expect(changes).toContainEqual({
      scope: "repository",
      commonDir: repo.commonDir,
      kinds: ["refs", "structure"],
      refs: null,
    });
    expect(changes.filter((change) => change.scope === "checkout")).toHaveLength(3);
  });
});
