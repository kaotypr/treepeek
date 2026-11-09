import { afterEach, describe, expect, it } from "vitest";
import {
  currentGitState,
  rediscoverGit,
  requireGit,
  resetGitRuntime,
} from "../../../../src/core/git/runtime";
import type { GitState } from "../../../../src/shared/domain/git";

/** A discovery that finishes when the test says so. */
function controlled() {
  let finish!: (state: GitState) => void;
  const promise = new Promise<GitState>((resolve) => {
    finish = resolve;
  });
  return { discover: () => promise, finish };
}

afterEach(() => resetGitRuntime());

describe("git runtime", () => {
  it("makes calls wait for a discovery in progress, then use its result", async () => {
    const run = controlled();
    const discovery = rediscoverGit(
      { override: null, loginPath: "/opt/homebrew/bin" },
      run.discover,
    );
    const waiting = requireGit();
    run.finish({ found: true, path: "/opt/homebrew/bin/git", version: "2.55.0" });
    expect(await discovery).toEqual({
      found: true,
      path: "/opt/homebrew/bin/git",
      version: "2.55.0",
    });
    const git = await waiting;
    expect(git).toMatchObject({ path: "/opt/homebrew/bin/git", version: "2.55.0" });
    expect(git.env.PATH).toBe("/opt/homebrew/bin");
    expect(git.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(currentGitState()).toMatchObject({ found: true });
  });

  it("keeps only the newest discovery when the setting changes mid-way", async () => {
    const older = controlled();
    const newer = controlled();
    const first = rediscoverGit({ override: "/old/git", loginPath: null }, older.discover);
    const second = rediscoverGit({ override: "/new/git", loginPath: null }, newer.discover);
    const waiting = requireGit();
    older.finish({ found: true, path: "/old/git", version: "2.40.0" });
    expect(await first).toBeUndefined();
    newer.finish({ found: true, path: "/new/git", version: "2.50.0" });
    expect(await second).toMatchObject({ path: "/new/git" });
    expect((await waiting).path).toBe("/new/git");
  });

  it("reports a discovery that throws as notFound", async () => {
    const state = await rediscoverGit({ override: null, loginPath: null }, () =>
      Promise.reject(new Error("boom")),
    );
    expect(state).toEqual({ found: false, problem: "notFound", detail: "boom" });
    await expect(requireGit()).rejects.toMatchObject({ code: "gitNotFound" });
  });

  it("maps each problem to its IPC code", async () => {
    for (const [problem, code] of [
      ["notFound", "gitNotFound"],
      ["xcodeMissing", "gitNotFound"],
      ["tooOld", "gitTooOld"],
    ] as const) {
      await rediscoverGit({ override: null, loginPath: null }, async () => ({
        found: false,
        problem,
      }));
      await expect(requireGit(), problem).rejects.toMatchObject({ code });
    }
  });
});
