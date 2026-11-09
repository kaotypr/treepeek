import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRawDiff } from "../../../../src/core/git/parse/raw-diff";
import { parseStatusV2 } from "../../../../src/core/git/parse/status-v2";
import { runGit } from "../../../../src/core/git/run";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { gitIn } from "../../../support/git";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

/**
 * A submodule is a repository of its own, with its own config. To tell whether its working
 * tree is dirty, Git runs `git status` inside it, which reads that config: a filter driver
 * defined there would run, and the outer repository's overrides do not name it. Treepeek
 * therefore never looks inside a submodule's working tree (`--ignore-submodules=dirty`).
 */

let fx: Fixture;
let outer: FixtureRepo;
let marker: string;
let subPath: string;
let subGitDir: string;

const signal = () => new AbortController().signal;
const STATUS = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];

/** Runs git inside the submodule with its traps disarmed. */
function subGit(args: readonly string[]): string {
  return gitIn(subPath, ["-c", "filter.subevil.clean=", "-c", "commit.gpgsign=false", ...args]);
}

beforeAll(() => {
  setTestGit();
  fx = fixture();
  marker = fx.outsidePath("marker.log");
  const origin = fx.repo("sub-origin").commit({ "s.txt": "s1\n" });
  outer = fx.repo("outer").commit({ "a.txt": "a\n" });
  outer.git([
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    origin.path,
    "sub",
  ]);
  outer.commit({}, "add the submodule");
  subPath = join(outer.path, "sub");
  subGitDir = gitIn(subPath, ["rev-parse", "--path-format=absolute", "--git-dir"]).trim();
  // Arm the submodule's own config, then change a file inside it (same size, new content).
  gitIn(subPath, ["config", "filter.subevil.clean", fx.trapScript(marker)]);
  mkdirSync(join(subGitDir, "info"), { recursive: true });
  writeFileSync(join(subGitDir, "info", "attributes"), "* filter=subevil\n");
  writeFileSync(join(subPath, "s.txt"), "s2\n");
  // `diff.submodule=diff` would have a patch run `git diff` inside the submodule.
  outer.git(["config", "diff.submodule", "diff"]);
  outer.git(["config", "submodule.sub.ignore", "none"]);
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

describe("submodules inside a checkout", () => {
  it("never run the submodule's own filter drivers", async () => {
    const options = { signal: signal() };
    const status = parseStatusV2((await runGit(outer.path, STATUS, options)).stdout);
    await runGit(outer.path, ["diff", "--raw", "-z", "--abbrev=40", "HEAD"], options);
    await runGit(outer.path, ["diff", "--raw", "-z", "--abbrev=40"], options);
    await runGit(outer.path, ["diff", "-U3", "HEAD"], options);
    // Only the submodule's own files changed, so the outer checkout is clean.
    expect(status.unstaged).toBe(0);
    expect(existsSync(marker)).toBe(false);

    gitIn(outer.path, ["status", "--porcelain"]);
    expect(existsSync(marker), "plain git status should fire the trap").toBe(true);
    rmSync(marker, { force: true });
  });

  it("still shows the submodule's commit moving, as a gitlink change", async () => {
    const recorded = outer.rev("HEAD:sub");
    subGit(["add", "--all"]);
    subGit(["commit", "--quiet", "--message", "moved"]);
    const moved = subGit(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(subPath, "s.txt"), "s3\n");
    const options = { signal: signal() };

    const status = parseStatusV2((await runGit(outer.path, STATUS, options)).stdout);
    expect(status.unstaged).toBe(1);
    const raw = parseRawDiff(
      (await runGit(outer.path, ["diff", "--raw", "-z", "--abbrev=40", "HEAD"], options)).stdout,
    );
    expect(raw).toEqual([
      expect.objectContaining({ status: "M", oldMode: "160000", oldOid: recorded, path: "sub" }),
    ]);
    const patch = (await runGit(outer.path, ["diff", "-U3", "HEAD"], options)).stdout.toString();
    expect(patch).toContain(`+Subproject commit ${moved}`);
    expect(patch).not.toContain("s.txt");
    expect(existsSync(marker)).toBe(false);
  });
});
