import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeSpawns } from "../../../../src/core/git/process";
import type { ChangeKind } from "../../../../src/shared/domain/change";
import type { ComparisonResult } from "../../../../src/shared/domain/compare";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { type Client, type Harness, harness } from "../../../support/core-session";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

let fx: Fixture;
let repo: FixtureRepo;
let created: Harness;
let client: Client;
let scans = 0;

beforeAll(async () => {
  setTestGit();
  fx = fixture();
  repo = fx.repo("cachy").commit({ "a.txt": "a\n" }).commit({ "b.txt": "b\n" });
  created = harness();
  client = created.open(1).client;
  await client.call("session.open", { scanRoot: fx.root });
  await rescan();
});
afterAll(() => {
  created.dispose();
  fx.cleanup();
  resetGitRuntime();
});

async function rescan(): Promise<void> {
  scans += 1;
  await client.call("scan.start", { requestId: `scan-${scans}` });
  await client.waitForEvent("scan.done", scans);
}

async function paths(kind: "working" | "review" | "worktree"): Promise<string[]> {
  const result = await client.call<ComparisonResult>("comparison.list", {
    checkoutPath: repo.path,
    kind,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.files.map((file) => `${file.category ?? ""}:${file.path}`);
}

async function spawnsDuring(work: () => Promise<unknown>): Promise<number> {
  let spawned = 0;
  const stop = observeSpawns((event) => {
    if (event.type === "spawn") spawned += 1;
  });
  try {
    await work();
  } finally {
    stop();
  }
  return spawned;
}

function invalidate(kinds: readonly ChangeKind[]): void {
  const resources = created.state.repository(repo.commonDir);
  if (!resources) throw new Error("the repository is not held");
  resources.cache.invalidate(repo.path, kinds);
}

describe("comparison list caching", () => {
  it("serves a repeated list without running git", async () => {
    await paths("working");
    expect(await spawnsDuring(() => paths("working"))).toBe(0);
    // Between two commits the list, the count and the ancestry are content-addressed.
    expect(await paths("worktree")).toEqual([":b.txt"]);
    expect(await spawnsDuring(() => paths("worktree"))).toBe(0);
  });

  it("shows a newly staged file in working after invalidate(path, ['index'])", async () => {
    expect(await paths("working")).toEqual([]);
    repo.write({ "fresh.txt": "fresh\n" }).stage(["fresh.txt"]);
    expect(await paths("working")).toEqual([]);
    invalidate(["refs", "reflog"]);
    expect(await paths("working")).toEqual([]);
    invalidate(["index"]);
    expect(await paths("working")).toEqual(["staged:fresh.txt"]);
  });

  it("reads the lists again on the next scan, before live refresh exists", async () => {
    expect(await paths("review")).not.toContain(":later.txt");
    repo.write({ "later.txt": "later\n" });
    expect(await paths("review")).not.toContain(":later.txt");
    await rescan();
    expect(await paths("review")).toContain(":later.txt");
    expect(await paths("working")).toContain("untracked:later.txt");
  });
});
