import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneAfterScan, pruneOnStartup } from "../../../../src/core/review/prune";
import { resolveIdentity, worktreeId } from "../../../../src/core/store/identity";
import { openReviewStore } from "../../../../src/core/store/open-store";
import type { ReviewStore, WorktreeRow } from "../../../../src/core/store/review-store";
import { REVIEW_LIMITS } from "../../../../src/shared/constants";
import type { WorktreeChoice } from "../../../../src/shared/domain/scan";

const ROOT = "/scans/root";
const OTHER_ROOT = "/scans/other";
const COMMON = "/scans/root/app/.git";
const GONE = "/scans/root/app-gone";
const KEPT = "/scans/root/app-kept";
const ELSEWHERE = "/elsewhere/app-other";
const IN_OTHER_ROOT = "/scans/other/app-there";
const START = "1".repeat(40);
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);

/** The fake clock: day 0 is when every identity was last seen. */
const DAY0 = Date.parse("2025-03-01T00:00:00Z");
const day = (n: number) => new Date(DAY0 + n * 24 * 60 * 60 * 1000);

let userData: string;
let store: ReviewStore;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "treepeek-prune-"));
  store = openReviewStore(userData);
});
afterEach(() => {
  store.close();
  rmSync(userData, { recursive: true, force: true });
});

function seen(checkoutPath: string): WorktreeRow {
  const row: WorktreeRow = {
    worktreeId: worktreeId(COMMON, checkoutPath, START),
    commonDir: COMMON,
    checkoutPath,
    startCommit: START,
    startObservedAt: "2025-01-01T00:00:00Z",
    firstSeenAt: "2025-02-01T00:00:00Z",
    lastSeenAt: "2025-03-01T00:00:00Z",
  };
  store.upsertWorktree(row);
  return row;
}

/** What a desktop scan of `ROOT` gives pruning: its walked checkouts only. */
const scan = (
  listed: string[],
  worktrees: WorktreeChoice = "walked",
  roots: string[] = [ROOT],
) => ({
  roots: roots.map((path) => ({ path, folders: [] })),
  worktrees,
  listedCheckouts: new Map([[COMMON, new Set(listed)]]),
});

describe("pruneAfterScan", () => {
  it("keeps a worktree Git no longer lists for 29 days, and forgets it on day 31", () => {
    const gone = seen(GONE);
    const kept = seen(KEPT);
    store.setStartOverride(gone.worktreeId, "2".repeat(40), "2025-02-02T00:00:00Z");
    store.putSnapshot(H1, new Uint8Array(4));
    store.putSnapshot(H2, new Uint8Array(4));
    store.setMarks(gone.worktreeId, [
      { path: "a.txt", resultHash: H1, viewedAt: "2025-02-03T00:00:00Z", snapshotHash: H1 },
      { path: "b.txt", resultHash: H2, viewedAt: "2025-02-03T00:00:00Z", snapshotHash: H2 },
    ]);
    // The same content viewed in a worktree that stays keeps its snapshot.
    store.setMarks(kept.worktreeId, [
      { path: "b.txt", resultHash: H2, viewedAt: "2025-02-03T00:00:00Z", snapshotHash: H2 },
    ]);

    expect(pruneAfterScan(store, scan([KEPT]), { now: day(29) })).toEqual({
      worktrees: 0,
      snapshots: 0,
    });
    expect(store.getWorktree(gone.worktreeId)).not.toBeNull();
    expect(store.getMarks(gone.worktreeId)).toHaveLength(2);

    expect(pruneAfterScan(store, scan([KEPT]), { now: day(31) }).worktrees).toBe(1);
    expect(store.getWorktree(gone.worktreeId)).toBeNull();
    expect(store.getStartOverride(gone.worktreeId)).toBeNull();
    expect(store.getMarks(gone.worktreeId)).toEqual([]);
    expect(store.hasSnapshot(H1)).toBe(false);
    expect(store.hasSnapshot(H2)).toBe(true);
    expect(store.getMarks(kept.worktreeId)).toHaveLength(1);
  });

  it("never forgets a worktree outside the scan root, or one Git still lists", () => {
    const outside = seen(ELSEWHERE);
    const listed = seen(KEPT);
    expect(pruneAfterScan(store, scan([]), { now: day(400) }).worktrees).toBe(1);
    expect(store.getWorktree(outside.worktreeId)).not.toBeNull();
    expect(store.getWorktree(listed.worktreeId)).toBeNull();

    const again = seen(KEPT);
    expect(pruneAfterScan(store, scan([KEPT]), { now: day(400) }).worktrees).toBe(0);
    expect(store.getWorktree(again.worktreeId)).not.toBeNull();
    // A repository the scan did not list at all is not judged either.
    expect(
      pruneAfterScan(
        store,
        { roots: [{ path: ROOT, folders: [] }], worktrees: "all", listedCheckouts: new Map() },
        { now: day(400) },
      ).worktrees,
    ).toBe(0);
  });

  it("judges a worktree under any scan root, and anywhere when the scan lists outside ones", () => {
    const elsewhere = seen(ELSEWHERE);
    const other = seen(IN_OTHER_ROOT);
    seen(KEPT);
    // Inside only: under one of the roots, but not elsewhere.
    expect(
      pruneAfterScan(store, scan([KEPT], "inside", [ROOT, OTHER_ROOT]), { now: day(31) }),
    ).toMatchObject({ worktrees: 1 });
    expect(store.getWorktree(other.worktreeId)).toBeNull();
    expect(store.getWorktree(elsewhere.worktreeId)).not.toBeNull();
    // Every worktree Git lists: an outside one Git no longer lists goes after 30 days.
    expect(pruneAfterScan(store, scan([KEPT], "all"), { now: day(29) }).worktrees).toBe(0);
    expect(store.getWorktree(elsewhere.worktreeId)).not.toBeNull();
    expect(pruneAfterScan(store, scan([KEPT], "all"), { now: day(31) }).worktrees).toBe(1);
    expect(store.getWorktree(elsewhere.worktreeId)).toBeNull();
  });

  it("over the cap, drops unreferenced snapshots, then the oldest marks' snapshots", () => {
    const row = seen(KEPT);
    store.putSnapshot(H1, new Uint8Array(100));
    store.putSnapshot(H2, new Uint8Array(100));
    store.putSnapshot(H3, new Uint8Array(100));
    store.setMarks(row.worktreeId, [
      { path: "old.txt", resultHash: H1, viewedAt: "2025-02-01T00:00:00Z", snapshotHash: H1 },
      { path: "new.txt", resultHash: H2, viewedAt: "2025-02-09T00:00:00Z", snapshotHash: H2 },
    ]);
    expect(pruneAfterScan(store, scan([KEPT]), { capBytes: 200 }).snapshots).toBe(1);
    expect(store.hasSnapshot(H3)).toBe(false);
    expect(pruneAfterScan(store, scan([KEPT]), { capBytes: 100 }).snapshots).toBe(1);
    expect(store.hasSnapshot(H1)).toBe(false);
    expect(store.getMarks(row.worktreeId).find((mark) => mark.path === "old.txt")).toMatchObject({
      resultHash: H1,
      snapshotHash: null,
    });
    expect(store.hasSnapshot(H2)).toBe(true);
    expect(REVIEW_LIMITS.storeCapBytes).toBe(500 * 1024 * 1024);
  });
});

describe("pruneOnStartup", () => {
  it("deletes every unreferenced snapshot, then applies the cap", () => {
    const row = seen(KEPT);
    store.putSnapshot(H1, new Uint8Array(10));
    store.putSnapshot(H2, new Uint8Array(10));
    store.setMarks(row.worktreeId, [
      { path: "a.txt", resultHash: H1, viewedAt: "2025-02-01T00:00:00Z", snapshotHash: H1 },
    ]);
    expect(pruneOnStartup(store)).toBe(1);
    expect(store.snapshotUsage()).toEqual({ count: 1, bytes: 10 });
    expect(pruneOnStartup(store, { capBytes: 5 })).toBe(1);
    expect(store.snapshotUsage()).toEqual({ count: 0, bytes: 0 });
  });
});

describe("marks and the identity fallback", () => {
  const PATH = "/scans/root/app-feature";
  const marked = (id: string) => store.getMarks(id).map((mark) => mark.path);

  function markUnder(start: string | null) {
    const resolved = resolveIdentity(store, {
      commonDir: COMMON,
      checkoutPath: PATH,
      reflogStart: start ? { commit: start, observedAt: "2025-01-01T00:00:00Z" } : null,
    });
    store.setMarks(resolved.worktreeId, [
      {
        path: `${start ?? "none"}.txt`,
        resultHash: H1,
        viewedAt: "2025-02-01T00:00:00Z",
        snapshotHash: null,
      },
    ]);
    return resolved.worktreeId;
  }

  const expired = () =>
    resolveIdentity(store, { commonDir: COMMON, checkoutPath: PATH, reflogStart: null }).worktreeId;

  it("attaches old marks to a worktree whose start expired, with exactly one earlier identity", () => {
    const first = markUnder(START);
    expect(marked(expired())).toEqual([`${START}.txt`]);
    expect(expired()).toBe(first);
  });

  it("gives a worktree recreated at the same path with a new start none of the old marks", () => {
    markUnder(START);
    const recreated = resolveIdentity(store, {
      commonDir: COMMON,
      checkoutPath: PATH,
      reflogStart: { commit: "9".repeat(40), observedAt: "2025-04-01T00:00:00Z" },
    }).worktreeId;
    expect(marked(recreated)).toEqual([]);
  });

  it("starts fresh when the start expired and two earlier identities could own the marks", () => {
    markUnder(START);
    markUnder("2".repeat(40));
    expect(marked(expired())).toEqual([]);
  });

  it("never reaches another path's marks", () => {
    markUnder(START);
    const elsewhere = resolveIdentity(store, {
      commonDir: COMMON,
      checkoutPath: `${PATH}-2`,
      reflogStart: null,
    }).worktreeId;
    expect(marked(elsewhere)).toEqual([]);
  });
});
