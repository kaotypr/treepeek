import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitParseError } from "../../../../../src/core/git/errors";
import { parseNulList } from "../../../../../src/core/git/parse/ls-files";
import { resetGitRuntime, useTestGit } from "../../../../support/core-git";
import { type Fixture, fixture } from "../../../../support/git-fixture";
import { git } from "./helpers";

let fx: Fixture;
beforeAll(() => {
  useTestGit();
  fx = fixture();
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

describe("parseNulList", () => {
  it("lists untracked files, one per file, with any name, leaving ignored ones out", async () => {
    const app = fx.repo("app").commit({ ".gitignore": "*.log\n", "tracked.txt": "t\n" });
    app.write({
      "new/deep/one.txt": "1\n",
      "with space.txt": "2\n",
      "é 日本.txt": "3\n",
      "line\nbreak.txt": "4\n",
      "-starts-with-dash": "5\n",
      "debug.log": "ignored\n",
    });
    const files = parseNulList(
      await git(app.path, ["ls-files", "--others", "--exclude-standard", "-z"]),
    );
    expect(files.sort()).toEqual(
      [
        "-starts-with-dash",
        "line\nbreak.txt",
        "new/deep/one.txt",
        "with space.txt",
        "é 日本.txt",
      ].sort(),
    );
  });

  it("reads diff --name-only -z between two commits", async () => {
    const lib = fx.repo("lib").commit({ "a.txt": "1\n", "b c.txt": "1\n" });
    const left = lib.head();
    lib.commit({ "a.txt": "2\n", "b c.txt": null, "new.txt": "n\n" });
    const names = parseNulList(await git(lib.path, ["diff", "--name-only", "-z", left, "HEAD"]));
    expect(names).toEqual(["a.txt", "b c.txt", "new.txt"]);
    expect(
      parseNulList(await git(lib.path, ["diff", "--name-only", "-z", "HEAD", "HEAD"])),
    ).toEqual([]);
  });

  it("rejects a list cut short or with an empty path", () => {
    expect(() => parseNulList("a\0b")).toThrow(GitParseError);
    expect(() => parseNulList("a\0\0")).toThrow(GitParseError);
    expect(parseNulList(new TextEncoder().encode("x\0y\0"))).toEqual(["x", "y"]);
  });
});
