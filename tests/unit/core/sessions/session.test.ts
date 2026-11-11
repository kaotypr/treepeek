import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { observeSpawns } from "../../../../src/core/git/process";
import { validatePaths } from "../../../../src/core/handlers/paths";
import type { Session } from "../../../../src/core/sessions/session";
import type { FileDiff } from "../../../../src/shared/domain/diff";
import type { ReviewStatus } from "../../../../src/shared/domain/review";
import type { WorktreeChoice } from "../../../../src/shared/domain/scan";
import type { Result } from "../../../../src/shared/ipc/result";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { tempStore } from "../../../support/core-scan";
import { type Client, type Harness, harness } from "../../../support/core-session";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

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

async function scan(
  client: Client,
  root: string,
  requestId = "s1",
  worktrees?: WorktreeChoice,
): Promise<void> {
  const before = client.events("scan.done").length;
  await client.call("session.open", { scanRoots: [root], ...(worktrees ? { worktrees } : {}) });
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
    expect(() => closed.open([fx.root], "all")).toThrow();
  });

  it("forgets its last scan when it opens again with another worktree choice", async () => {
    const { session, client } = newHarness().open(1);
    await scan(client, fx.root);
    expect(session.lastScan?.worktrees).toBe("all");
    expect(session.open([fx.root], "all")).toBeTruthy();
    expect(session.lastScan).not.toBeNull();
    session.open([fx.root], "walked");
    expect(session.lastScan).toBeNull();
    expect(session.worktrees).toBe("walked");
    expect(await session.isInScan(app.path)).toBe(false);
  });
});

describe("outside worktrees", () => {
  let local: Fixture;
  let repo: FixtureRepo;
  let elsewhere: FixtureCheckout;
  let agent: FixtureCheckout;
  let stored: ReturnType<typeof tempStore>;
  let requests = 0;

  beforeAll(() => {
    local = fixture();
    repo = local.repo("app").commit({ "a.txt": "1\n" });
    elsewhere = repo.outsideWorktree("agents/app-1", { from: "main" });
    elsewhere.write({ "new.txt": "outside\n" });
    agent = repo.agentWorktree("task-1", { from: "main" });
    agent.write({ "agent.txt": "agent\n" });
  });
  afterEach(() => stored?.dispose());
  afterAll(() => local.cleanup());

  function withStore(): Harness {
    stored = tempStore();
    const created = harness(() => stored.store);
    harnesses.push(created);
    return created;
  }

  function diff(client: Client, checkoutPath: string, path: string) {
    requests += 1;
    return client.call<FileDiff>("diff.file", {
      requestId: `diff-${requests}`,
      checkoutPath,
      comparison: { kind: "review" },
      path,
    });
  }

  function value<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  }

  it("diffs and marks a file in an outside worktree, under the id a root holding it gives", async () => {
    const created = withStore();
    const first = created.open(1);
    await scan(first.client, local.root);
    expect(value(await diff(first.client, elsewhere.path, "new.txt"))).toMatchObject({
      path: "new.txt",
      status: "untracked",
      right: "outside\n",
    });
    const marked = value(
      await first.client.call<ReviewStatus>("review.mark", {
        checkoutPath: elsewhere.path,
        paths: ["new.txt"],
        viewed: true,
      }),
    );
    expect(marked).toMatchObject({ checkoutPath: elsewhere.path, viewed: 1, total: 1 });
    expect(await validatePaths([first.session], [join(elsewhere.path, "new.txt")])).toEqual([true]);

    // Another window whose root holds the worktree: the same identity, so the same mark.
    const second = created.open(2);
    await scan(second.client, local.outsidePath("agents"));
    expect((await second.session.findCheckout(elsewhere.path))?.checkout.location).toBe("inside");
    const [status] = value(
      await second.client.call<ReviewStatus[]>("review.status", {
        checkoutPaths: [elsewhere.path],
      }),
    );
    expect(status).toMatchObject({ worktreeId: marked.worktreeId, viewed: 1 });
    expect((await second.session.findCheckout(elsewhere.path))?.worktreeId).toBe(
      (await first.session.findCheckout(elsewhere.path))?.worktreeId,
    );
  });

  it("refuses an outside worktree's paths when the session leaves outside worktrees out", async () => {
    const created = withStore();
    const { session, client } = created.open(1);
    await scan(client, local.root, "s1", "inside");
    expect((await session.findCheckout(agent.path))?.checkout.location).toBe("inside");
    expect(value(await diff(client, agent.path, "agent.txt"))).toMatchObject({ path: "agent.txt" });
    const refused = { ok: false, error: { code: "notInScan" } };
    expect(await diff(client, elsewhere.path, "new.txt")).toMatchObject(refused);
    expect(
      await client.call("review.mark", {
        checkoutPath: elsewhere.path,
        paths: ["new.txt"],
        viewed: true,
      }),
    ).toMatchObject(refused);
    expect(
      await client.call("comparison.list", { checkoutPath: elsewhere.path, kind: "working" }),
    ).toMatchObject(refused);
    expect(
      await client.call("start.override", { checkoutPath: elsewhere.path, commit: null }),
    ).toMatchObject(refused);
    expect(await validatePaths([session], [join(elsewhere.path, "new.txt")])).toEqual([false]);

    // Walked only: the worktree inside the main checkout is left out too.
    await scan(client, local.root, "s2", "walked");
    expect(await diff(client, agent.path, "agent.txt")).toMatchObject(refused);
    expect(await session.findCheckout(agent.path)).toBeNull();
    // Its folder still lies inside the main checkout, which the path rule lets in as before.
    expect(await session.isInScan(agent.path)).toBe(true);
    expect(await session.isInScan(elsewhere.path)).toBe(false);
  });
});
