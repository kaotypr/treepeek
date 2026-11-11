/**
 * Background mode (`refresh.foreground`) on real repositories with the desktop's own
 * watchers: while a session is in the background, edits in a working tree run no
 * `git status` and send nothing, changes in Git still refresh, and coming back refreshes
 * each stale checkout once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeSpawns } from "../../src/core/git/process";
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

let fx: Fixture;
let repo: FixtureRepo;
let wtA: FixtureCheckout;
let wtB: FixtureCheckout;
let store: ReturnType<typeof tempStore>;
let h: Harness;
let stopObserving: (() => void) | null;

beforeEach(() => {
  setTestGit();
  fx = fixture();
  repo = fx.repo("app").commit({ "a.txt": "a\n" });
  wtA = repo.worktree("wt-a", { from: "main" }).commit({ "one.txt": "1\n" });
  wtB = repo.worktree("wt-b", { from: "main" });
  store = tempStore();
  h = harness(() => store.store, {});
  stopObserving = null;
});

afterEach(async () => {
  stopObserving?.();
  // Every watcher stops before the folders it watches are deleted.
  await h.disposeAndWait();
  store.dispose();
  fx.cleanup();
  resetGitRuntime();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function watching(): Promise<Client> {
  const { client } = h.open(1);
  expect(await client.call("session.open", { scanRoots: [fx.root] })).toMatchObject({ ok: true });
  expect(await client.call("scan.start", { requestId: "scan-1" })).toMatchObject({ ok: true });
  await client.waitForEvent("scan.done");
  await client.waitForEvent("refresh.paused");
  return client;
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Counts the `git status` runs in each checkout from now on. */
function statusRuns(): Map<string, number> {
  const runs = new Map<string, number>();
  stopObserving = observeSpawns((event) => {
    if (event.type !== "spawn" || event.args[0] !== "-C") return;
    const cwd = event.args[1];
    if (cwd === undefined || !event.args.includes("status")) return;
    runs.set(cwd, (runs.get(cwd) ?? 0) + 1);
  });
  return runs;
}

function refreshes(client: Client, from: number): RefreshCheckout[] {
  return client.events<RefreshCheckout>("refresh.checkout").slice(from);
}

describe("refresh.foreground", () => {
  it("only marks edited checkouts stale in the background, and refreshes them once on return", async () => {
    const client = await watching();
    const live = h.live;
    if (!live) throw new Error("no live refresh");
    // Whatever the watchers report of the fixture's own setup has run its course.
    await sleep(800);
    await live.runner.idle();

    expect(await client.call("refresh.foreground", { foreground: false })).toEqual({
      ok: true,
      value: {},
    });
    const runs = statusRuns();
    let from = client.events("refresh.checkout").length;
    for (let index = 0; index < 5; index += 1) {
      wtA.write({ [`burst-${index}.txt`]: `${index}\n` });
      await sleep(40);
    }
    wtA.write({ "a.txt": "a, edited in the background\n" });
    // Past the debounce (400 ms quiet) of the burst.
    await sleep(1_200);
    await live.runner.idle();
    expect(runs.get(wtA.path) ?? 0).toBe(0);
    expect(refreshes(client, from)).toEqual([]);

    // A commit is a change in Git: it still refreshes the checkout it was made in.
    wtB.commit({ "two.txt": "2\n" });
    const head = wtB.head();
    await until(
      () =>
        refreshes(client, from).find(
          (p) => p.checkoutPath === wtB.path && p.checkout.head === head,
        ),
      "the commit in wt-b",
    );
    await live.runner.idle();
    expect(runs.get(wtA.path) ?? 0).toBe(0);
    // wt-a may hear that refs moved, but nothing about its working tree.
    expect(
      refreshes(client, from).filter(
        (p) => p.checkoutPath === wtA.path && p.changed.includes("workingTree"),
      ),
    ).toEqual([]);

    // Back in the foreground: wt-a, and only wt-a, is refreshed once.
    await sleep(600);
    await live.runner.idle();
    from = client.events("refresh.checkout").length;
    const before = new Map(runs);
    expect(await client.call("refresh.foreground", { foreground: true })).toMatchObject({
      ok: true,
    });
    await live.runner.idle();
    await sleep(600);
    await live.runner.idle();
    const back = refreshes(client, from);
    expect(back.map((p) => [p.checkoutPath, p.changed])).toEqual([[wtA.path, ["workingTree"]]]);
    expect(back[0]?.checkout.working).toEqual({ staged: 0, unstaged: 1, untracked: 5 });
    expect((runs.get(wtA.path) ?? 0) - (before.get(wtA.path) ?? 0)).toBe(1);
    for (const path of [repo.path, wtB.path]) {
      expect(runs.get(path) ?? 0, path).toBe(before.get(path) ?? 0);
    }

    // Already in the foreground: nothing more.
    from = client.events("refresh.checkout").length;
    expect(await client.call("refresh.foreground", { foreground: true })).toMatchObject({
      ok: true,
    });
    await live.runner.idle();
    expect(refreshes(client, from)).toEqual([]);

    // And edits refresh as they come again.
    wtA.write({ "after.txt": "back\n" });
    await until(
      () =>
        refreshes(client, from).find(
          (p) => p.checkoutPath === wtA.path && p.checkout.working.untracked === 6,
        ),
      "an edit in the foreground",
    );
  });

  it("refreshes in the background when Git changes in a checkout edits were made in", async () => {
    const client = await watching();
    const live = h.live;
    if (!live) throw new Error("no live refresh");
    await sleep(800);
    await live.runner.idle();
    await client.call("refresh.foreground", { foreground: false });
    const from = client.events("refresh.checkout").length;
    wtA.write({ "staged.txt": "s\n" });
    await sleep(800);
    await live.runner.idle();
    expect(refreshes(client, from)).toEqual([]);
    // Staging changes the index: wt-a refreshes, and is no longer stale.
    wtA.stage(["staged.txt"]);
    await until(
      () =>
        refreshes(client, from).find(
          (p) => p.checkoutPath === wtA.path && p.checkout.working.staged === 1,
        ),
      "the staging in the background",
    );
    await live.runner.idle();
    const seen = client.events("refresh.checkout").length;
    await client.call("refresh.foreground", { foreground: true });
    await live.runner.idle();
    expect(refreshes(client, seen)).toEqual([]);
  });
});
