import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pruneAfterScan } from "../../../../src/core/review/prune";
import { SNAPSHOT_FOLDER } from "../../../../src/core/store/snapshots";
import type { FileDiff } from "../../../../src/shared/domain/diff";
import {
  type PreviousMark,
  type ReviewStatus,
  reviewProgress,
} from "../../../../src/shared/domain/review";
import type { Result } from "../../../../src/shared/ipc/result";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { tempStore } from "../../../support/core-scan";
import { type Client, type Harness, harness } from "../../../support/core-session";
import { type Fixture, type FixtureCheckout, fixture } from "../../../support/git-fixture";

let stored: ReturnType<typeof tempStore>;
const harnesses: Harness[] = [];
const fixtures: Fixture[] = [];
let windows = 0;
let requests = 0;

beforeAll(() => {
  setTestGit();
});
afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose();
  for (const fx of fixtures.splice(0)) fx.cleanup();
  stored?.dispose();
});
afterAll(() => resetGitRuntime());

function newFixture(): Fixture {
  const fx = fixture();
  fixtures.push(fx);
  stored = tempStore();
  return fx;
}

/** A window's session on `root`, scanned once. */
async function open(root: string, existing?: Harness): Promise<{ client: Client; h: Harness }> {
  const h = existing ?? harness(() => stored.store);
  if (!existing) harnesses.push(h);
  windows += 1;
  const { client } = h.open(windows);
  await client.call("session.open", { scanRoots: [root] });
  await rescan(client);
  return { client, h };
}

async function rescan(client: Client): Promise<void> {
  const done = client.events("scan.done").length;
  requests += 1;
  await client.call("scan.start", { requestId: `scan-${requests}` });
  await client.waitForEvent("scan.done", done + 1);
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function status(client: Client, checkout: FixtureCheckout): Promise<ReviewStatus> {
  const [one] = value(
    await client.call<ReviewStatus[]>("review.status", { checkoutPaths: [checkout.path] }),
  );
  if (!one) throw new Error("no status");
  return one;
}

function mark(client: Client, checkout: FixtureCheckout, paths: string[], viewed = true) {
  return client.call<ReviewStatus>("review.mark", { checkoutPath: checkout.path, paths, viewed });
}

function sinceViewed(client: Client, checkout: FixtureCheckout, path: string) {
  requests += 1;
  return client.call<FileDiff>("diff.file", {
    requestId: `diff-${requests}`,
    checkoutPath: checkout.path,
    comparison: { kind: "sinceViewed" },
    path,
  });
}

const states = (s: ReviewStatus) => Object.fromEntries(s.files.map((f) => [f.path, f.state]));

/** The lines a since-viewed diff adds and removes. */
function changedLines(diff: FileDiff): string[] {
  return diff.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) =>
      line.kind === "add" ? [`+${line.text}`] : line.kind === "remove" ? [`-${line.text}`] : [],
    ),
  );
}

describe("review status and marks", () => {
  it("moves through every transition of the design's state diagram", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "one\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.commit({ "b.txt": "b\n" }).write({ "a.txt": "one, edited\n" });
    const { client } = await open(fx.root);

    // unviewed → viewed (mark) → unviewed (unmark)
    expect(states(await status(client, feature))).toEqual({
      "a.txt": "unviewed",
      "b.txt": "unviewed",
    });
    expect(states(value(await mark(client, feature, ["a.txt"])))).toMatchObject({
      "a.txt": "viewed",
    });
    expect(states(value(await mark(client, feature, ["a.txt"], false)))).toMatchObject({
      "a.txt": "unviewed",
    });

    // viewed → changedSinceViewed (the content changes; seen after a rescan)
    value(await mark(client, feature, ["a.txt"]));
    feature.write({ "a.txt": "one, edited twice over\n" });
    await rescan(client);
    const changed = await status(client, feature);
    expect(changed.files.find((file) => file.path === "a.txt")).toMatchObject({
      state: "changedSinceViewed",
      earlierAvailable: true,
    });
    expect(changed).toMatchObject({ total: 2, viewed: 0, changedSinceViewed: 1 });

    // changedSinceViewed → viewed (mark again)
    expect(states(value(await mark(client, feature, ["a.txt"])))).toMatchObject({
      "a.txt": "viewed",
    });

    // changedSinceViewed → unviewed (unmark)
    feature.write({ "a.txt": "a third version of the file\n" });
    await rescan(client);
    expect(states(await status(client, feature))).toMatchObject({ "a.txt": "changedSinceViewed" });
    expect(states(value(await mark(client, feature, ["a.txt"], false)))).toMatchObject({
      "a.txt": "unviewed",
    });
  });

  it("adds up progress, and a worktree without changes has none to add up", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const quiet = app.worktree("quiet", { from: "main" });
    const busy = app.worktree("busy", { from: "main" });
    busy.commit({ "x.txt": "x\n", "y.txt": "y\n" }).write({ "z.txt": "z\n" });
    const { client } = await open(fx.root);

    const none = await status(client, quiet);
    expect(none).toMatchObject({ total: 0, viewed: 0, files: [] });
    expect(reviewProgress(none)).toEqual({
      percent: 0,
      reviewed: false,
      empty: true,
      changed: false,
    });

    const some = value(await mark(client, busy, ["x.txt"]));
    expect(some).toMatchObject({ total: 3, viewed: 1 });
    expect(reviewProgress(some)).toMatchObject({ percent: 33, reviewed: false });
    const all = value(await mark(client, busy, ["y.txt", "z.txt"]));
    expect(reviewProgress(all)).toEqual({
      percent: 100,
      reviewed: true,
      empty: false,
      changed: false,
    });
  });

  it("says the scope is partial when the start is unknown", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const known = app.worktree("known", { from: "main" });
    known.write({ "k.txt": "k\n" });
    const { client } = await open(fx.root);
    expect((await status(client, known)).partialScope).toBe(false);

    const fx2 = newFixture();
    const old = fx2.repo("old").commit({ "a.txt": "a\n" }).commit({ "a.txt": "b\n" });
    old.write({ "u.txt": "u\n" }).expireReflog();
    const second = await open(fx2.root);
    const partial = await status(second.client, old);
    expect(partial.partialScope).toBe(true);
    // Only the uncommitted change is in a partial scope.
    expect(partial.files.map((file) => file.path)).toEqual(["u.txt"]);
  });

  it("gives a deleted file the version deleted:<leftOid>, which can be viewed", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "gone.txt": "bye\n", "kept.txt": "k\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "gone.txt": null });
    const leftOid = app.rev("main:gone.txt");
    const { client } = await open(fx.root);
    const marked = value(await mark(client, feature, ["gone.txt"]));
    expect(states(marked)).toEqual({ "gone.txt": "viewed" });
    const [row] = stored.store.getMarks(marked.worktreeId);
    expect(row).toMatchObject({
      path: "gone.txt",
      resultHash: `deleted:${leftOid}`,
      snapshotHash: null,
    });
  });

  it("keeps a file viewed when it leaves the scope and comes back as the same version", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "original\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "changed\n", "b.txt": "b\n" });
    const { client } = await open(fx.root);
    value(await mark(client, feature, ["a.txt"]));

    feature.write({ "a.txt": "original\n" });
    await rescan(client);
    const without = await status(client, feature);
    expect(without.files.map((file) => file.path)).toEqual(["b.txt"]);
    expect(without).toMatchObject({ total: 1, viewed: 0 });

    feature.write({ "a.txt": "changed\n" });
    await rescan(client);
    expect(states(await status(client, feature))).toEqual({
      "a.txt": "viewed",
      "b.txt": "unviewed",
    });
  });

  it("refuses to mark a path outside the scope, the checkout or the scan", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n", "same.txt": "s\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "edited\n" });
    const { client } = await open(fx.root);
    for (const path of ["same.txt", "missing.txt"]) {
      expect(await mark(client, feature, [path])).toMatchObject({
        ok: false,
        error: { code: "invalidRequest", detail: { notInScope: [path] } },
      });
    }
    // Nothing was marked, not even the path that is in the scope.
    expect(await mark(client, feature, ["a.txt", "same.txt"])).toMatchObject({ ok: false });
    expect((await status(client, feature)).viewed).toBe(0);
    expect(await mark(client, feature, ["../escape.txt"])).toMatchObject({
      ok: false,
      error: { code: "notInScan" },
    });
    expect(
      await client.call("review.mark", {
        checkoutPath: fx.outside,
        paths: ["a.txt"],
        viewed: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "notInScan" } });
    expect(
      await client.call("review.status", { checkoutPaths: [feature.path, fx.path("nope")] }),
    ).toMatchObject({ ok: false, error: { code: "notInScan" } });
  });

  it("marks all, unmarks all, and restores exactly what each replaced", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n", "b.txt": "b\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c\n" });
    const { client } = await open(fx.root);
    value(await mark(client, feature, ["a.txt"]));
    feature.write({ "b.txt": "b1, changed again\n" });
    value(await mark(client, feature, ["b.txt"]));
    feature.write({ "b.txt": "b2, after viewing\n" });
    await rescan(client);
    const before = await status(client, feature);
    expect(states(before)).toEqual({
      "a.txt": "viewed",
      "b.txt": "changedSinceViewed",
      "c.txt": "unviewed",
    });

    const all = value(
      await client.call<{ status: ReviewStatus; previous: PreviousMark[] }>("review.markAll", {
        checkoutPath: feature.path,
        viewed: true,
      }),
    );
    expect(reviewProgress(all.status).reviewed).toBe(true);
    const viewedB = before.files.find((file) => file.path === "b.txt")?.viewedHash;
    expect(all.previous).toEqual([
      { path: "b.txt", resultHash: viewedB },
      { path: "c.txt", resultHash: null },
    ]);

    // Undo: restore the versions marked before, and drop the marks that were not there.
    const restored = all.previous.filter((item) => item.resultHash !== null);
    value(
      await client.call("review.mark", {
        checkoutPath: feature.path,
        paths: restored.map((item) => item.path),
        viewed: true,
        resultHashes: restored.map((item) => item.resultHash),
      }),
    );
    const undone = value(await mark(client, feature, ["c.txt"], false));
    expect(undone.files).toEqual(before.files);

    const cleared = value(
      await client.call<{ status: ReviewStatus; previous: PreviousMark[] }>("review.markAll", {
        checkoutPath: feature.path,
        viewed: false,
      }),
    );
    expect(cleared.status.viewed + cleared.status.changedSinceViewed).toBe(0);
    expect(cleared.previous.map((item) => item.path)).toEqual(["a.txt", "b.txt"]);
    value(
      await client.call("review.mark", {
        checkoutPath: feature.path,
        paths: cleared.previous.map((item) => item.path),
        viewed: true,
        resultHashes: cleared.previous.map((item) => item.resultHash),
      }),
    );
    expect((await status(client, feature)).files).toEqual(before.files);
  });

  it("applies marks for one checkout in the order they were sent", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "a1\n", "b.txt": "b\n", "c.txt": "c\n" });
    const { client } = await open(fx.root);
    // Sent at once: "Unmark all" must not overtake "Mark all" still keeping snapshots.
    const [all, none] = await Promise.all([
      client.call("review.markAll", { checkoutPath: feature.path, viewed: true }),
      client.call("review.markAll", { checkoutPath: feature.path, viewed: false }),
    ]);
    expect(all.ok && none.ok).toBe(true);
    expect((await status(client, feature)).viewed).toBe(0);
    expect(stored.store.getMarks((await status(client, feature)).worktreeId)).toEqual([]);
  });

  it("refuses versions to restore that do not go one per viewed path", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "a1\n" });
    const { client } = await open(fx.root);
    for (const request of [
      { paths: ["a.txt"], viewed: false, resultHashes: ["a".repeat(40)] },
      { paths: ["a.txt", "b.txt"], viewed: true, resultHashes: ["a".repeat(40)] },
    ]) {
      expect(
        await client.call("review.mark", { checkoutPath: feature.path, ...request }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    }
  });

  it("computes every checkout's status after a scan, and tells other windows of new marks", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const one = app.worktree("one", { from: "main" });
    const two = app.worktree("two", { from: "main" });
    one.write({ "1.txt": "1\n" });
    two.write({ "2.txt": "2\n" });
    const first = await open(fx.root);
    await first.client.waitForEvent("review.changed", 3);
    const announced = first.client.events<ReviewStatus>("review.changed");
    expect(announced.map((item) => item.checkoutPath).sort()).toEqual(
      [app.path, one.path, two.path].sort(),
    );

    // A second window on a folder that overlaps the first one's. It lists the other two
    // checkouts too, as outside worktrees, and computes the status of all three.
    const second = await open(fx.path("one"), first.h);
    await second.client.waitForEvent("review.changed", 3);
    const heard = second.client.events("review.changed").length;
    value(await mark(first.client, one, ["1.txt"]));
    await second.client.waitForEvent("review.changed", heard + 1);
    const latest = second.client.events<ReviewStatus>("review.changed").at(-1);
    expect(latest).toMatchObject({ checkoutPath: one.path, viewed: 1 });
    expect(states(await status(second.client, one))).toEqual({ "1.txt": "viewed" });
  });
});

describe("snapshots and since you viewed", () => {
  it("shows only the edit made after a file was viewed", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "notes.txt": "one\ntwo\nthree\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "notes.txt": "one\ntwo, first edit\nthree\n" });
    const { client } = await open(fx.root);
    value(await mark(client, feature, ["notes.txt"]));

    feature.write({ "notes.txt": "one\ntwo, first edit\nthree\nfour, second edit\n" });
    await rescan(client);
    const diff = value(await sinceViewed(client, feature, "notes.txt"));
    expect(changedLines(diff)).toEqual(["+four, second edit"]);
    expect(diff).toMatchObject({ path: "notes.txt", status: "modified", binary: false });
    expect(diff.left).toBe("one\ntwo, first edit\nthree\n");
    expect(diff.right).toBe("one\ntwo, first edit\nthree\nfour, second edit\n");
  });

  it("keeps the same content marked in two worktrees once", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const left = app.worktree("left", { from: "main" });
    const right = app.worktree("right", { from: "main" });
    left.write({ "same.txt": "the same content\n" });
    right.write({ "same.txt": "the same content\n" });
    const { client } = await open(fx.root);
    value(await mark(client, left, ["same.txt"]));
    value(await mark(client, right, ["same.txt"]));
    const files = readdirSync(join(stored.userData, "store", SNAPSHOT_FOLDER));
    expect(files).toHaveLength(1);
    expect(stored.store.snapshotUsage()).toEqual({ count: 1, bytes: 17 });
  });

  it("keeps no snapshot of a 2 MB file: since you viewed uses the blob, or says it is gone", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const feature = app.worktree("feature", { from: "main" });
    const big = (marker: string) => `${marker}\n${"x".repeat(80)}\n`.repeat(26_000);
    feature.write({ "staged.txt": big("staged"), "unstaged.txt": big("unstaged") });
    feature.stage(["staged.txt"]);
    const { client } = await open(fx.root);
    value(await mark(client, feature, ["staged.txt", "unstaged.txt"]));
    expect(stored.store.snapshotUsage().count).toBe(0);

    feature.write({
      "staged.txt": `${big("staged")}tail\n`,
      "unstaged.txt": `${big("unstaged")}tail\n`,
    });
    await rescan(client);
    const now = await status(client, feature);
    expect(now.files).toEqual([
      expect.objectContaining({
        path: "staged.txt",
        state: "changedSinceViewed",
        earlierAvailable: true,
      }),
      expect.objectContaining({
        path: "unstaged.txt",
        state: "changedSinceViewed",
        earlierAvailable: false,
      }),
    ]);
    const fromBlob = value(await sinceViewed(client, feature, "staged.txt"));
    expect(changedLines(fromBlob)).toEqual(["+tail"]);
    expect(await sinceViewed(client, feature, "unstaged.txt")).toMatchObject({
      ok: false,
      error: { code: "refNotFound", detail: { unavailable: "noEarlierVersion" } },
    });
  });

  it("after pruning past the cap, the earlier version of a working-tree file is gone", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "viewed version\n" });
    const { client } = await open(fx.root);
    value(await mark(client, feature, ["a.txt"]));
    feature.write({ "a.txt": "a newer version\n" });
    await rescan(client);
    expect((await status(client, feature)).files[0]?.earlierAvailable).toBe(true);

    pruneAfterScan(
      stored.store,
      { roots: [{ path: fx.root, folders: [] }], worktrees: "all", listedCheckouts: new Map() },
      { capBytes: 0 },
    );
    expect((await status(client, feature)).files[0]).toMatchObject({
      state: "changedSinceViewed",
      earlierAvailable: false,
    });
    expect(await sinceViewed(client, feature, "a.txt")).toMatchObject({
      ok: false,
      error: { detail: { unavailable: "noEarlierVersion" } },
    });
  });

  it("refuses since you viewed for a file without a mark, or with a ref", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "a1\n" });
    const { client } = await open(fx.root);
    expect(await sinceViewed(client, feature, "a.txt")).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", detail: { notInComparison: true } },
    });
    expect(await sinceViewed(client, feature, "../x")).toMatchObject({
      ok: false,
      error: { code: "notInScan" },
    });
  });

  it("clears every mark and snapshot, and every window's progress starts over", async () => {
    const fx = newFixture();
    const app = fx.repo("app").commit({ "a.txt": "a\n" });
    const feature = app.worktree("feature", { from: "main" });
    feature.write({ "a.txt": "a1\n" });
    const { client } = await open(fx.root);
    value(await mark(client, feature, ["a.txt"]));
    expect(value(await client.call("review.storeUsage", {}))).toEqual({ count: 1, bytes: 3 });
    const heard = client.events("review.changed").length;
    value(await client.call("review.clearAll", {}));
    expect(value(await client.call("review.storeUsage", {}))).toEqual({ count: 0, bytes: 0 });
    await client.waitForEvent("review.changed", heard + 2);
    const after = client.events<ReviewStatus>("review.changed").slice(heard);
    expect(after.find((item) => item.checkoutPath === feature.path)?.viewed).toBe(0);
  });
});
