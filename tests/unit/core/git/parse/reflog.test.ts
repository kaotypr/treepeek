import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitParseError } from "../../../../../src/core/git/errors";
import { oldestReflogEntry } from "../../../../../src/core/git/parse/reflog";
import { resetGitRuntime, useTestGit } from "../../../../support/core-git";
import { gitIn } from "../../../../support/git";
import { type Fixture, fixture } from "../../../../support/git-fixture";
import { git } from "./helpers";

const REFLOG = ["reflog", "show", "--date=iso-strict", "--format=%H%x09%gd", "-z", "HEAD"];

let fx: Fixture;
beforeAll(() => {
  useTestGit();
  fx = fixture({ start: "2025-03-01T09:00:00Z", stepSeconds: 60 });
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

describe("oldestReflogEntry", () => {
  it("returns the first commit of a main checkout, with its time in UTC", async () => {
    const app = fx.repo("app");
    const firstAt = fx.now();
    app.commit({ "a.txt": "1\n" });
    const first = app.head();
    app.commit({ "a.txt": "2\n" }).commit({ "a.txt": "3\n" });
    expect(oldestReflogEntry(await git(app.path, REFLOG))).toEqual({
      commit: first,
      observedAt: firstAt,
    });
    expect(firstAt).toBe("2025-03-01T09:00:00Z");
  });

  it("returns when a linked worktree was added, and the commit it started on", async () => {
    const lib = fx.repo("lib").commit({ "a.txt": "1\n" });
    const base = lib.head();
    fx.advance(3600);
    const addedAt = fx.now();
    const feature = lib.worktree("lib-feature", { from: "main" });
    feature.commit({ "b.txt": "1\n" }).commit({ "b.txt": "2\n" });
    expect(oldestReflogEntry(await git(feature.path, REFLOG))).toEqual({
      commit: base,
      observedAt: addedAt,
    });
  });

  it("converts an entry recorded in another time zone to UTC", async () => {
    const zoned = fx.repo("zoned");
    gitIn(zoned.path, ["commit", "--quiet", "--allow-empty", "-m", "one"], {
      env: {
        GIT_COMMITTER_DATE: "2025-06-01T12:00:00+07:00",
        GIT_AUTHOR_DATE: "2025-06-01T12:00:00+07:00",
      },
    });
    const raw = (await git(zoned.path, REFLOG)).toString("utf8");
    expect(raw).toContain("HEAD@{2025-06-01T12:00:00+07:00}");
    expect(oldestReflogEntry(raw)?.observedAt).toBe("2025-06-01T05:00:00Z");
  });

  it("returns null once the reflog has expired", async () => {
    const old = fx.repo("old").commit({ "a.txt": "1\n" });
    const wt = old.worktree("old-wt", { from: "main" });
    old.expireReflog();
    expect(oldestReflogEntry(await git(old.path, REFLOG))).toBeNull();
    expect(oldestReflogEntry(await git(wt.path, REFLOG))).toBeNull();
  });

  it("rejects entries it cannot read", () => {
    expect(oldestReflogEntry("")).toBeNull();
    expect(() => oldestReflogEntry("nonsense\0")).toThrow(GitParseError);
    expect(() => oldestReflogEntry(`${"a".repeat(40)}\tHEAD@{0}\0`)).toThrow(GitParseError);
    expect(() => oldestReflogEntry(`${"a".repeat(40)}\tHEAD@{not a date}\0`)).toThrow(
      GitParseError,
    );
    expect(() => oldestReflogEntry("xyz\tHEAD@{2025-01-01T00:00:00Z}\0")).toThrow(GitParseError);
    // Some Git versions only separate entries; the last one then has no NUL.
    expect(oldestReflogEntry(`${"b".repeat(40)}\tHEAD@{2025-01-01T00:00:00+00:00}`)).toEqual({
      commit: "b".repeat(40),
      observedAt: "2025-01-01T00:00:00Z",
    });
  });
});
