import { describe, expect, it } from "vitest";
import {
  type MarkChange,
  mergeDocument,
  mergeRows,
  PendingChanges,
  type RepositoryDocument,
  type StoredMark,
  type StoredWorktree,
  worktreeState,
} from "../../../../src/core/store/json-merge";

const W = "w".repeat(64);
const OTHER = "o".repeat(64);
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

const mark = (viewedAt: string, resultHash = H1, snapshotHash: string | null = null) => ({
  resultHash,
  viewedAt,
  snapshotHash,
});

const row = (overrides: Partial<StoredWorktree> = {}): StoredWorktree => ({
  checkoutPath: "/repos/app",
  startCommit: "a".repeat(40),
  startObservedAt: "2025-01-01T00:00:00Z",
  firstSeenAt: "2025-02-01T00:00:00Z",
  lastSeenAt: "2025-02-01T00:00:00Z",
  ...overrides,
});

function documentWith(
  marks: Record<string, StoredMark> = {},
  extra: Partial<RepositoryDocument> = {},
): RepositoryDocument {
  return {
    schemaVersion: 2,
    commonDir: "/repos/app/.git",
    worktrees: { [W]: row() },
    startOverrides: {},
    marks: Object.keys(marks).length > 0 ? { [W]: marks } : {},
    ...extra,
  };
}

function pendingMark(path: string, change: MarkChange): PendingChanges {
  const pending = new PendingChanges();
  pending.setMark(W, path, change);
  return pending;
}

const T0 = "2025-07-01T00:00:00Z";
const T1 = "2025-07-01T00:00:01Z";
const T2 = "2025-07-01T00:00:02Z";
const T3 = "2025-07-01T00:00:03Z";

describe("mergeDocument: marks", () => {
  it("applies any change to a key the disk still holds as its base", () => {
    const base = mark(T0);
    const disk = documentWith({ "a.txt": base, "b.txt": base, "c.txt": mark(T0, H1, H1) });
    // A set older than the disk mark still applies: there is no conflict to judge.
    const set = mergeDocument(
      disk,
      pendingMark("a.txt", { kind: "set", mark: mark("2024-01-01T00:00:00Z", H2), base }),
    );
    expect(set.document.marks[W]?.["a.txt"]).toEqual(mark("2024-01-01T00:00:00Z", H2));
    // So does a removal timed before the mark.
    const removal = mergeDocument(
      disk,
      pendingMark("b.txt", { kind: "remove", at: "2024-01-01T00:00:00Z", base }),
    );
    expect(removal.document.marks[W]?.["b.txt"]).toBeUndefined();
    expect(removal.document.marks[W]?.["a.txt"]).toEqual(base);
    const unlink = mergeDocument(
      disk,
      pendingMark("c.txt", { kind: "unlink", snapshotHash: H1, base: mark(T0, H1, H1) }),
    );
    expect(unlink.document.marks[W]?.["c.txt"]).toEqual(mark(T0, H1, null));
  });

  it("adds a set to a key that was empty and still is", () => {
    const result = mergeDocument(
      documentWith(),
      pendingMark("a.txt", { kind: "set", mark: mark(T1), base: null }),
    );
    expect(result.document.marks[W]).toEqual({ "a.txt": mark(T1) });
  });

  it("over a mark another process changed, the later viewedAt wins, a tie the change", () => {
    const base = mark(T0);
    const disk = documentWith({ "a.txt": mark(T2, H2) });
    const older = mergeDocument(disk, pendingMark("a.txt", { kind: "set", mark: mark(T1), base }));
    expect(older.document.marks[W]?.["a.txt"]).toEqual(mark(T2, H2));
    expect(older.pending.isEmpty).toBe(true);
    const newer = mergeDocument(disk, pendingMark("a.txt", { kind: "set", mark: mark(T3), base }));
    expect(newer.document.marks[W]?.["a.txt"]).toEqual(mark(T3));
    const tie = mergeDocument(
      disk,
      pendingMark("a.txt", { kind: "set", mark: mark(T2, H1), base }),
    );
    expect(tie.document.marks[W]?.["a.txt"]).toEqual(mark(T2, H1));
  });

  it("a removal at T takes a changed mark viewed at or before T, and keeps one viewed after", () => {
    const base = mark(T0);
    const disk = documentWith({ "a.txt": mark(T2, H2) });
    const before = mergeDocument(disk, pendingMark("a.txt", { kind: "remove", at: T1, base }));
    expect(before.document.marks[W]?.["a.txt"]).toEqual(mark(T2, H2));
    expect(before.pending.isEmpty).toBe(true);
    const after = mergeDocument(disk, pendingMark("a.txt", { kind: "remove", at: T3, base }));
    expect(after.document.marks).toEqual({});
    const tie = mergeDocument(disk, pendingMark("a.txt", { kind: "remove", at: T2, base }));
    expect(tie.document.marks).toEqual({});
  });

  it("a set wins over a key another process removed, whatever the times", () => {
    const result = mergeDocument(
      documentWith(),
      pendingMark("a.txt", { kind: "set", mark: mark(T0), base: mark(T3) }),
    );
    expect(result.document.marks[W]?.["a.txt"]).toEqual(mark(T0));
  });

  it("a removal of a key already gone has nothing left to do", () => {
    const result = mergeDocument(
      documentWith(),
      pendingMark("a.txt", { kind: "remove", at: T1, base: mark(T0) }),
    );
    expect(result.document.marks).toEqual({});
    expect(result.pending.isEmpty).toBe(true);
  });

  it("drops a snapshot unlink when the mark changed", () => {
    const base = mark(T0, H1, H1);
    const changed = documentWith({ "a.txt": mark(T1, H1, H1) });
    const result = mergeDocument(
      changed,
      pendingMark("a.txt", { kind: "unlink", snapshotHash: H1, base }),
    );
    expect(result.document.marks[W]?.["a.txt"]).toEqual(mark(T1, H1, H1));
    expect(result.pending.isEmpty).toBe(true);
    const gone = mergeDocument(
      documentWith(),
      pendingMark("a.txt", { kind: "unlink", snapshotHash: H1, base }),
    );
    expect(gone.document.marks).toEqual({});
  });

  it("keeps the changes that won, rebased on the disk value", () => {
    const disk = documentWith({ "a.txt": mark(T1, H2) });
    const pending = new PendingChanges();
    pending.setMark(W, "a.txt", { kind: "set", mark: mark(T3), base: mark(T0) });
    pending.setMark(W, "b.txt", { kind: "set", mark: mark(T0), base: mark(T0) });
    const { pending: survivors } = mergeDocument(disk, pending);
    expect(survivors.markChange(W, "a.txt")).toEqual({
      kind: "set",
      mark: mark(T3),
      base: mark(T1, H2),
    });
    // The key is gone on disk now, and the set still wins: its base becomes "none".
    expect(survivors.markChange(W, "b.txt")).toEqual({ kind: "set", mark: mark(T0), base: null });
  });

  it("leaves other worktrees' marks and other paths as the disk has them", () => {
    const disk = documentWith(
      { "keep.txt": mark(T0) },
      {
        worktrees: { [W]: row(), [OTHER]: row({ checkoutPath: "/repos/other" }) },
      },
    );
    disk.marks[OTHER] = { "x.txt": mark(T0) };
    const result = mergeDocument(
      disk,
      pendingMark("a.txt", { kind: "set", mark: mark(T1), base: null }),
    );
    expect(result.document.marks).toEqual({
      [W]: { "keep.txt": mark(T0), "a.txt": mark(T1) },
      [OTHER]: { "x.txt": mark(T0) },
    });
  });

  it("changes neither of its arguments", () => {
    const disk = documentWith({ "a.txt": mark(T0) });
    const frozen = structuredClone(disk);
    const pending = pendingMark("a.txt", { kind: "remove", at: T1, base: mark(T0) });
    mergeDocument(disk, pending);
    expect(disk).toEqual(frozen);
    expect(pending.markChange(W, "a.txt")).toEqual({ kind: "remove", at: T1, base: mark(T0) });
  });
});

describe("mergeDocument: start overrides", () => {
  const override = (commit: string, setAt: string) => ({ commit, setAt });

  it("applies a change over an unchanged base, and decides changed ones by setAt", () => {
    const base = override(H1, T0);
    const pending = (change: Parameters<PendingChanges["overrides"]["set"]>[1]) => {
      const changes = new PendingChanges();
      changes.overrides.set(W, change);
      return changes;
    };
    const unchanged = documentWith({}, { startOverrides: { [W]: base } });
    expect(
      mergeDocument(unchanged, pending({ kind: "remove", at: "2024-01-01T00:00:00Z", base }))
        .document.startOverrides,
    ).toEqual({});

    const changed = documentWith({}, { startOverrides: { [W]: override(H2, T2) } });
    expect(
      mergeDocument(changed, pending({ kind: "set", override: override(H1, T1), base })).document
        .startOverrides[W],
    ).toEqual(override(H2, T2));
    expect(
      mergeDocument(changed, pending({ kind: "set", override: override(H1, T3), base })).document
        .startOverrides[W],
    ).toEqual(override(H1, T3));
    expect(
      mergeDocument(changed, pending({ kind: "remove", at: T1, base })).document.startOverrides[W],
    ).toEqual(override(H2, T2));
    expect(
      mergeDocument(changed, pending({ kind: "remove", at: T3, base })).document.startOverrides,
    ).toEqual({});
    // Removed by another process meanwhile: the set wins.
    expect(
      mergeDocument(documentWith(), pending({ kind: "set", override: override(H1, T0), base }))
        .document.startOverrides[W],
    ).toEqual(override(H1, T0));
  });
});

describe("mergeDocument: worktree rows", () => {
  it("adds a row the disk does not hold, and merges one it does field by field", () => {
    const pending = new PendingChanges();
    pending.upserts.set(OTHER, row({ checkoutPath: "/repos/other" }));
    pending.upserts.set(
      W,
      row({
        startObservedAt: "2025-01-05T00:00:00Z",
        firstSeenAt: "2025-03-01T00:00:00Z",
        lastSeenAt: "2025-03-01T00:00:00Z",
      }),
    );
    const disk = documentWith(
      {},
      {
        worktrees: {
          [W]: row({
            startObservedAt: null,
            firstSeenAt: "2025-02-01T00:00:00Z",
            lastSeenAt: "2025-04-01T00:00:00Z",
          }),
        },
      },
    );
    const { document } = mergeDocument(disk, pending);
    expect(document.worktrees[OTHER]).toEqual(row({ checkoutPath: "/repos/other" }));
    expect(document.worktrees[W]).toEqual(
      row({
        startObservedAt: "2025-01-05T00:00:00Z",
        firstSeenAt: "2025-02-01T00:00:00Z",
        lastSeenAt: "2025-04-01T00:00:00Z",
      }),
    );
  });

  it("mergeRows keeps a known start, the earliest first sighting and the latest last one", () => {
    const disk = row({
      startObservedAt: "2025-01-01T00:00:00Z",
      firstSeenAt: "2025-03-01T00:00:00Z",
      lastSeenAt: "2025-03-01T00:00:00Z",
    });
    const mine = row({
      startObservedAt: "2025-01-09T00:00:00Z",
      firstSeenAt: "2025-02-01T00:00:00Z",
      lastSeenAt: "2025-02-15T00:00:00Z",
    });
    expect(mergeRows(disk, mine)).toEqual(
      row({
        startObservedAt: "2025-01-01T00:00:00Z",
        firstSeenAt: "2025-02-01T00:00:00Z",
        lastSeenAt: "2025-03-01T00:00:00Z",
      }),
    );
  });
});

describe("mergeDocument: worktree deletes", () => {
  const disk = () =>
    documentWith({ "a.txt": mark(T0) }, { startOverrides: { [W]: { commit: H1, setAt: T0 } } });
  const deleting = (document: RepositoryDocument) => {
    const pending = new PendingChanges();
    pending.deletes.set(W, { base: worktreeState(document, W) });
    return pending;
  };

  it("takes the row, override and marks when nothing changed since they were read", () => {
    const { document, pending } = mergeDocument(disk(), deleting(disk()));
    expect(document.worktrees).toEqual({});
    expect(document.startOverrides).toEqual({});
    expect(document.marks).toEqual({});
    expect(pending.deletes.has(W)).toBe(true);
  });

  it("is dropped as a whole when another process scanned the worktree or changed it", () => {
    const changes: ((document: RepositoryDocument) => void)[] = [
      (document) => {
        document.worktrees[W] = row({ lastSeenAt: "2025-09-01T00:00:00Z" });
      },
      (document) => {
        document.startOverrides[W] = { commit: H2, setAt: T1 };
      },
      (document) => {
        delete document.startOverrides[W];
      },
      (document) => {
        document.marks[W] = { "a.txt": mark(T0), "b.txt": mark(T1) };
      },
      (document) => {
        document.marks[W] = { "a.txt": mark(T1) };
      },
      (document) => {
        delete document.marks[W];
      },
    ];
    for (const change of changes) {
      const now = disk();
      change(now);
      const { document, pending } = mergeDocument(now, deleting(disk()));
      expect(document).toEqual(now);
      expect(pending.isEmpty).toBe(true);
    }
  });

  it("applies changes made after the delete to what it left", () => {
    const pending = deleting(disk());
    pending.upserts.set(W, row({ lastSeenAt: "2025-09-01T00:00:00Z" }));
    pending.setMark(W, "z.txt", { kind: "set", mark: mark(T2), base: null });
    const { document } = mergeDocument(disk(), pending);
    expect(document.worktrees[W]).toEqual(row({ lastSeenAt: "2025-09-01T00:00:00Z" }));
    expect(document.startOverrides).toEqual({});
    expect(document.marks[W]).toEqual({ "z.txt": mark(T2) });
  });
});
