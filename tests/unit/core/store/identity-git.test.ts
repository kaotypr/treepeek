import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oldestReflogEntry } from "../../../../src/core/git/parse/reflog";
import { runGit } from "../../../../src/core/git/run";
import { resolveIdentity } from "../../../../src/core/store/identity";
import { openReviewStore } from "../../../../src/core/store/open-store";
import type { ReviewStore } from "../../../../src/core/store/review-store";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { type Fixture, fixture } from "../../../support/git-fixture";

/** The reflog start as the scan reads it (the ancestor check comes with the scan). */
async function reflogStart(checkoutPath: string) {
  const output = await runGit(
    checkoutPath,
    ["reflog", "show", "--date=iso-strict", "--format=%H%x09%gd", "-z", "HEAD"],
    { signal: new AbortController().signal },
  );
  return oldestReflogEntry(output.stdout);
}

describe("resolveIdentity against real reflogs", () => {
  let fx: Fixture;
  let userData: string;
  let store: ReviewStore;

  beforeEach(() => {
    setTestGit();
    fx = fixture();
    userData = mkdtempSync(join(tmpdir(), "treepeek-identity-"));
    store = openReviewStore(userData);
  });
  afterEach(() => {
    store.close();
    rmSync(userData, { recursive: true, force: true });
    fx.cleanup();
    resetGitRuntime();
  });

  it("keeps a worktree's identity and start after its reflog expires", async () => {
    const app = fx.repo("app").commit({ "a.txt": "1\n" });
    const feature = app.worktree("app-feature", { from: "main" });
    feature.commit({ "b.txt": "2\n" });
    const input = { commonDir: app.commonDir, checkoutPath: feature.path };

    const start = await reflogStart(feature.path);
    expect(start).not.toBeNull();
    const before = resolveIdentity(store, { ...input, reflogStart: start });
    expect(before.start).toMatchObject({ commit: start?.commit, source: "reflog" });

    app.expireReflog();
    expect(await reflogStart(feature.path)).toBeNull();
    const after = resolveIdentity(store, { ...input, reflogStart: null });
    expect(after.worktreeId).toBe(before.worktreeId);
    expect(after.start).toEqual({
      commit: start?.commit,
      observedAt: start?.observedAt,
      source: "override",
    });
  });

  it("gives a worktree deleted and recreated at the same path a new identity", async () => {
    const app = fx.repo("app").commit({ "a.txt": "1\n" });
    const firstBase = app.head();
    const feature = app.worktree("app-feature", { from: "main" });
    const first = resolveIdentity(store, {
      commonDir: app.commonDir,
      checkoutPath: feature.path,
      reflogStart: await reflogStart(feature.path),
    });

    app.commit({ "a.txt": "2\n" });
    app.repoGit(["worktree", "remove", "--force", feature.path]);
    const again = app.worktree("app-feature", { from: "main", branch: "app-feature-2" });
    expect(again.path).toBe(feature.path);
    const recreatedStart = await reflogStart(again.path);
    expect(recreatedStart?.commit).not.toBe(firstBase);
    const recreated = resolveIdentity(store, {
      commonDir: app.commonDir,
      checkoutPath: again.path,
      reflogStart: recreatedStart,
    });
    expect(recreated.worktreeId).not.toBe(first.worktreeId);
  });
});
