import { describe, expect, it } from "vitest";
import { keys } from "../../../src/renderer/data/keys";
import {
  applyRefreshCheckout,
  applyRefreshTimeline,
  KIND_TO_KEYS,
  pruneRemoved,
  staleKeys,
} from "../../../src/renderer/data/refresh-sync";
import { emptyScan, orderedCheckouts, type ScanData } from "../../../src/renderer/data/scan-model";
import { CHANGE_KINDS } from "../../../src/shared/domain/change";
import type { Checkout, FolderNode, TimelineEntry } from "../../../src/shared/domain/scan";

const ROOT = "/w";
const COMMON = "/w/app/.git";

function checkout(path: string, overrides: Partial<Checkout> = {}): Checkout {
  return {
    path,
    kind: "linked",
    branch: "main",
    head: "a".repeat(40),
    upstream: null,
    originUrl: null,
    start: { commit: "b".repeat(40), observedAt: "2026-01-01T00:00:00Z", source: "reflog" },
    working: { staged: 0, unstaged: 0, untracked: 0 },
    history: { commits: 1, files: 1 },
    ...overrides,
  };
}

function folder(relative: string, checkoutPath: string | null = null): FolderNode {
  const slash = relative.lastIndexOf("/");
  return {
    name: relative === "" ? "w" : relative.slice(slash + 1),
    relativePath: relative,
    depth: relative === "" ? 0 : relative.split("/").length,
    parent: relative === "" ? null : slash < 0 ? "" : relative.slice(0, slash),
    checkoutPath,
  };
}

function entry(sequence: number, path: string, predecessor: string | null): TimelineEntry {
  return {
    sequence,
    checkoutPath: path,
    commonDir: COMMON,
    predecessor,
    relation: predecessor ? "after" : "first",
  };
}

/** One repository with three checkouts, one of them nested. */
function scan(): ScanData {
  const paths = ["/w/app", "/w/wt-a", "/w/nested/wt-b"];
  return {
    ...emptyScan(ROOT),
    phase: "done",
    folders: [
      folder(""),
      folder("app", "/w/app"),
      folder("nested"),
      folder("nested/wt-b", "/w/nested/wt-b"),
      folder("wt-a", "/w/wt-a"),
    ],
    checkouts: Object.fromEntries(paths.map((path) => [path, checkout(path)])),
    arrival: paths,
    timeline: [
      entry(1, "/w/app", null),
      entry(2, "/w/wt-a", "/w/app"),
      entry(3, "/w/nested/wt-b", "/w/wt-a"),
    ],
    repositories: [{ commonDir: COMMON, displayName: "app", checkouts: paths }],
  };
}

describe("KIND_TO_KEYS", () => {
  it("names a key list for every change kind", () => {
    expect(Object.keys(KIND_TO_KEYS).sort()).toEqual([...CHANGE_KINDS].sort());
  });

  it("refetches a checkout's lists and review status after an edit, but never a diff", () => {
    const stale = staleKeys(
      { checkoutPath: "/w/wt-a", checkout: checkout("/w/wt-a"), changed: ["workingTree", "index"] },
      scan(),
    );
    expect(stale).toEqual([keys.checkoutComparisons("/w/wt-a"), keys.reviewStatus("/w/wt-a")]);
    expect(stale.some((key) => key[0] === "fileDiff")).toBe(false);
  });

  it("refetches only comparison lists when refs or the upstream moved", () => {
    expect(
      staleKeys(
        { checkoutPath: "/w/app", checkout: checkout("/w/app"), changed: ["refs", "upstream"] },
        scan(),
      ),
    ).toEqual([keys.checkoutComparisons("/w/app")]);
  });

  it("refetches the comparisons of the next checkout when a HEAD moved", () => {
    expect(
      staleKeys(
        { checkoutPath: "/w/wt-a", checkout: checkout("/w/wt-a"), changed: ["head"] },
        scan(),
      ),
    ).toEqual([
      keys.checkoutComparisons("/w/wt-a"),
      keys.reviewStatus("/w/wt-a"),
      keys.checkoutComparisons("/w/nested/wt-b"),
    ]);
  });

  it("keeps everything of a removed or new checkout", () => {
    for (const changed of [["removed"], ["structure"]] as const) {
      expect(
        staleKeys(
          { checkoutPath: "/w/wt-a", checkout: checkout("/w/wt-a"), changed: [...changed] },
          scan(),
        ),
      ).toEqual([]);
    }
  });
});

describe("applyRefreshCheckout", () => {
  it("replaces a checkout's data in place", () => {
    const next = applyRefreshCheckout(
      scan(),
      {
        checkoutPath: "/w/wt-a",
        checkout: checkout("/w/wt-a", { working: { staged: 0, unstaged: 2, untracked: 1 } }),
        changed: ["workingTree"],
      },
      null,
    );
    expect(next.checkouts["/w/wt-a"]?.working).toEqual({ staged: 0, unstaged: 2, untracked: 1 });
    expect(next.arrival).toEqual(scan().arrival);
  });

  it("adds a new checkout in arrival order, before its timeline arrives", () => {
    const next = applyRefreshCheckout(
      scan(),
      { checkoutPath: "/w/wt-c", checkout: checkout("/w/wt-c"), changed: ["structure"] },
      null,
    );
    expect(orderedCheckouts(next)).toEqual(["/w/app", "/w/wt-a", "/w/nested/wt-b", "/w/wt-c"]);
  });

  it("drops a removed checkout at once unless it is selected", () => {
    const removed = {
      checkoutPath: "/w/wt-a",
      checkout: checkout("/w/wt-a"),
      changed: ["removed" as const],
    };
    const gone = applyRefreshCheckout(scan(), removed, "/w/app");
    expect("/w/wt-a" in gone.checkouts).toBe(false);
    expect(gone.timeline.map((item) => item.checkoutPath)).toEqual(["/w/app", "/w/nested/wt-b"]);
    expect(gone.folders.some((item) => item.checkoutPath === "/w/wt-a")).toBe(false);

    const kept = applyRefreshCheckout(scan(), removed, "/w/wt-a");
    expect("/w/wt-a" in kept.checkouts).toBe(true);
    expect(kept.removed).toEqual({ "/w/wt-a": [] });
  });
});

describe("applyRefreshTimeline and pruneRemoved", () => {
  it("keeps a removed, selected checkout in the timeline and the folder tree until the person moves on", () => {
    const removed = applyRefreshCheckout(
      scan(),
      {
        checkoutPath: "/w/nested/wt-b",
        checkout: checkout("/w/nested/wt-b"),
        changed: ["removed"],
      },
      "/w/nested/wt-b",
    );
    // The core service's view: wt-b and its now empty folder are gone.
    const next = applyRefreshTimeline(removed, {
      timeline: [entry(1, "/w/app", null), entry(2, "/w/wt-a", "/w/app")],
      repositories: [{ commonDir: COMMON, displayName: "app", checkouts: ["/w/app", "/w/wt-a"] }],
      folders: [folder(""), folder("app", "/w/app"), folder("wt-a", "/w/wt-a")],
      problems: [],
    });
    expect(next.timeline.map((item) => item.checkoutPath)).toEqual([
      "/w/app",
      "/w/wt-a",
      "/w/nested/wt-b",
    ]);
    expect(next.folders.map((item) => item.relativePath)).toEqual([
      "",
      "app",
      "nested",
      "nested/wt-b",
      "wt-a",
    ]);
    expect(next.removed).toEqual({ "/w/nested/wt-b": ["nested/wt-b", "nested"] });

    const pruned = pruneRemoved(next, "/w/app");
    expect("/w/nested/wt-b" in pruned.checkouts).toBe(false);
    expect(pruned.timeline.map((item) => item.checkoutPath)).toEqual(["/w/app", "/w/wt-a"]);
    expect(pruned.folders.map((item) => item.relativePath)).toEqual(["", "app", "wt-a"]);
    expect(pruned.removed).toEqual({});
    // Still selected: nothing is pruned.
    expect(pruneRemoved(next, "/w/nested/wt-b")).toBe(next);
  });

  it("takes a new checkout's place, folders and problems from the timeline event", () => {
    const added = applyRefreshCheckout(
      scan(),
      { checkoutPath: "/w/wt-c", checkout: checkout("/w/wt-c"), changed: ["structure"] },
      null,
    );
    const next = applyRefreshTimeline(added, {
      timeline: [...scan().timeline, entry(4, "/w/wt-c", "/w/nested/wt-b")],
      repositories: scan().repositories,
      folders: [...scan().folders, folder("wt-c", "/w/wt-c")],
      problems: [{ path: "/w/broken", code: "dubiousOwnership", message: "no" }],
    });
    expect(orderedCheckouts(next)).toEqual(["/w/app", "/w/wt-a", "/w/nested/wt-b", "/w/wt-c"]);
    expect(next.folders.at(-1)?.checkoutPath).toBe("/w/wt-c");
    expect(next.problems).toHaveLength(1);
  });
});
