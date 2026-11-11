import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComparisonResult,
  LISTABLE_COMPARISON_KINDS,
} from "../../../../src/shared/domain/compare";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { harness } from "../../../support/core-session";
import { gitIn } from "../../../support/git";
import {
  DEFAULT_MALICIOUS_VECTORS,
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

let fx: Fixture;
let marker: string;
let repo: FixtureRepo;
let topic: FixtureCheckout;

beforeAll(() => {
  setTestGit();
  fx = fixture();
  marker = fx.outsidePath("marker.log");
  repo = fx.repo("trapped").commit({ "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n" });
  repo.git(["switch", "--quiet", "-c", "next"], { records: true });
  repo.commit({ "b.txt": "b2\n" });
  repo.git(["switch", "--quiet", "main"], { records: true });
  topic = repo.worktree("trapped-topic", { from: "next", branch: "topic" });
  topic.commit({ "c.txt": "c2\n" });
  topic.git(["branch", "--quiet", "--set-upstream-to=next"]);
  // Every trap, the filter driver included, in the repository's own config.
  repo.maliciousConfig(marker, { vectors: [...DEFAULT_MALICIOUS_VECTORS, "filter"] });
  topic.signedCommit();
  // Same-size edits, so Git must read the files through the filter to compare them.
  topic.write({ "a.txt": "a3\n", "b.txt": "b3\n" }).stage(["b.txt"]);
  topic.write({ "c.txt": "c3\n", "new.txt": "new\n" });
  repo.write({ "a.txt": "a4\n", "u.txt": "u\n" });
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

describe("comparisons in a repository whose own config tries to run programs", () => {
  it("run none of them: a scan, every kind, and hashing working-tree files", async () => {
    const created = harness();
    try {
      const { client } = created.open(1);
      await client.call("session.open", { scanRoots: [fx.root] });
      await client.call("scan.start", { requestId: "scan" });
      await client.waitForEvent("scan.done");
      for (const checkout of [topic, repo]) {
        for (const kind of LISTABLE_COMPARISON_KINDS) {
          await client.call<ComparisonResult>("comparison.list", {
            checkoutPath: checkout.path,
            kind,
            ...(kind === "base" ? { ref: "main" } : {}),
          });
        }
      }
      // Every kind is available for the worktree, and its lists hashed working-tree files.
      for (const kind of LISTABLE_COMPARISON_KINDS) {
        const result = await client.call<ComparisonResult>("comparison.list", {
          checkoutPath: topic.path,
          kind,
          ...(kind === "base" ? { ref: "main" } : {}),
        });
        expect(result.ok, kind).toBe(true);
      }
      const review = await client.call<ComparisonResult>("comparison.list", {
        checkoutPath: topic.path,
        kind: "review",
      });
      if (!review.ok) throw new Error(review.error.message);
      const hashed = review.value.files.find((file) => file.path === "new.txt");
      expect(hashed?.resultHash).toBe(
        gitIn(topic.path, ["hash-object", "--no-filters", "--", "new.txt"]).trim(),
      );
    } finally {
      created.dispose();
    }
    expect(existsSync(marker)).toBe(false);

    gitIn(topic.path, ["status", "--porcelain"]);
    expect(existsSync(marker), "plain git status should fire the traps").toBe(true);
    rmSync(marker, { force: true });
  });
});
