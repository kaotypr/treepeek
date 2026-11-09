import { describe, expect, it } from "vitest";
import type { WorktreeEntry } from "../../../../src/core/git/parse/worktree-list";
import { buildRepositories, displayName } from "../../../../src/core/scan/repositories";

const entry = (path: string, bare = false): WorktreeEntry => ({
  path,
  head: bare ? null : "a".repeat(40),
  bare,
  detached: false,
  locked: false,
  prunable: false,
});

describe("displayName", () => {
  it("is the main checkout's folder name", () => {
    expect(displayName("/s/app/.git", [entry("/s/app"), entry("/s/app-wt")])).toBe("app");
    // Even when the main checkout lies outside the scan root, or the common dir moved.
    expect(displayName("/elsewhere/git-dir", [entry("/away/project")])).toBe("project");
  });

  it("drops .git from a bare repository's name", () => {
    expect(displayName("/s/svc.git", [entry("/s/svc.git", true), entry("/s/svc-main")])).toBe(
      "svc",
    );
    expect(displayName("/s/plain", [entry("/s/plain", true)])).toBe("plain");
    expect(displayName("/s/.git", [entry("/s/.git", true)])).toBe(".git");
  });

  it("falls back to the common dir without a worktree list", () => {
    expect(displayName("/s/app/.git", [])).toBe("app");
    expect(displayName("/s/svc.git", [])).toBe("svc");
  });
});

describe("buildRepositories", () => {
  it("groups checkouts in the given order", () => {
    const lists = new Map([
      ["/s/a/.git", [entry("/s/a")]],
      ["/s/b.git", [entry("/s/b.git", true)]],
    ]);
    expect(
      buildRepositories(
        [
          { path: "/s/a-wt", commonDir: "/s/a/.git" },
          { path: "/s/b-main", commonDir: "/s/b.git" },
          { path: "/s/a", commonDir: "/s/a/.git" },
        ],
        lists,
      ),
    ).toEqual([
      { commonDir: "/s/a/.git", displayName: "a", checkouts: ["/s/a-wt", "/s/a"] },
      { commonDir: "/s/b.git", displayName: "b", checkouts: ["/s/b-main"] },
    ]);
  });
});
