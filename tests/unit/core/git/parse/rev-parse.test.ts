import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitParseError } from "../../../../../src/core/git/errors";
import { parseIdentity } from "../../../../../src/core/git/parse/rev-parse";
import { resetGitRuntime, useTestGit } from "../../../../support/core-git";
import { type Fixture, fixture } from "../../../../support/git-fixture";
import { git } from "./helpers";

const IDENTITY = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--git-dir",
  "--git-common-dir",
];

let fx: Fixture;
beforeAll(() => {
  useTestGit();
  fx = fixture();
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

describe("parseIdentity", () => {
  it("reads a main checkout: git dir and common dir are the same", async () => {
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const identity = parseIdentity(await git(app.path, IDENTITY));
    expect(identity).toEqual({
      topLevel: app.path,
      gitDir: `${app.path}/.git`,
      commonDir: `${app.path}/.git`,
    });
  });

  it("reads a linked worktree and one of a bare repository", async () => {
    const lib = fx.repo("lib").commit({ "a.txt": "a\n" });
    const feature = lib.worktree("lib-feature", { from: "main" });
    expect(parseIdentity(await git(feature.path, IDENTITY))).toEqual({
      topLevel: feature.path,
      gitDir: `${lib.path}/.git/worktrees/lib-feature`,
      commonDir: `${lib.path}/.git`,
    });

    const svc = fx.repo("svc").commit({ "a.txt": "a\n" }).bare();
    const main = svc.worktree("svc-main", { from: "main", branch: "work" });
    expect(parseIdentity(await git(main.path, IDENTITY))).toEqual({
      topLevel: main.path,
      gitDir: `${fx.path("svc.git")}/worktrees/svc-main`,
      commonDir: fx.path("svc.git"),
    });
  });

  it("reads paths with spaces and non-ASCII characters", async () => {
    const odd = fx.repo("with space é 日本").commit({ "a.txt": "a\n" });
    expect(parseIdentity(await git(odd.path, IDENTITY)).topLevel).toBe(odd.path);
  });

  it("uses the expected top level to split paths that contain newlines", async () => {
    const newline = fx.repo("line\nbreak").commit({ "a.txt": "a\n" });
    const output = await git(newline.path, IDENTITY);
    expect(() => parseIdentity(output)).toThrow(GitParseError);
    expect(parseIdentity(output, newline.path)).toEqual({
      topLevel: newline.path,
      gitDir: `${newline.path}/.git`,
      commonDir: `${newline.path}/.git`,
    });

    const linked = newline.worktree("line\nbreak-wt", { from: "main", branch: "wt" });
    expect(parseIdentity(await git(linked.path, IDENTITY), linked.path)).toMatchObject({
      topLevel: linked.path,
      commonDir: `${newline.path}/.git`,
    });
  });

  it("rejects output that is not three paths", () => {
    expect(() => parseIdentity("")).toThrow(GitParseError);
    expect(() => parseIdentity("/a\n/b\n")).toThrow(GitParseError);
    expect(() => parseIdentity("/a\n/b\n/c")).toThrow(GitParseError);
    expect(() => parseIdentity("/a\n\n/c\n")).toThrow(GitParseError);
    expect(() => parseIdentity("/a\n/x\n/y\n/z\n", "/elsewhere")).toThrow(GitParseError);
  });
});
