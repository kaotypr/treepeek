/**
 * Live refresh end to end inside the core service: real repositories, the real FSEvents
 * watcher (`@parcel/watcher`), the real refresh runner, and a session's port. Each change
 * is made with git or on disk the way a person or an agent would, and the test waits for
 * what the window would hear.
 */
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultBackends } from "../../src/core/watch/backends";
import type { ReviewStatus } from "../../src/shared/domain/review";
import type { CoreEvents } from "../../src/shared/ipc";
import type { EventPayload } from "../../src/shared/ipc/define";
import { resetGitRuntime, setTestGit } from "../support/core-git";
import { tempStore } from "../support/core-scan";
import { type Client, type Harness, harness } from "../support/core-session";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../support/git-fixture";

type RefreshCheckout = EventPayload<CoreEvents["refresh.checkout"]>;
type RefreshTimeline = EventPayload<CoreEvents["refresh.timeline"]>;

let fx: Fixture;
let repo: FixtureRepo;
let wtA: FixtureCheckout;
let wtB: FixtureCheckout;
let store: ReturnType<typeof tempStore>;
let h: Harness;

beforeEach(() => {
  setTestGit();
  fx = fixture();
  repo = fx.repo("app").commit({ "a.txt": "a\n", "b.txt": "b\n" });
  wtA = repo.worktree("wt-a", { from: "main" }).commit({ "one.txt": "1\n" });
  wtB = repo.worktree("wt-b", { from: "main" });
  store = tempStore();
  h = harness(() => store.store, {});
});

afterEach(async () => {
  // Every watcher stops before the folders it watches are deleted.
  await h.disposeAndWait();
  store.dispose();
  fx.cleanup();
  resetGitRuntime();
});

/** Opens a window's session on the fixture, scans, and waits until it is watched. */
async function watching(windowId = 1): Promise<Client> {
  const { client } = h.open(windowId);
  expect(await client.call("session.open", { scanRoots: [fx.root] })).toMatchObject({ ok: true });
  expect(await client.call("scan.start", { requestId: `scan-${windowId}` })).toMatchObject({
    ok: true,
  });
  await client.waitForEvent("scan.done");
  // Sent once the scan's folders are watched.
  await client.waitForEvent("refresh.paused");
  return client;
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The next `refresh.checkout` after `from` that `match` accepts. */
function nextRefresh(
  client: Client,
  from: number,
  match: (payload: RefreshCheckout) => boolean,
  what: string,
): Promise<RefreshCheckout> {
  return until(
    () => client.events<RefreshCheckout>("refresh.checkout").slice(from).find(match),
    what,
  );
}

function seen(client: Client, channel = "refresh.checkout"): number {
  return client.events(channel).length;
}

describe("live refresh in the core service", () => {
  it("refreshes a checkout's counts after an edit and after staging", async () => {
    const client = await watching();
    let from = seen(client);
    wtA.write({ "a.txt": "a, edited\n" });
    const edited = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.working.unstaged === 1,
      "the edit",
    );
    expect(edited.changed).toContain("workingTree");
    expect(edited.checkout.working).toEqual({ staged: 0, unstaged: 1, untracked: 0 });

    from = seen(client);
    wtA.stage(["a.txt"]);
    const staged = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.working.staged === 1,
      "the staging",
    );
    expect(staged.changed).toContain("index");
    expect(staged.checkout.working).toEqual({ staged: 1, unstaged: 0, untracked: 0 });
    // Nothing else changed.
    expect(
      client
        .events<RefreshCheckout>("refresh.checkout")
        .slice(from)
        .every((p) => p.checkoutPath === wtA.path),
    ).toBe(true);
  });

  it("moves HEAD and the history counts after a commit, a checkout and a reset", async () => {
    const client = await watching();
    const scanned = client
      .events<{ path: string; history: { commits: number } | null }>("scan.checkout")
      .find((checkout) => checkout.path === wtA.path);
    const commitsBefore = scanned?.history?.commits ?? 0;

    let from = seen(client);
    wtA.commit({ "two.txt": "2\n" });
    const head = wtA.head();
    const committed = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.head === head,
      "the commit",
    );
    expect(committed.changed).toContain("head");
    expect(committed.checkout.history?.commits).toBe(commitsBefore + 1);

    from = seen(client);
    wtA.git(["switch", "--quiet", "-c", "other"]);
    const switched = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.branch === "other",
      "the checkout",
    );
    expect(switched.changed).toContain("head");

    from = seen(client);
    wtA.git(["reset", "--quiet", "--hard", "HEAD~1"]);
    const back = wtA.head();
    const reset = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.head === back,
      "the reset",
    );
    expect(reset.changed).toContain("head");
    expect(reset.checkout.history?.commits).toBe(commitsBefore);
  });

  it("refreshes a checkout whose branch another worktree moved (a ref update)", async () => {
    const client = await watching();
    const from = seen(client);
    // Moves wt-b's branch from outside wt-b: only the ref in the common dir changes.
    repo.git(["update-ref", "refs/heads/wt-b", wtA.head()]);
    const moved = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtB.path && p.checkout.head === wtA.head(),
      "the ref update",
    );
    expect(moved.changed).toEqual(expect.arrayContaining(["head", "refs"]));
  });

  it("recomputes the start after the reflog changes, keeping the identity", async () => {
    const client = await watching();
    const before = client
      .events<{ path: string; start: { commit?: string } }>("scan.checkout")
      .find((checkout) => checkout.path === wtA.path);
    const from = seen(client);
    repo.expireReflog();
    const refreshed = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtA.path && p.changed.includes("reflog"),
      "the reflog change",
    );
    // The reflog is gone; the identity's recorded start carries over.
    expect(refreshed.checkout.start).toMatchObject({
      commit: before?.start.commit,
      source: "override",
    });
  });

  it("adds a worktree created under the root and removes one deleted", async () => {
    const client = await watching();
    let from = seen(client);
    let timelines = seen(client, "refresh.timeline");
    const wtC = repo.worktree("wt-c", { from: "main" });
    const added = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtC.path,
      "the new worktree",
    );
    expect(added.changed).toEqual(["structure"]);
    const grown = await until(
      () =>
        client
          .events<RefreshTimeline>("refresh.timeline")
          .slice(timelines)
          .find((t) => t.timeline.some((entry) => entry.checkoutPath === wtC.path)),
      "the timeline with the new worktree",
    );
    expect(grown.timeline).toHaveLength(4);
    expect(grown.folders.some((folder) => folder.checkoutPath === wtC.path)).toBe(true);
    // The new worktree is part of the window's scan now: it can be compared.
    expect(
      await client.call("comparison.list", { checkoutPath: wtC.path, kind: "working" }),
    ).toMatchObject({ ok: true });

    from = seen(client);
    timelines = seen(client, "refresh.timeline");
    repo.repoGit(["worktree", "remove", "--force", wtB.path]);
    expect(existsSync(wtB.path)).toBe(false);
    const removed = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtB.path,
      "the removed worktree",
    );
    expect(removed.changed).toEqual(["removed"]);
    await until(
      () =>
        client
          .events<RefreshTimeline>("refresh.timeline")
          .slice(timelines)
          .find((t) => !t.timeline.some((entry) => entry.checkoutPath === wtB.path)),
      "the timeline without the removed worktree",
    );
    expect(
      await client.call("comparison.list", { checkoutPath: wtB.path, kind: "working" }),
    ).toMatchObject({ ok: false, error: { code: "notInScan" } });
  });

  it("flags a marked file that changes on disk as changed since viewed", async () => {
    const client = await watching();
    await until(
      () =>
        client
          .events<ReviewStatus>("review.changed")
          .find((status) => status.checkoutPath === wtA.path),
      "the background review status",
    );
    const marked = await client.call<ReviewStatus>("review.mark", {
      checkoutPath: wtA.path,
      paths: ["one.txt"],
      viewed: true,
    });
    expect(marked).toMatchObject({ ok: true, value: { viewed: 1 } });
    const from = seen(client, "review.changed");
    wtA.write({ "one.txt": "1, edited\n" });
    const status = await until(
      () =>
        client
          .events<ReviewStatus>("review.changed")
          .slice(from)
          .find((item) => item.checkoutPath === wtA.path && item.changedSinceViewed === 1),
      "the review status after the edit",
    );
    expect(status.files.find((file) => file.path === "one.txt")?.state).toBe("changedSinceViewed");
  });

  it("catches up after lost events once told the Mac woke", async () => {
    const client = await watching();
    const live = h.live;
    if (!live) throw new Error("no live refresh");
    live.watch.suspend(true);
    wtB.write({ "lost.txt": "written while asleep\n" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(
      client.events<RefreshCheckout>("refresh.checkout").some((p) => p.checkoutPath === wtB.path),
    ).toBe(false);
    live.watch.suspend(false);
    const from = seen(client);
    await live.revalidate();
    const refreshed = client
      .events<RefreshCheckout>("refresh.checkout")
      .slice(from)
      .find((p) => p.checkoutPath === wtB.path);
    expect(refreshed?.checkout.working.untracked).toBe(1);
  });

  it("stops every watcher when the window's session closes", async () => {
    await watching(1);
    const live = h.live;
    if (!live) throw new Error("no live refresh");
    const watched = live.watch.subscriptions();
    expect(watched.map((item) => item.kind).sort()).toEqual([
      "common",
      "root",
      "workingTree",
      "workingTree",
      "workingTree",
    ]);
    expect(watched.every((item) => item.backend === "fsevents")).toBe(true);
    await watching(2);
    expect(live.watch.subscriptions()).toHaveLength(5);
    h.registry.close(1);
    h.registry.close(2);
    await until(
      () => (live.watch.subscriptions().length === 0 ? true : undefined),
      "the watchers to stop",
    );
  });
});

describe("live refresh when a watcher fails", () => {
  it("falls back to fs.watch when FSEvents cannot watch, and still refreshes", async () => {
    await h.disposeAndWait();
    h = harness(() => store.store, { backends: defaultBackends(new Set(["fsevents"])) });
    const client = await watching();
    const live = h.live;
    expect(live?.watch.backend()).toBe("fs.watch");
    expect(live?.watch.subscriptions().every((item) => item.backend === "fs.watch")).toBe(true);
    const from = seen(client);
    wtA.write({ "a.txt": "edited under fs.watch\n" });
    const edited = await nextRefresh(
      client,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.working.unstaged === 1,
      "the edit seen by fs.watch",
    );
    expect(edited.changed).toContain("workingTree");
  });

  it("reports every folder no backend can watch, and refreshes nothing on its own", async () => {
    await h.disposeAndWait();
    h = harness(() => store.store, {
      backends: defaultBackends(new Set(["fsevents", "fs.watch"])),
    });
    const client = await watching();
    // Each folder is reported as its last backend fails.
    const last = await until(() => {
      const latest =
        client.events<{ paused: { path: string; reason: string }[] }>("refresh.paused").at(-1)
          ?.paused ?? [];
      return latest.length === 5 ? latest : undefined;
    }, "every folder reported");
    expect(last.map((item) => item.reason)).toEqual(Array(5).fill("watcherError"));
    expect(last.map((item) => item.path)).toEqual(
      expect.arrayContaining([fx.root, repo.commonDir, repo.path, wtA.path, wtB.path]),
    );
    const from = seen(client);
    wtA.write({ "a.txt": "nobody watches\n" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(client.events("refresh.checkout").slice(from)).toEqual([]);
  });
});
