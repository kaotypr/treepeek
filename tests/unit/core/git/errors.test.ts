import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  asIpcError,
  classifyGitFailure,
  GitError,
  toIpcError,
} from "../../../../src/core/git/errors";
import { runGit } from "../../../../src/core/git/run";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import {
  commitAll,
  makeTempRepo,
  removeTempRepos,
  type TempRepo,
  writeRepoFile,
} from "../../../support/git";

/** Stderr captured from git 2.55.0 (`LC_ALL=C`) on macOS; paths shortened. */
const SAMPLES = {
  dubiousOwnership: [
    "fatal: detected dubious ownership in repository at '/Users/someone/repo'",
    "To add an exception for this directory, call:",
    "",
    "\tgit config --global --add safe.directory /Users/someone/repo",
  ].join("\n"),
  dubiousOwnershipOld:
    "fatal: unsafe repository ('/Users/someone/repo' is owned by someone else)\nTo add an exception for this directory, call:",
  notARepository: "fatal: not a git repository (or any of the parent directories): .git",
  staleGitFile: "fatal: not a git repository: /Users/someone/repo/.git/worktrees/gone",
  missingFolder: "fatal: cannot change to '/nonexistent': No such file or directory",
  unknownRevision: [
    "fatal: ambiguous argument 'nope..HEAD': unknown revision or path not in the working tree.",
    "Use '--' to separate paths from revisions, like this:",
    "'git <command> [<revision>...] -- [<file>...]'",
  ].join("\n"),
  badObject: "fatal: bad object 0000000000000000000000000000000000000001",
  notValidObjectName: "fatal: Not a valid object name nope",
  noSuchRemote: "error: No such remote 'origin'",
};

describe("classifyGitFailure", () => {
  it("maps captured stderr to IPC codes", () => {
    expect(classifyGitFailure(128, SAMPLES.dubiousOwnership)).toBe("dubiousOwnership");
    expect(classifyGitFailure(128, SAMPLES.dubiousOwnershipOld)).toBe("dubiousOwnership");
    expect(classifyGitFailure(128, SAMPLES.notARepository)).toBe("notARepository");
    expect(classifyGitFailure(128, SAMPLES.staleGitFile)).toBe("notARepository");
    expect(classifyGitFailure(128, SAMPLES.missingFolder)).toBe("notARepository");
    expect(classifyGitFailure(128, SAMPLES.unknownRevision)).toBe("refNotFound");
    expect(classifyGitFailure(128, SAMPLES.badObject)).toBe("refNotFound");
    expect(classifyGitFailure(128, SAMPLES.notValidObjectName)).toBe("refNotFound");
    expect(classifyGitFailure(2, SAMPLES.noSuchRemote)).toBe("internal");
  });

  it("maps how the process was stopped", () => {
    expect(classifyGitFailure("timeout", "")).toBe("timeout");
    expect(classifyGitFailure("outputTooLarge", "")).toBe("outputTooLarge");
    expect(classifyGitFailure("cancelled", "")).toBe("cancelled");
    expect(classifyGitFailure("spawn", "ENOENT")).toBe("gitNotFound");
    expect(classifyGitFailure("signal", "")).toBe("internal");
  });

  it("builds IPC errors with the exit code and stderr as detail", () => {
    expect(toIpcError(128, SAMPLES.dubiousOwnership)).toEqual({
      code: "dubiousOwnership",
      message: expect.stringMatching(/safe\.directory/),
      detail: { exitCode: 128, stderr: SAMPLES.dubiousOwnership },
    });
    expect(toIpcError(1, "something odd")).toMatchObject({
      code: "internal",
      message: "Git failed with exit code 1.",
      detail: { exitCode: 1 },
    });
    expect(toIpcError("timeout", "").detail).toEqual({ exitCode: null, stderr: "" });
  });

  it("turns anything thrown into an IPC error", () => {
    expect(asIpcError(new GitError("refNotFound", "no"))).toMatchObject({ code: "refNotFound" });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(asIpcError(abort).code).toBe("cancelled");
    expect(asIpcError(new TypeError("bug"))).toEqual({
      code: "internal",
      message: "An internal error occurred while running Git.",
    });
  });
});

describe("error mapping against a real git", () => {
  let repo: TempRepo;
  beforeAll(() => {
    repo = makeTempRepo();
    writeRepoFile(repo, "a.txt", "a\n");
    commitAll(repo, "one");
  });
  afterEach(() => resetGitRuntime());
  afterAll(() => removeTempRepos());

  async function failure(args: string[], cwd = repo.path): Promise<GitError> {
    try {
      await runGit(cwd, args, { signal: new AbortController().signal });
    } catch (error) {
      if (error instanceof GitError) return error;
      throw error;
    }
    throw new Error("expected git to fail");
  }

  it("reports git's real safe.directory refusal as dubiousOwnership", async () => {
    // Git's own test hook makes it treat the repository as owned by someone else.
    setTestGit({ GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" });
    const error = await failure(["rev-parse", "--show-toplevel"]);
    expect(error.code).toBe("dubiousOwnership");
    expect(error.detail.stderr).toMatch(/dubious ownership/);
  });

  it("reports a missing folder and a folder outside any repository", async () => {
    setTestGit();
    expect((await failure(["status"], "/nonexistent-treepeek")).code).toBe("notARepository");
    expect((await failure(["rev-parse", "--show-toplevel"], "/")).code).toBe("notARepository");
  });

  it("reports unknown revisions as refNotFound", async () => {
    setTestGit();
    expect((await failure(["rev-list", "--count", "nope..HEAD"])).code).toBe("refNotFound");
    expect((await failure(["diff", "--raw", "nope", "HEAD"])).code).toBe("refNotFound");
    expect((await failure(["merge-base", "--is-ancestor", "nope", "HEAD"])).code).toBe(
      "refNotFound",
    );
  });
});
