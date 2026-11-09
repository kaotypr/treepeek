import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoreState } from "../../../../src/core/cache/shared-state";
import { rawDiff } from "../../../../src/core/scan/queries";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { gitIn } from "../../../support/git";

let folder: string;
let first: string;
let second: string;
const state = new CoreState();

beforeAll(() => {
  setTestGit();
  folder = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-sha256-")));
  gitIn(folder, ["init", "--quiet", "--object-format=sha256", "--initial-branch=main"]);
  writeFileSync(join(folder, "a.txt"), "1\n");
  gitIn(folder, ["add", "a.txt"]);
  gitIn(folder, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "one"]);
  first = gitIn(folder, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(folder, "a.txt"), "2\n");
  gitIn(folder, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-am", "two"]);
  second = gitIn(folder, ["rev-parse", "HEAD"]).trim();
});
afterAll(() => {
  state.close();
  rmSync(folder, { recursive: true, force: true });
  resetGitRuntime();
});

describe("comparison lists in a SHA-256 repository", () => {
  it("carry whole 64-character blob ids", async () => {
    const repo = state.acquireRepository(1, join(folder, ".git"));
    const [entry] = await rawDiff(repo, first, second, { signal: new AbortController().signal });
    expect(entry?.oldOid).toBe(gitIn(folder, ["rev-parse", `${first}:a.txt`]).trim());
    expect(entry?.newOid).toBe(gitIn(folder, ["rev-parse", `${second}:a.txt`]).trim());
    expect(entry?.newOid).toHaveLength(64);
  });
});
