import { describe, expect, it } from "vitest";
import { unavailableReason } from "../../../src/renderer/data/comparison-availability";
import { comparisonKey, keys } from "../../../src/renderer/data/keys";
import {
  checkoutCounts,
  emptyScan,
  folderAncestors,
  orderedCheckouts,
  relationLabel,
  relativePath,
  repositoryName,
  repositoryNeighbours,
  type ScanData,
} from "../../../src/renderer/data/scan-model";
import { folderRows } from "../../../src/renderer/panels/navigator/folder-rows";
import { groupTimeline } from "../../../src/renderer/panels/timeline/timeline-groups";
import type { Checkout, FolderNode, TimelineEntry } from "../../../src/shared/domain/scan";

const ROOT = "/w";

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

function entry(
  sequence: number,
  path: string,
  commonDir: string,
  predecessor: string | null,
  relation: TimelineEntry["relation"],
): TimelineEntry {
  return { sequence, checkoutPath: path, commonDir, predecessor, relation };
}

/** Two repositories: app (three checkouts, one nested) and svc; one stale `.git` folder. */
function scan(phase: ScanData["phase"] = "done"): ScanData {
  const paths = ["/w/app", "/w/app-feature", "/w/nested/app-later", "/w/svc"];
  return {
    ...emptyScan(ROOT),
    phase,
    folders: [
      folder(""),
      folder("app", "/w/app"),
      folder("app-feature", "/w/app-feature"),
      folder("nested"),
      folder("nested/app-later", "/w/nested/app-later"),
      folder("stale"),
      folder("stale/old", "/w/stale/old"),
      folder("svc", "/w/svc"),
      folder("unrelated"),
    ],
    checkouts: Object.fromEntries(paths.map((path) => [path, checkout(path)])),
    arrival: ["/w/svc", "/w/app", "/w/app-feature", "/w/nested/app-later"],
    timeline: [
      entry(1, "/w/app", "/w/app/.git", null, "first"),
      entry(2, "/w/app-feature", "/w/app/.git", "/w/app", "after"),
      entry(3, "/w/nested/app-later", "/w/app/.git", "/w/app-feature", "parallel"),
      entry(4, "/w/svc", "/w/svc/.git", null, "first"),
    ],
    repositories: [
      {
        commonDir: "/w/app/.git",
        displayName: "app",
        checkouts: ["/w/app", "/w/app-feature", "/w/nested/app-later"],
      },
      { commonDir: "/w/svc/.git", displayName: "svc", checkouts: ["/w/svc"] },
    ],
  };
}

describe("scan model", () => {
  it("names paths relative to the scan root", () => {
    expect(relativePath(ROOT, "/w/nested/app-later")).toBe("nested/app-later");
    expect(relativePath(ROOT, ROOT)).toBe(".");
    expect(relativePath(ROOT, "/elsewhere")).toBe("/elsewhere");
  });

  it("orders checkouts by the timeline once there is one, by arrival before", () => {
    expect(orderedCheckouts(scan())).toEqual([
      "/w/app",
      "/w/app-feature",
      "/w/nested/app-later",
      "/w/svc",
    ]);
    expect(orderedCheckouts({ ...scan("resolving"), timeline: [] })).toEqual([
      "/w/svc",
      "/w/app",
      "/w/app-feature",
      "/w/nested/app-later",
    ]);
  });

  it("finds the previous and next checkout of the same repository", () => {
    expect(repositoryNeighbours(scan(), "/w/app-feature")).toEqual({
      previous: "/w/app",
      next: "/w/nested/app-later",
    });
    expect(repositoryNeighbours(scan(), "/w/svc")).toEqual({ previous: null, next: null });
    expect(repositoryNeighbours(scan(), "/w/nested/app-later").next).toBeNull();
  });

  it("states relations in the prototype's words", () => {
    const data = scan();
    expect(data.timeline.map((item) => relationLabel(data, item))).toEqual([
      "First in repository",
      "After app",
      "Parallel to app-feature",
      "First in repository",
    ]);
    expect(repositoryName(data, "/w/nested/app-later")).toBe("app");
  });

  it("counts reported checkouts per folder, and finds a checkout's folders", () => {
    const counts = checkoutCounts(scan());
    expect(counts.get("")).toBe(4);
    expect(counts.get("nested")).toBe(1);
    expect(counts.get("stale")).toBeUndefined();
    expect(folderAncestors(scan(), "/w/nested/app-later")).toEqual(["nested", ""]);
  });
});

describe("folder rows", () => {
  it("lists only folders with checkouts once the scan is done, children by name", () => {
    const rows = folderRows(scan(), null);
    expect(rows.map((row) => row.folder.relativePath)).toEqual([
      "",
      "app",
      "app-feature",
      "nested",
      "nested/app-later",
      "svc",
    ]);
    expect(rows.find((row) => row.folder.relativePath === "nested")?.count).toBe(1);
  });

  it("keeps folders with an unconfirmed .git while the scan runs", () => {
    const rows = folderRows(scan("resolving"), null);
    expect(rows.map((row) => row.folder.relativePath)).toContain("stale");
    expect(rows.find((row) => row.folder.relativePath === "stale/old")?.checkoutPath).toBeNull();
  });

  it("shows a collapsed folder's children only once it is expanded", () => {
    const collapsed = folderRows(scan(), new Set([""]));
    expect(collapsed.map((row) => row.folder.relativePath)).not.toContain("nested/app-later");
    const open = folderRows(scan(), new Set(["", "nested"]));
    expect(open.map((row) => row.folder.relativePath)).toContain("nested/app-later");
  });
});

describe("timeline groups", () => {
  it("lists everything in timeline order, or newest first", () => {
    const [all] = groupTimeline(scan(), "all", "oldest");
    expect(all?.entries.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    const [newest] = groupTimeline(scan(), "all", "newest");
    expect(newest?.entries.map((item) => item.sequence)).toEqual([4, 3, 2, 1]);
  });

  it("groups by repository and by containing folder, keeping the numbering", () => {
    const byRepo = groupTimeline(scan(), "repository", "oldest");
    expect(byRepo.map((group) => [group.title, group.entries.map((item) => item.sequence)])).toEqual([
      ["app", [1, 2, 3]],
      ["svc", [4]],
    ]);
    const byFolder = groupTimeline(scan(), "folder", "newest");
    expect(byFolder.map((group) => [group.title, group.entries.map((item) => item.sequence)])).toEqual([
      ["Scanned folder", [4, 2, 1]],
      ["nested", [3]],
    ]);
  });
});

describe("comparison availability", () => {
  const data = scan();
  const feature = data.checkouts["/w/app-feature"] as Checkout;
  const later = data.checkouts["/w/nested/app-later"] as Checkout;

  it("offers incoming and since-previous only after a direct previous worktree", () => {
    expect(unavailableReason("incoming", feature, data.timeline[1])).toBeNull();
    expect(unavailableReason("sincePrevious", later, data.timeline[2])).toBe(
      "No direct previous worktree",
    );
  });

  it("needs a start for the worktree kind, an upstream for upstream, commits for base", () => {
    const unknown = checkout("/w/x", { start: { unknown: true }, history: null });
    expect(unavailableReason("worktree", unknown, undefined)).toBe(
      "The start of this worktree is unknown",
    );
    expect(unavailableReason("worktree", unknown, undefined, { startOverride: "HEAD~1" })).toBeNull();
    expect(unavailableReason("upstream", feature, undefined)).toBe("This branch has no upstream");
    expect(unavailableReason("base", checkout("/w/y", { head: null }), undefined)).toBe(
      "This checkout has no commits yet",
    );
    expect(unavailableReason("review", unknown, undefined)).toBeNull();
    expect(unavailableReason("working", unknown, undefined)).toBeNull();
  });
});

describe("query keys", () => {
  it("keys a comparison by its request, and a diff by its sides and result", () => {
    expect(keys.comparison("/w/a", { kind: "base", ref: "main" })).toEqual([
      "comparison",
      "/w/a",
      "base",
      "main",
      null,
    ]);
    expect(keys.comparison("/w/a", { kind: "review" }).slice(0, 2)).toEqual(
      keys.checkoutComparisons("/w/a"),
    );
    const sides = comparisonKey({
      kind: "review",
      left: { kind: "commit", oid: "abc" },
      right: { kind: "workingTree" },
    });
    expect(sides).toBe("review|commit:abc|workingTree");
    const file = { path: "x.ts", leftOid: "l1" };
    const one = keys.fileDiff("/w/a", sides, file, "r1");
    expect(keys.fileDiff("/w/a", sides, file, "r1")).toEqual(one);
    expect(keys.fileDiff("/w/a", sides, file, "r2")).not.toEqual(one);
    expect(keys.fileDiff("/w/a", "review|commit:def|workingTree", file, "r1")).not.toEqual(one);
    expect(one.slice(0, 2)).toEqual(keys.checkoutDiffs("/w/a"));
  });
});
