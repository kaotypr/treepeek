import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitParseError } from "../../../../../src/core/git/errors";
import { parseStatusV2 } from "../../../../../src/core/git/parse/status-v2";
import { resetGitRuntime, setTestGit } from "../../../../support/core-git";
import { type Fixture, fixture } from "../../../../support/git-fixture";
import { git } from "./helpers";

const STATUS = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--untracked-files=all",
  "--no-renames",
];

let fx: Fixture;
beforeAll(() => {
  setTestGit();
  fx = fixture();
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

describe("parseStatusV2", () => {
  it("reads a clean checkout", async () => {
    const app = fx.repo("clean").commit({ "a.txt": "a\n" });
    expect(parseStatusV2(await git(app.path, STATUS))).toEqual({
      head: app.head(),
      branch: "main",
      staged: 0,
      unstaged: 0,
      untracked: 0,
      unmerged: 0,
    });
  });

  it("counts staged, unstaged and untracked paths, whatever their names", async () => {
    const app = fx.repo("busy").commit({
      "unstaged.txt": "1\n",
      "staged.txt": "1\n",
      "both.txt": "1\n",
      "with space.txt": "1\n",
      "deleted.txt": "1\n",
    });
    app.write({ "staged.txt": "2\n", "both.txt": "2\n" }).stage(["staged.txt", "both.txt"]);
    app.write({
      "unstaged.txt": "2\n",
      "both.txt": "3\n",
      "with space.txt": "2\n",
      "deleted.txt": null,
      "new/deep/one.txt": "x\n",
      "new/two é.txt": "x\n",
      "line\nbreak.txt": "x\n",
    });
    expect(parseStatusV2(await git(app.path, STATUS))).toEqual({
      head: app.head(),
      branch: "main",
      staged: 2,
      unstaged: 4,
      untracked: 3,
      unmerged: 0,
    });
  });

  it("reads the upstream and ahead/behind", async () => {
    const app = fx.repo("tracking").commit({ "a.txt": "1\n" });
    app.git(["branch", "base"]);
    app.commit({ "a.txt": "2\n" }).commit({ "a.txt": "3\n" });
    app.git(["branch", "--set-upstream-to=base"]);
    expect(parseStatusV2(await git(app.path, STATUS))).toMatchObject({
      branch: "main",
      upstream: "base",
      ahead: 2,
      behind: 0,
    });
  });

  it("reads a detached HEAD and an unborn branch", async () => {
    const app = fx.repo("detached").commit({ "a.txt": "1\n" }).detach();
    const detached = parseStatusV2(await git(app.path, STATUS));
    expect(detached.head).toBe(app.head());
    expect(detached).not.toHaveProperty("branch");

    const empty = fx.repo("unborn").write({ "a.txt": "1\n" });
    expect(parseStatusV2(await git(empty.path, STATUS))).toEqual({
      head: null,
      branch: "main",
      staged: 0,
      unstaged: 0,
      untracked: 1,
      unmerged: 0,
    });
  });

  it("consumes a rename's original path, and counts conflicts as unmerged", async () => {
    const app = fx
      .repo("renames")
      .commit({ "old name.txt": "same\ncontent\nhere\n", "c.txt": "base\n" });
    app.rename("old name.txt", "new name.txt");
    const withRenames = await git(app.path, ["status", "--porcelain=v2", "-z", "--branch"]);
    expect(withRenames.toString("utf8")).toContain("2 R.");
    expect(parseStatusV2(withRenames)).toMatchObject({ staged: 1, unstaged: 0, untracked: 0 });
    app.commit();

    app.git(["switch", "--quiet", "-c", "other", "HEAD~1"]);
    app.commit({ "c.txt": "theirs\n" });
    app.git(["switch", "--quiet", "main"]);
    app.commit({ "c.txt": "ours\n" });
    app.git(["merge", "--no-edit", "other"], { records: true, okExitCodes: [1] });
    expect(parseStatusV2(await git(app.path, STATUS))).toMatchObject({ unmerged: 1 });
  });

  it("rejects output it does not understand", () => {
    expect(() => parseStatusV2("")).toThrow(GitParseError);
    expect(() => parseStatusV2("# branch.oid abc\0z what\0")).toThrow(GitParseError);
    expect(() => parseStatusV2("# branch.oid abc\0# branch.ab nonsense\0")).toThrow(GitParseError);
    expect(() => parseStatusV2("# branch.oid abc\x002 R. N... 1 1 1 a b R100 x\0")).toThrow(
      GitParseError,
    );
    expect(() => parseStatusV2("# branch.oid abc")).toThrow(GitParseError);
  });
});
