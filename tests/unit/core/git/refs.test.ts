import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { observeSpawns } from "../../../../src/core/git/process";
import { checkUserRef, MAX_USER_REF_LENGTH, resolveUserRef } from "../../../../src/core/git/refs";
import { resetGitRuntime, useTestGit } from "../../../support/core-git";
import {
  commitAll,
  gitIn,
  makeTempRepo,
  removeTempRepos,
  type TempRepo,
  writeRepoFile,
} from "../../../support/git";

let repo: TempRepo;
let first: string;
let second: string;

beforeAll(() => {
  repo = makeTempRepo();
  writeRepoFile(repo, "a.txt", "a\n");
  first = commitAll(repo, "one");
  writeRepoFile(repo, "a.txt", "b\n");
  second = commitAll(repo, "two");
  gitIn(repo, ["tag", "v1", first]);
  gitIn(repo, ["tag", "-a", "-m", "annotated", "v2", second]);
});
beforeAll(() => useTestGit());
afterEach(() => useTestGit());
afterAll(() => {
  resetGitRuntime();
  removeTempRepos();
});

const signal = () => new AbortController().signal;

describe("checkUserRef", () => {
  it("refuses refs that could be read as options or are malformed, without running git", async () => {
    let spawned = 0;
    const stop = observeSpawns(() => {
      spawned += 1;
    });
    try {
      for (const ref of [
        "-x",
        "--output=/tmp/x",
        "",
        "a".repeat(MAX_USER_REF_LENGTH + 1),
        "main\n-x",
        "a\0b",
      ]) {
        expect(() => checkUserRef(ref), JSON.stringify(ref)).toThrow();
        await expect(
          resolveUserRef(repo.path, ref, signal()),
          JSON.stringify(ref),
        ).rejects.toMatchObject({
          code: "invalidRequest",
        });
      }
    } finally {
      stop();
    }
    expect(spawned).toBe(0);
    expect(MAX_USER_REF_LENGTH).toBe(200);
    expect(() => checkUserRef("a".repeat(MAX_USER_REF_LENGTH))).not.toThrow();
  });
});

describe("resolveUserRef", () => {
  it("resolves branches, tags, short ids and expressions to full commit ids", async () => {
    expect(await resolveUserRef(repo.path, "main", signal())).toBe(second);
    expect(await resolveUserRef(repo.path, "HEAD~1", signal())).toBe(first);
    expect(await resolveUserRef(repo.path, "v1", signal())).toBe(first);
    // An annotated tag peels to its commit.
    expect(await resolveUserRef(repo.path, "v2", signal())).toBe(second);
    expect(await resolveUserRef(repo.path, first.slice(0, 10), signal())).toBe(first);
  });

  it("fails with refNotFound for a missing ref or one that is not a commit", async () => {
    for (const ref of ["nope", "HEAD^{tree}", "HEAD:a.txt", "main~5"]) {
      await expect(resolveUserRef(repo.path, ref, signal()), ref).rejects.toMatchObject({
        code: "refNotFound",
      });
    }
  });
});
