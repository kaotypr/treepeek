import { describe, expect, it } from "vitest";
import { GitError } from "../../../../src/core/git/errors";
import { assertAllowedSubcommand, FORBIDDEN } from "../../../../src/core/git/guard";

function refusal(args: readonly string[]): GitError | null {
  try {
    assertAllowedSubcommand(args);
    return null;
  } catch (error) {
    if (error instanceof GitError) return error;
    throw error;
  }
}

describe("assertAllowedSubcommand", () => {
  it("lists the design's never-used commands", () => {
    expect(FORBIDDEN).toEqual([
      "fetch",
      "pull",
      "push",
      "checkout",
      "switch",
      "reset",
      "stash",
      "commit",
      "gc",
      "worktree add",
      "worktree remove",
      "worktree prune",
      "hash-object -w",
      "update-index",
      "update-ref",
    ]);
  });

  it.each(FORBIDDEN)("refuses `%s`", (entry) => {
    const error = refusal([...entry.split(" "), "--", "x"]);
    expect(error?.code).toBe("internal");
    expect(error?.message).toMatch(/writes to the repository or uses the network/);
  });

  it("allows every command in the catalogue", () => {
    const catalogue = [
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      ["worktree", "list", "--porcelain", "-z"],
      ["remote", "get-url", "origin"],
      ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--no-renames"],
      ["reflog", "show", "--date=iso-strict", "--format=%H%x09%gd", "-z", "HEAD"],
      ["merge-base", "--is-ancestor", "a", "b"],
      ["rev-list", "--count", "a..b"],
      ["diff", "--name-only", "-z", "a", "b"],
      ["rev-parse", "--verify", "--quiet", "--end-of-options", "main^{commit}"],
      ["diff", "--raw", "-z", "--find-renames", "--abbrev=40", "a"],
      ["diff", "--raw", "-z", "--cached"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
      ["diff", "--find-renames", "-U3", "a", "b", "--", "old", "new"],
      ["diff", "--no-index", "-U3", "--", "/dev/null", "file"],
      ["cat-file", "--batch"],
      ["hash-object", "--stdin-paths"],
    ];
    for (const args of catalogue) expect(refusal(args), args.join(" ")).toBeNull();
  });

  it("refuses anything not in the catalogue, and the writing verbs of allowed commands", () => {
    for (const args of [
      ["merge", "x"],
      ["rebase", "main"],
      ["config", "core.fsmonitor", "x"],
      ["branch", "-D", "x"],
      ["tag", "v1"],
      ["clean", "-fdx"],
      ["difftool"],
      ["ls-remote", "origin"],
      ["worktree", "move", "a", "b"],
      ["worktree", "lock", "a"],
      ["remote", "add", "x", "y"],
      ["remote", "set-url", "origin", "y"],
      ["reflog", "expire", "--all"],
      ["reflog", "delete", "HEAD@{0}"],
      ["hash-object", "-tw", "--stdin"],
    ]) {
      expect(refusal(args), args.join(" ")).toBeInstanceOf(GitError);
    }
  });

  it("refuses global options, which would come after the hardening config", () => {
    for (const args of [
      ["-c", "core.fsmonitor=/tmp/x", "status"],
      ["--git-dir=/tmp/other", "status"],
      ["-C", "/tmp", "status"],
      ["--exec-path=/tmp", "status"],
      [],
      [""],
    ]) {
      expect(refusal(args), args.join(" ")).toBeInstanceOf(GitError);
    }
  });

  it("refuses options that write files, run programs or undo pinned output", () => {
    for (const option of [
      "--output=/tmp/x",
      "--output",
      "--ext-diff",
      "--textconv",
      "--show-signature",
      "--color",
      "--color=always",
      "--no-prefix",
      "--src-prefix=x/",
      "--dst-prefix=y/",
    ]) {
      expect(refusal(["diff", option, "HEAD"]), option).toBeInstanceOf(GitError);
    }
    expect(refusal(["cat-file", "--filters", "HEAD:x"])).toBeInstanceOf(GitError);
  });

  it("reads nothing after -- or --end-of-options as an option", () => {
    expect(refusal(["diff", "HEAD", "--", "--output=/tmp/x", "-w"])).toBeNull();
    expect(refusal(["rev-parse", "--verify", "--end-of-options", "--output"])).toBeNull();
    expect(refusal(["hash-object", "--stdin-paths", "--", "-w"])).toBeNull();
  });
});
