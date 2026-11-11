import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneOnStartup } from "../../../../src/core/review/prune";
import { worktreeId } from "../../../../src/core/store/identity";
import {
  JsonReviewStore,
  type JsonStoreOptions,
  repositoryFileName,
  SNAPSHOT_GRACE_MS,
} from "../../../../src/core/store/json-store";
import { SCHEMA_VERSION } from "../../../../src/core/store/migrations";
import {
  type MarkInput,
  StoreError,
  type WorktreeRow,
} from "../../../../src/core/store/review-store";
import { SNAPSHOT_FOLDER } from "../../../../src/core/store/snapshots";
import type { Logger } from "../../../../src/shared/log";

/**
 * Two `JsonReviewStore` instances on one folder stand in for two core processes: they
 * share nothing but the files. A long `flushDelayMs` keeps gathered writes until a test
 * calls `flush()`, and a lock file the test holds keeps a change pending, so each test
 * fixes the order in which the two write.
 */

const COMMON = "/repos/app/.git";
const FILE = repositoryFileName(COMMON);
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);
const T0 = "2025-07-01T00:00:00Z";
const T1 = "2025-07-01T00:00:01Z";
const T2 = "2025-07-01T00:00:02Z";

function row(checkoutPath = "/repos/app", overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  const startCommit = "a".repeat(40);
  return {
    worktreeId: worktreeId(COMMON, checkoutPath, startCommit),
    commonDir: COMMON,
    checkoutPath,
    startCommit,
    startObservedAt: "2025-01-01T00:00:00Z",
    firstSeenAt: "2025-02-01T00:00:00Z",
    lastSeenAt: "2025-02-01T00:00:00Z",
    ...overrides,
  };
}
const W = row().worktreeId;

const mark = (
  path: string,
  viewedAt = T0,
  resultHash = H1,
  snapshotHash: string | null = null,
): MarkInput => ({ path, resultHash, viewedAt, snapshotHash });

/** A logger that keeps the messages of its warnings and prints nothing. */
function silentLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger & { warnings: string[] } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
    child: () => log,
  };
  return log;
}

let dir: string;
let stores: JsonReviewStore[];

/** A store with its own clock, standing in for one process. */
function open(options: JsonStoreOptions & { at?: string } = {}) {
  const log = silentLog();
  const clock = { at: options.at ?? T0 };
  const { at: _, ...rest } = options;
  const store = new JsonReviewStore(dir, {
    flushDelayMs: 60_000,
    log,
    now: () => new Date(clock.at),
    ...rest,
  });
  stores.push(store);
  return { store, log, clock };
}

/** What the repository's file holds now. */
function disk(): {
  worktrees: Record<string, { lastSeenAt: string }>;
  startOverrides: Record<string, { commit: string }>;
  marks: Record<string, Record<string, { viewedAt: string; snapshotHash: string | null }>>;
} {
  return JSON.parse(readFileSync(join(dir, FILE), "utf8"));
}

const diskPaths = () => Object.keys(disk().marks[W] ?? {}).sort();

/** Holds the repository's lock as a live process would, until the returned call. */
function holdLock(): () => void {
  const path = join(dir, `${FILE}.lock`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, nonce: "test", time: T0 }));
  return () => unlinkSync(path);
}

/** Records `W` and returns two stores that both read it. */
function twoProcesses(options: JsonStoreOptions = {}) {
  const seed = open();
  seed.store.upsertWorktree(row());
  seed.store.close();
  return { a: open(options), b: open(options) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-writers-"));
  stores = [];
});
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // A test that left a lock held expects this.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("two processes writing one JSON store", () => {
  it("keeps both processes' marks on different files, in either write order", () => {
    for (const first of ["a", "b"] as const) {
      rmSync(join(dir, FILE), { force: true });
      const { a, b } = twoProcesses();
      const [one, two] = first === "a" ? [a, b] : [b, a];
      one.store.setMarks(W, [mark(`${first}-1.txt`)]);
      two.store.setMarks(W, [mark("other.txt")]);
      one.store.setMarks(W, [mark(`${first}-2.txt`)]);
      expect(diskPaths()).toEqual([`${first}-1.txt`, `${first}-2.txt`, "other.txt"]);
      for (const { store } of [a, b]) {
        expect(store.getMarks(W).map((entry) => entry.path)).toEqual(diskPaths());
      }
      a.store.close();
      b.store.close();
    }
  });

  it("keeps a change that waited for the lock beside the other process's, in either order", () => {
    for (const waiting of ["a", "b"] as const) {
      rmSync(join(dir, FILE), { force: true });
      const { a, b } = twoProcesses({ lockTimeoutMs: 20 });
      const [late, early] = waiting === "a" ? [a, b] : [b, a];
      const release = holdLock();
      late.store.setMarks(W, [mark("late.txt")]);
      release();
      early.store.setMarks(W, [mark("early.txt")]);
      expect(diskPaths()).toEqual(["early.txt"]);
      late.store.flush();
      expect(diskPaths()).toEqual(["early.txt", "late.txt"]);
      a.store.close();
      b.store.close();
    }
  });

  it("keeps both processes' gathered scan sightings, in either flush order", () => {
    for (const first of ["a", "b"] as const) {
      rmSync(join(dir, FILE), { force: true });
      const { a, b } = twoProcesses();
      a.store.upsertWorktree(row("/repos/from-a"));
      b.store.upsertWorktree(row("/repos/from-b"));
      b.store.upsertWorktree(row(undefined, { lastSeenAt: "2025-05-01T00:00:00Z" }));
      a.store.upsertWorktree(row(undefined, { lastSeenAt: "2025-04-01T00:00:00Z" }));
      const order = first === "a" ? [a, b] : [b, a];
      for (const { store } of order) store.flush();
      const worktrees = disk().worktrees;
      expect(Object.values(worktrees).map((entry) => entry.lastSeenAt)).toHaveLength(3);
      expect(worktrees[row("/repos/from-a").worktreeId]).toBeDefined();
      expect(worktrees[row("/repos/from-b").worktreeId]).toBeDefined();
      // A row's sightings merge: the later lastSeenAt wins whichever wrote last.
      expect(worktrees[W]?.lastSeenAt).toBe("2025-05-01T00:00:00Z");
      a.store.close();
      b.store.close();
    }
  });

  it("never brings back a mark the other process removed", () => {
    for (const remover of ["a", "b"] as const) {
      rmSync(join(dir, FILE), { force: true });
      const { a, b } = twoProcesses({ lockTimeoutMs: 20 });
      const [removing, other] = remover === "a" ? [a, b] : [b, a];
      removing.store.setMarks(W, [mark("gone.txt"), mark("kept.txt")]);
      expect(other.store.getMarks(W)).toHaveLength(2);
      removing.store.deleteMarks(W, ["gone.txt"]);
      other.store.setMarks(W, [mark("new.txt")]);
      other.store.upsertWorktree(row(undefined, { lastSeenAt: "2025-09-01T00:00:00Z" }));
      other.store.flush();
      expect(diskPaths()).toEqual(["kept.txt", "new.txt"]);
      expect(other.store.getMarks(W).map((entry) => entry.path)).toEqual(["kept.txt", "new.txt"]);
      // A change the other process made before the removal, written after it.
      const release = holdLock();
      expect(() => other.store.setMarks(W, [mark("waited.txt")])).not.toThrow();
      release();
      removing.store.deleteMarks(W, ["new.txt"]);
      other.store.flush();
      expect(diskPaths()).toEqual(["kept.txt", "waited.txt"]);
      // "Unmark all" in one process removes what it saw, and stays removed too.
      removing.store.deleteMarks(W);
      other.store.setStartOverride(W, H3, T2);
      expect(diskPaths()).toEqual([]);
      a.store.close();
      b.store.close();
    }
  });

  describe("two changes to the same file", () => {
    /**
     * `b` changes the mark while the lock is held, so its change is still pending when `a`
     * makes and writes its own; then `b` writes. Answers the mark the file ends with.
     */
    function race(
      first: (store: JsonReviewStore, clock: { at: string }) => void,
      second: (store: JsonReviewStore, clock: { at: string }) => void,
    ) {
      const { a, b } = twoProcesses({ lockTimeoutMs: 20 });
      a.store.setMarks(W, [mark("x.txt", "2025-06-01T00:00:00Z")]);
      expect(b.store.getMarks(W)).toHaveLength(1);
      const release = holdLock();
      second(b.store, b.clock);
      expect(b.log.warnings).toEqual([
        "another process held a store file's lock; the changes stay pending",
      ]);
      release();
      first(a.store, a.clock);
      b.store.flush();
      return disk().marks[W]?.["x.txt"] ?? null;
    }

    it("two sets: the later viewedAt wins, whichever was written first", () => {
      expect(
        race(
          (store) => store.setMarks(W, [mark("x.txt", T1, H1)]),
          (store) => store.setMarks(W, [mark("x.txt", T2, H2)]),
        ),
      ).toMatchObject({ viewedAt: T2 });
      rmSync(join(dir, FILE));
      expect(
        race(
          (store) => store.setMarks(W, [mark("x.txt", T2, H1)]),
          (store) => store.setMarks(W, [mark("x.txt", T1, H2)]),
        ),
      ).toMatchObject({ viewedAt: T2 });
    });

    it("a removal written last takes a mark set before it, and leaves one set after it", () => {
      const removeAt = (at: string) => (store: JsonReviewStore, clock: { at: string }) => {
        clock.at = at;
        store.deleteMarks(W, ["x.txt"]);
      };
      expect(race((store) => store.setMarks(W, [mark("x.txt", T1)]), removeAt(T2))).toBeNull();
      rmSync(join(dir, FILE));
      expect(race((store) => store.setMarks(W, [mark("x.txt", T2)]), removeAt(T1))).toMatchObject({
        viewedAt: T2,
      });
    });

    it("a set written last wins over a removal: by its time, or as the later write", () => {
      const removeAt = (at: string) => (store: JsonReviewStore, clock: { at: string }) => {
        clock.at = at;
        store.deleteMarks(W, ["x.txt"]);
      };
      // The set is the later change.
      expect(race(removeAt(T1), (store) => store.setMarks(W, [mark("x.txt", T2)]))).toMatchObject({
        viewedAt: T2,
      });
      rmSync(join(dir, FILE));
      // The removal is the later change, but a removal leaves no time on disk to compare
      // with: within one write of each other, the later write wins. Pinned on purpose.
      expect(race(removeAt(T2), (store) => store.setMarks(W, [mark("x.txt", T1)]))).toMatchObject({
        viewedAt: T1,
      });
    });

    it("start overrides follow the same rule by setAt", () => {
      const setOverride = (commit: string, at: string) => (store: JsonReviewStore) =>
        store.setStartOverride(W, commit, at);
      race(setOverride(H1, T2), setOverride(H2, T1));
      expect(disk().startOverrides[W]?.commit).toBe(H1);
      rmSync(join(dir, FILE));
      race(setOverride(H1, T1), setOverride(H2, T2));
      expect(disk().startOverrides[W]?.commit).toBe(H2);
    });
  });

  it("drops a prune when the other process touched the worktree since it was read", () => {
    const touches: ((store: JsonReviewStore) => void)[] = [
      (store) => {
        store.upsertWorktree(row(undefined, { lastSeenAt: "2025-09-01T00:00:00Z" }));
        store.flush();
      },
      (store) => store.setMarks(W, [mark("new.txt", T1)]),
      (store) => store.setStartOverride(W, H2, T1),
      (store) => store.deleteMarks(W, ["old.txt"]),
    ];
    for (const touch of [...touches, null]) {
      rmSync(join(dir, FILE), { force: true });
      const { a, b } = twoProcesses();
      a.store.putSnapshot(H1, new Uint8Array(4));
      a.store.setMarks(W, [mark("old.txt", T0, H1, H1)]);
      a.store.setStartOverride(W, H1, T0);
      const stale = b.store.listStaleWorktrees(COMMON, new Set(), "2025-03-01T00:00:00Z");
      expect(stale.map((entry) => entry.worktreeId)).toEqual([W]);
      touch?.(a.store);
      b.store.deleteWorktree(W);
      if (touch === null) {
        // Nobody touched it: it goes.
        expect(disk().worktrees[W]).toBeUndefined();
        expect(disk().marks[W]).toBeUndefined();
        expect(b.store.getWorktree(W)).toBeNull();
      } else {
        expect(disk().worktrees[W]).toBeDefined();
        expect(b.store.getWorktree(W)).not.toBeNull();
        expect(a.store.getWorktree(W)).not.toBeNull();
        expect(b.store.getMarks(W)).toEqual(a.store.getMarks(W));
        // Whatever still references the snapshot keeps it.
        if (disk().marks[W]?.["old.txt"]) expect(b.store.hasSnapshot(H1)).toBe(true);
      }
      a.store.close();
      b.store.close();
    }
  });

  it("one process's startup prune keeps a snapshot the other wrote but has not linked yet", () => {
    const { a, b } = twoProcesses({ lockTimeoutMs: 20 });
    const old = (hash: string) => {
      const then = new Date(Date.now() - SNAPSHOT_GRACE_MS - 60_000);
      utimesSync(join(dir, SNAPSHOT_FOLDER, hash), then, then);
    };
    // An old snapshot nobody uses: either process may delete it.
    a.store.putSnapshot(H3, new Uint8Array(8));
    old(H3);
    // `b` keeps a snapshot for a mark it has not written, then one whose mark is pending.
    b.store.putSnapshot(H1, new Uint8Array(8));
    b.store.putSnapshot(H2, new Uint8Array(8));
    const release = holdLock();
    b.store.setMarks(W, [mark("pending.txt", T1, H2, H2)]);
    release();

    expect(pruneOnStartup(a.store, { capBytes: 0 })).toBe(1);
    expect(a.store.hasSnapshot(H3)).toBe(false);
    expect(a.store.hasSnapshot(H1)).toBe(true);
    expect(a.store.hasSnapshot(H2)).toBe(true);

    b.store.setMarks(W, [mark("later.txt", T2, H1, H1)]);
    expect(Object.values(disk().marks[W] ?? {}).map((entry) => entry.snapshotHash)).toEqual([
      H2,
      H1,
    ]);
    // Linking an old snapshot makes it recent again for every other process.
    old(H1);
    b.store.setMarks(W, [mark("again.txt", T2, H1, H1)]);
    b.store.deleteMarks(W);
    expect(a.store.deleteUnreferencedSnapshots()).toBe(0);
    expect(a.store.hasSnapshot(H1)).toBe(true);
    // Its own fresh snapshots, which nobody else touched since, a process deletes at once.
    expect(b.store.deleteUnreferencedSnapshots()).toBe(2);
    expect(b.store.hasSnapshot(H1)).toBe(false);
    expect(b.store.hasSnapshot(H2)).toBe(false);
  });

  it("answers reads with what the other process wrote since", () => {
    const { a, b } = twoProcesses();
    const other = row("/repos/other");
    expect(b.store.getWorktree(other.worktreeId)).toBeNull();
    a.store.upsertWorktree(other);
    a.store.flush();
    expect(b.store.getWorktree(other.worktreeId)).toEqual(other);
    expect(b.store.findWorktreesByPath(COMMON, "/repos/other")).toEqual([other]);

    a.store.setMarks(W, [mark("a.txt")]);
    expect(b.store.getMarks(W).map((entry) => entry.path)).toEqual(["a.txt"]);
    a.store.setStartOverride(W, H2, T1);
    expect(b.store.getStartOverride(W)?.commit).toBe(H2);
    a.store.deleteMarks(W);
    expect(b.store.getMarks(W)).toEqual([]);

    // A repository another process created after this one opened.
    const svc = { ...row("/repos/svc"), commonDir: "/repos/svc.git", worktreeId: "svc-id" };
    a.store.upsertWorktree(svc);
    a.store.flush();
    expect(b.store.getWorktree("svc-id")).toEqual(svc);
    expect(b.store.findWorktreesByPath("/repos/svc.git", "/repos/svc")).toEqual([svc]);
  });

  it("recovers from a writer killed mid-write: previous file, half a temporary, its lock", () => {
    const { store, log } = open();
    store.upsertWorktree(row());
    store.setMarks(W, [mark("before.txt")]);
    store.close();
    const previous = readFileSync(join(dir, FILE), "utf8");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const temporary = `${FILE}.${dead}.0123456789ab.tmp`;
    writeFileSync(join(dir, temporary), previous.slice(0, previous.length / 2));
    writeFileSync(
      join(dir, `${FILE}.lock`),
      JSON.stringify({ pid: dead, nonce: "crashed", time: T0 }),
    );

    const next = open();
    expect(next.store.getMarks(W).map((entry) => entry.path)).toEqual(["before.txt"]);
    const startedAt = Date.now();
    next.store.setMarks(W, [mark("after.txt")]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(diskPaths()).toEqual(["after.txt", "before.txt"]);
    expect(readdirSync(dir).sort()).toEqual([FILE, SNAPSHOT_FOLDER].sort());
    expect([...log.warnings, ...next.log.warnings]).toEqual([]);
  });
});

describe("writes that cannot happen now", () => {
  it("keeps a user's change pending when the lock stays held, without failing the call", () => {
    const { a } = twoProcesses({ lockTimeoutMs: 20 });
    const release = holdLock();
    expect(() => a.store.setMarks(W, [mark("a.txt")])).not.toThrow();
    expect(a.store.getMarks(W).map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(diskPaths()).toEqual([]);
    expect(a.log.warnings).toHaveLength(1);
    expect(() => a.store.flush()).toThrow(StoreError);
    release();
    a.store.flush();
    expect(diskPaths()).toEqual(["a.txt"]);
  });

  it("never throws from a timer write, and tries again later (fake timers)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { a } = twoProcesses({ lockTimeoutMs: 20, flushDelayMs: 250 });
    const release = holdLock();
    a.store.upsertWorktree(row("/repos/new"));
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(a.log.warnings).toHaveLength(1);
    expect(disk().worktrees[row("/repos/new").worktreeId]).toBeUndefined();
    // Still held at the first retry: another warning, no throw.
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(a.log.warnings).toHaveLength(2);
    release();
    vi.advanceTimersByTime(2_000);
    expect(disk().worktrees[row("/repos/new").worktreeId]).toBeDefined();
  });

  it("close() throws a StoreError when its last write fails, and closes anyway", () => {
    const { a } = twoProcesses({ lockTimeoutMs: 20 });
    a.store.upsertWorktree(row("/repos/new"));
    const release = holdLock();
    expect(() => a.store.close()).toThrow(StoreError);
    release();
    expect(() => a.store.getWorktree(W)).toThrow(/closed/);
    expect(disk().worktrees[row("/repos/new").worktreeId]).toBeUndefined();
  });
});

describe("files changed behind the store's back", () => {
  it("makes a repository read-only once a newer Treepeek wrote it, logging it once", () => {
    const { a } = twoProcesses();
    a.store.setMarks(W, [mark("a.txt")]);
    const newer = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, commonDir: COMMON });
    writeFileSync(join(dir, FILE), newer);
    // Reads answer from the last copy read.
    expect(a.store.getMarks(W).map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(() => a.store.setMarks(W, [mark("b.txt")])).toThrow(/newer Treepeek/);
    expect(() => a.store.deleteMarks(W)).toThrow(/newer Treepeek/);
    a.store.upsertWorktree(row(undefined, { lastSeenAt: "2025-09-01T00:00:00Z" }));
    a.store.deleteWorktree(W);
    a.store.flush();
    a.store.close();
    expect(readFileSync(join(dir, FILE), "utf8")).toBe(newer);
    expect(readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(false);
    expect(a.log.warnings).toEqual([
      "a newer Treepeek wrote a store file; this process no longer writes it",
    ]);
  });

  it("writes over a damaged file from the last copy it read, without setting it aside", () => {
    const { a } = twoProcesses();
    a.store.setMarks(W, [mark("a.txt")]);
    writeFileSync(join(dir, FILE), "{ not json");
    expect(a.store.getMarks(W).map((entry) => entry.path)).toEqual(["a.txt"]);
    a.store.setMarks(W, [mark("b.txt")]);
    expect(diskPaths()).toEqual(["a.txt", "b.txt"]);
    expect(readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(false);
    expect(a.log.warnings).toHaveLength(1);
  });

  it("starts a repository whose file was deleted empty", () => {
    const { a } = twoProcesses();
    a.store.setMarks(W, [mark("a.txt")]);
    rmSync(join(dir, FILE));
    expect(a.store.getWorktree(W)).toBeNull();
    expect(a.store.getMarks(W)).toEqual([]);
    a.store.upsertWorktree(row());
    a.store.close();
    expect(existsSync(join(dir, FILE))).toBe(true);
    expect(Object.keys(disk().worktrees)).toEqual([W]);
  });
});
