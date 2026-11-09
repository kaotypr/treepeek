import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitParseError } from "../../../../../src/core/git/errors";
import { parseWorktreeList } from "../../../../../src/core/git/parse/worktree-list";
import { resetGitRuntime, useTestGit } from "../../../../support/core-git";
import { type Fixture, fixture } from "../../../../support/git-fixture";
import { git } from "./helpers";

const LIST = ["worktree", "list", "--porcelain", "-z"];

let fx: Fixture;
beforeAll(() => {
  useTestGit();
  fx = fixture();
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

describe("parseWorktreeList", () => {
  it("reads branches, detached, locked and prunable worktrees", async () => {
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const feature = app.worktree("app-feature", { from: "main" });
    feature.commit({ "b.txt": "b\n" });
    const detached = app.worktree("app-detached", { from: "main", detach: true });
    const locked = app.worktree("app locked é", { from: "main", branch: "locked" });
    app.repoGit(["worktree", "lock", "--reason", "on a USB drive", locked.path]);
    const gone = app.worktree("app-gone", { from: "main" });
    rmSync(gone.path, { recursive: true, force: true });

    const entries = parseWorktreeList(await git(app.path, LIST));
    // The main checkout comes first; Git lists linked worktrees by their admin folder name.
    const byPath = (a: { path: string }, b: { path: string }) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    const [main, ...linked] = entries;
    const [expectedMain, ...expectedLinked] = [
      {
        path: app.path,
        head: app.head(),
        branch: "refs/heads/main",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: feature.path,
        head: feature.head(),
        branch: "refs/heads/app-feature",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: detached.path,
        head: app.head(),
        bare: false,
        detached: true,
        locked: false,
        prunable: false,
      },
      {
        path: locked.path,
        head: app.head(),
        branch: "refs/heads/locked",
        bare: false,
        detached: false,
        locked: true,
        prunable: false,
      },
      {
        path: gone.path,
        head: app.head(),
        branch: "refs/heads/app-gone",
        bare: false,
        detached: false,
        locked: false,
        prunable: true,
      },
    ];
    expect(main).toEqual(expectedMain);
    expect(linked.sort(byPath)).toEqual(expectedLinked.sort(byPath));
    // Every linked worktree reports the same list.
    expect(parseWorktreeList(await git(feature.path, LIST))).toEqual(entries);
  });

  it("reads a bare repository, which has no HEAD of its own in the list", async () => {
    const svc = fx.repo("svc").commit({ "a.txt": "a\n" }).bare();
    const main = svc.worktree("svc-main", { from: "main", branch: "work" });
    const entries = parseWorktreeList(await git(main.path, LIST));
    expect(entries).toEqual([
      {
        path: svc.commonDir,
        head: null,
        bare: true,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: main.path,
        head: main.head(),
        branch: "refs/heads/work",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
    ]);
  });

  it("reads an unborn branch, and a path containing a newline", async () => {
    const empty = fx.repo("empty");
    expect(parseWorktreeList(await git(empty.path, LIST))).toEqual([
      {
        path: empty.path,
        head: null,
        branch: "refs/heads/main",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
    ]);

    const odd = fx.repo("odd").commit({ "a.txt": "a\n" });
    const linked = odd.worktree("odd\nline", { from: "main", branch: "line" });
    const paths = parseWorktreeList(await git(odd.path, LIST)).map((entry) => entry.path);
    expect(paths).toEqual([odd.path, linked.path]);
  });

  it("rejects output cut short or out of order", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(() => parseWorktreeList("worktree /a\0HEAD 1234\0")).toThrow(GitParseError);
    expect(() => parseWorktreeList("worktree /a\0HEAD 1234")).toThrow(GitParseError);
    expect(() => parseWorktreeList("HEAD 1234\0\0")).toThrow(GitParseError);
    expect(() => parseWorktreeList("\0")).toThrow(GitParseError);
    // Attributes a newer Git adds are skipped.
    expect(parseWorktreeList("worktree /a\0HEAD ab12\0future thing\0\0")).toMatchObject([
      { path: "/a", head: "ab12" },
    ]);
  });
});
