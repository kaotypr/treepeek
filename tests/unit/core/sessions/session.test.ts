import { symlinkSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { observeSpawns } from "../../../../src/core/git/process";
import type { Session } from "../../../../src/core/sessions/session";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { type Client, type Harness, harness } from "../../../support/core-session";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

let fx: Fixture;
let app: FixtureRepo;
const harnesses: Harness[] = [];

function newHarness(): Harness {
  const created = harness();
  harnesses.push(created);
  return created;
}

beforeAll(() => {
  setTestGit();
  fx = fixture();
  app = fx.repo("app").commit({ "a.txt": "1\n" });
  app.worktree("app-feature", { from: "main" });
  writeFileSync(fx.outsidePath("outside.txt"), "o\n");
  symlinkSync(fx.outsidePath("outside.txt"), fx.path("app/link-out"));
});
afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose();
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

async function scan(client: Client, root: string, requestId = "s1"): Promise<void> {
  const before = client.events("scan.done").length;
  await client.call("session.open", { scanRoot: root });
  await client.call("scan.start", { requestId });
  await client.waitForEvent("scan.done", before + 1);
}

describe("Session", () => {
  it("applies the path rule only after a scan, with symlinks resolved", async () => {
    const { session, client } = newHarness().open(1);
    expect(await session.isInScan(app.path)).toBe(false);
    await scan(client, fx.root);
    expect(await session.isInScan(app.path)).toBe(true);
    expect(await session.isInScan(fx.path("app/a.txt"))).toBe(true);
    expect(await session.isInScan(fx.path("app/link-out"))).toBe(false);
    expect(await session.isInScan(fx.outsidePath("outside.txt"))).toBe(false);
    expect(await session.findCheckout(fx.path("app/a.txt"))).toBeNull();
    expect((await session.findCheckout(`${app.path}/`))?.checkout.path).toBe(app.path);
  });

  it("shares a repository's cache between two sessions until both have closed", async () => {
    const created = newHarness();
    const first = created.open(1);
    const second = created.open(2);
    await scan(first.client, fx.root);
    await scan(second.client, fx.root);
    const shared = created.state.repository(app.commonDir);
    expect(shared).toBeDefined();
    expect(created.state.repositoryHolders(app.commonDir)).toBe(2);
    expect(created.state.checkoutHolders(app.path)).toBe(2);

    created.registry.close(1);
    expect(created.state.repository(app.commonDir)).toBe(shared);
    expect(created.state.repositoryHolders(app.commonDir)).toBe(1);
    expect(shared?.cache.worktreeList.peek(app.commonDir)).toHaveLength(2);
    // The surviving session rescans from the shared cache: the worktree list is not re-read.
    const lists: string[][] = [];
    const stop = observeSpawns((event) => {
      if (event.type === "spawn" && event.args.includes("worktree")) lists.push([...event.args]);
    });
    await scan(second.client, fx.root, "s2");
    stop();
    expect(lists).toEqual([]);
    expect(created.state.repository(app.commonDir)).toBe(shared);

    created.registry.close(2);
    expect(created.state.repository(app.commonDir)).toBeUndefined();
    expect(created.state.size).toEqual({ repositories: 0, checkouts: 0 });
  });

  it("releases what leaves its scan, and everything when the scan root changes", async () => {
    const local = fixture();
    try {
      const repo = local.repo("r").commit({ "a.txt": "1\n" });
      const wt = repo.worktree("r-wt", { from: "main" });
      const created = newHarness();
      const { session, client } = created.open(1);
      await scan(client, local.root);
      expect(created.state.checkoutHolders(wt.path)).toBe(1);

      repo.repoGit(["worktree", "remove", "--force", wt.path]);
      await scan(client, local.root, "s2");
      expect(created.state.checkoutHolders(wt.path)).toBe(0);
      expect(created.state.checkoutHolders(repo.path)).toBe(1);
      expect(await session.isInScan(wt.path)).toBe(false);

      await scan(client, fx.root, "s3");
      expect(created.state.repositoryHolders(repo.commonDir)).toBe(0);
      expect(created.state.repositoryHolders(app.commonDir)).toBe(1);
      expect(await session.isInScan(repo.path)).toBe(false);
    } finally {
      local.cleanup();
    }
  });

  it("refuses to work once closed", async () => {
    const created = newHarness();
    const { session, client } = created.open(1);
    await scan(client, fx.root);
    created.registry.close(1);
    const closed: Session = session;
    expect(closed.closed).toBe(true);
    expect(await closed.isInScan(app.path)).toBe(false);
    expect(() => closed.open(fx.root)).toThrow();
  });
});
