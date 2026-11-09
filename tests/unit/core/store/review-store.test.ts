import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeSqlite } from "../../../../src/core/probe-sqlite";
import { resolveIdentity, worktreeId } from "../../../../src/core/store/identity";
import { openReviewStore } from "../../../../src/core/store/open-store";
import type {
  ReviewStore,
  StoreEngine,
  WorktreeRow,
} from "../../../../src/core/store/review-store";

/** SQLite runs only where the Node running the tests provides `node:sqlite`. */
const sqliteAvailable = probeSqlite().available;
const engines: StoreEngine[] = sqliteAvailable ? ["sqlite", "json"] : ["json"];

const COMMON = "/repos/app/.git";
const PATH = "/repos/app-feature";
const S1 = "1".repeat(40);
const S2 = "2".repeat(40);
const S3 = "3".repeat(40);

function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  const startCommit = overrides.startCommit === undefined ? S1 : overrides.startCommit;
  return {
    worktreeId: worktreeId(COMMON, PATH, startCommit),
    commonDir: COMMON,
    checkoutPath: PATH,
    startCommit,
    startObservedAt: "2025-01-01T00:00:00Z",
    firstSeenAt: "2025-02-01T00:00:00Z",
    lastSeenAt: "2025-02-01T00:00:00Z",
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe.each(engines)("ReviewStore (%s engine)", (engine) => {
  let userData: string;
  let store: ReviewStore;
  const open = () => openReviewStore(userData, { engine });

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), `treepeek-store-${engine}-`));
    store = open();
  });
  afterEach(() => {
    store.close();
    rmSync(userData, { recursive: true, force: true });
  });

  it("reports its engine", () => {
    expect(store.engine).toBe(engine);
  });

  describe("worktree rows", () => {
    it("stores and returns a row", () => {
      const first = row();
      store.upsertWorktree(first);
      expect(store.getWorktree(first.worktreeId)).toEqual(first);
      expect(store.getWorktree("nope")).toBeNull();
    });

    it("keeps the first sighting and start, and moves lastSeenAt forward only", () => {
      store.upsertWorktree(row({ startObservedAt: null }));
      store.upsertWorktree(
        row({
          firstSeenAt: "2025-03-01T00:00:00Z",
          lastSeenAt: "2025-03-01T00:00:00Z",
          startObservedAt: "2025-01-05T00:00:00Z",
        }),
      );
      store.upsertWorktree(row({ lastSeenAt: "2025-02-15T00:00:00Z" }));
      expect(store.getWorktree(row().worktreeId)).toEqual(
        row({
          firstSeenAt: "2025-02-01T00:00:00Z",
          lastSeenAt: "2025-03-01T00:00:00Z",
          startObservedAt: "2025-01-05T00:00:00Z",
        }),
      );
    });

    it("finds every identity of one path in one repository, oldest first", () => {
      store.upsertWorktree(row({ startCommit: S2, firstSeenAt: "2025-05-01T00:00:00Z" }));
      store.upsertWorktree(row({ startCommit: S1, firstSeenAt: "2025-04-01T00:00:00Z" }));
      store.upsertWorktree(row({ startCommit: S3, checkoutPath: "/repos/other" }));
      store.upsertWorktree(
        row({ startCommit: S3, commonDir: "/repos/svc.git", worktreeId: "other-repo" }),
      );
      const found = store.findWorktreesByPath(COMMON, PATH);
      expect(found.map((entry) => entry.startCommit)).toEqual([S1, S2]);
      expect(store.findWorktreesByPath(COMMON, "/repos/none")).toEqual([]);
      expect(store.findWorktreesByPath("/repos/none.git", PATH)).toEqual([]);
    });
  });

  describe("start overrides", () => {
    it("sets, replaces and removes an override", () => {
      store.upsertWorktree(row());
      const id = row().worktreeId;
      expect(store.getStartOverride(id)).toBeNull();
      store.setStartOverride(id, S2, "2025-06-01T00:00:00Z");
      expect(store.getStartOverride(id)).toEqual({
        worktreeId: id,
        commit: S2,
        setAt: "2025-06-01T00:00:00Z",
      });
      store.setStartOverride(id, S3, "2025-06-02T00:00:00Z");
      expect(store.getStartOverride(id)?.commit).toBe(S3);
      store.setStartOverride(id, null);
      expect(store.getStartOverride(id)).toBeNull();
      // Removing what is not there is not an error.
      store.setStartOverride(id, null);
    });

    it("refuses an override for an identity never recorded", () => {
      expect(() => store.setStartOverride("never-seen", S1)).toThrow(/No worktree/);
    });

    it("survives closing and reopening the store", () => {
      store.upsertWorktree(row());
      store.setStartOverride(row().worktreeId, S2, "2025-06-01T00:00:00Z");
      store.close();
      store = open();
      expect(store.getStartOverride(row().worktreeId)).toEqual({
        worktreeId: row().worktreeId,
        commit: S2,
        setAt: "2025-06-01T00:00:00Z",
      });
      expect(store.getWorktree(row().worktreeId)).toEqual(row());
    });
  });

  it("refuses every call once closed", () => {
    store.close();
    expect(() => store.getWorktree("x")).toThrow(/closed/);
    expect(() => store.upsertWorktree(row())).toThrow(/closed/);
    // Closing twice is harmless.
    store.close();
  });

  describe("resolveIdentity", () => {
    it("uses the reflog start's identity and records it as seen", () => {
      const resolved = resolveIdentity(
        store,
        {
          commonDir: COMMON,
          checkoutPath: PATH,
          reflogStart: { commit: S1, observedAt: "2025-01-01T00:00:00Z" },
        },
        at("2025-02-01T00:00:00Z"),
      );
      expect(resolved).toEqual({
        worktreeId: worktreeId(COMMON, PATH, S1),
        start: { commit: S1, observedAt: "2025-01-01T00:00:00Z", source: "reflog" },
        via: "reflog",
      });
      expect(store.getWorktree(resolved.worktreeId)).toEqual(row());
    });

    it("gives a worktree recreated at the same path a new id", () => {
      const first = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: { commit: S1, observedAt: "2025-01-01T00:00:00Z" },
      });
      const recreated = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: { commit: S2, observedAt: "2025-03-01T00:00:00Z" },
      });
      expect(recreated.worktreeId).not.toBe(first.worktreeId);
      expect(store.findWorktreesByPath(COMMON, PATH)).toHaveLength(2);
    });

    it("after the reflog expires, reuses the one earlier identity with its start", () => {
      const before = resolveIdentity(
        store,
        {
          commonDir: COMMON,
          checkoutPath: PATH,
          reflogStart: { commit: S1, observedAt: "2025-01-01T00:00:00Z" },
        },
        at("2025-02-01T00:00:00Z"),
      );
      const after = resolveIdentity(
        store,
        { commonDir: COMMON, checkoutPath: PATH, reflogStart: null },
        at("2025-07-01T00:00:00Z"),
      );
      expect(after).toEqual({
        worktreeId: before.worktreeId,
        start: { commit: S1, observedAt: "2025-01-01T00:00:00Z", source: "override" },
        via: "earlierIdentity",
      });
      expect(store.getWorktree(before.worktreeId)?.lastSeenAt).toBe("2025-07-01T00:00:00Z");
      // No "no start" identity was created beside it.
      expect(store.findWorktreesByPath(COMMON, PATH)).toHaveLength(1);
    });

    it("with two earlier identities, creates a fresh id with an unknown start", () => {
      const first = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: { commit: S1, observedAt: "2025-01-01T00:00:00Z" },
      });
      const second = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: { commit: S2, observedAt: "2025-03-01T00:00:00Z" },
      });
      const expired = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: null,
      });
      expect(expired.via).toBe("fresh");
      expect(expired.start).toEqual({ unknown: true });
      expect(expired.worktreeId).toBe(worktreeId(COMMON, PATH, null));
      expect([first.worktreeId, second.worktreeId]).not.toContain(expired.worktreeId);
    });

    it("with no earlier identity, creates the fresh id once and reuses it", () => {
      const first = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: null,
      });
      const again = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: null,
      });
      expect(first).toEqual(again);
      expect(first).toMatchObject({ via: "fresh", start: { unknown: true } });
      expect(store.findWorktreesByPath(COMMON, PATH)).toHaveLength(1);
    });

    it("ignores identities recorded without a start when looking for an earlier one", () => {
      // Seen first with an expired reflog, later with a start again, then expired once more.
      resolveIdentity(store, { commonDir: COMMON, checkoutPath: PATH, reflogStart: null });
      const known = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: { commit: S2, observedAt: "2025-03-01T00:00:00Z" },
      });
      const expired = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: null,
      });
      expect(expired.worktreeId).toBe(known.worktreeId);
      expect(expired.start).toMatchObject({ commit: S2, source: "override" });
    });

    it("lets the user's override win over the reflog without changing the identity", () => {
      const reflogStart = { commit: S1, observedAt: "2025-01-01T00:00:00Z" };
      const plain = resolveIdentity(store, { commonDir: COMMON, checkoutPath: PATH, reflogStart });
      store.setStartOverride(plain.worktreeId, S3, "2025-06-01T00:00:00Z");
      const overridden = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart,
      });
      expect(overridden).toEqual({
        worktreeId: plain.worktreeId,
        start: { commit: S3, observedAt: "2025-01-01T00:00:00Z", source: "override" },
        via: "reflog",
      });
    });

    it("gives a checkout with no start the user's override, placed when it was set", () => {
      const fresh = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: null,
      });
      store.setStartOverride(fresh.worktreeId, S3, "2025-06-01T00:00:00Z");
      store.close();
      store = open();
      const again = resolveIdentity(store, {
        commonDir: COMMON,
        checkoutPath: PATH,
        reflogStart: null,
      });
      expect(again).toEqual({
        worktreeId: fresh.worktreeId,
        start: { commit: S3, observedAt: "2025-06-01T00:00:00Z", source: "override" },
        via: "fresh",
      });
    });
  });
});

describe("worktreeId", () => {
  it("is a SHA-256 of the three fields, different for each start and for no start", () => {
    const ids = new Set([
      worktreeId(COMMON, PATH, S1),
      worktreeId(COMMON, PATH, S2),
      worktreeId(COMMON, PATH, null),
      worktreeId(COMMON, `${PATH}2`, S1),
      worktreeId("/repos/svc.git", PATH, S1),
    ]);
    expect(ids.size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(worktreeId(COMMON, PATH, S1)).toBe(worktreeId(COMMON, PATH, S1));
  });

  it("cannot be confused by a field that contains the separator of another", () => {
    expect(worktreeId("/a", "b/c", S1)).not.toBe(worktreeId("/a/b", "c", S1));
  });
});

describe("openReviewStore", () => {
  it.runIf(sqliteAvailable)("chooses SQLite when node:sqlite is available", () => {
    const userData = mkdtempSync(join(tmpdir(), "treepeek-store-default-"));
    try {
      const store = openReviewStore(userData);
      expect(store.engine).toBe("sqlite");
      store.close();
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
