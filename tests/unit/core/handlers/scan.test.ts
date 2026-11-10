import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { observeSpawns } from "../../../../src/core/git/process";
import { setGitBinary } from "../../../../src/core/git/runtime";
import type { Checkout } from "../../../../src/shared/domain/scan";
import type { CoreEvents } from "../../../../src/shared/ipc";
import type { EventPayload } from "../../../../src/shared/ipc/define";
import { resetGitRuntime, setFakeGit, setTestGit } from "../../../support/core-git";
import {
  type Client,
  type Harness,
  harness,
  isAlive,
  slowGit,
} from "../../../support/core-session";
import { testGitVersion } from "../../../support/git";
import { type Fixture, fixture } from "../../../support/git-fixture";

type ScanDone = EventPayload<CoreEvents["scan.done"]>;
type ScanStarted = { scanRoot: string; folders: { relativePath: string }[]; depthLimit: number };

let fx: Fixture;
const harnesses: Harness[] = [];

function newHarness(): Harness {
  const created = harness();
  harnesses.push(created);
  return created;
}

beforeAll(() => {
  fx = fixture();
  const app = fx.repo("app").commit({ "a.txt": "1\n" });
  app.worktree("work/a", { from: "main" }).commit({ "b.txt": "2\n" });
  app.worktree("work/b", { from: "main" });
  fx.repo("lib").commit({ "l.txt": "l\n" });
});
afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose();
  resetGitRuntime();
});
afterAll(() => fx.cleanup());

async function openAt(client: Client, scanRoot: string) {
  return client.call<{ sessionId: string; gitVersion: string }>("session.open", { scanRoot });
}

/** Records every git process started from now on. */
function spawned(): { pids: number[]; stop(): void } {
  const pids: number[] = [];
  const stop = observeSpawns((event) => {
    if (event.type === "spawn") pids.push(event.pid);
  });
  return { pids, stop };
}

describe("session.open", () => {
  it("keeps the real path of an existing folder and reports the git version", async () => {
    setTestGit();
    const { client } = newHarness().open(1);
    const link = fx.outsidePath("root-link");
    symlinkSync(fx.root, link);
    const opened = await openAt(client, link);
    expect(opened).toMatchObject({ ok: true, value: { gitVersion: testGitVersion() } });
    const started = await client.call<ScanStarted>("scan.start", { requestId: "s1" });
    expect(started).toMatchObject({ ok: true, value: { scanRoot: fx.root, depthLimit: 7 } });
    await client.waitForEvent("scan.done");
  });

  it("refuses a relative path, a missing folder and a file", async () => {
    setTestGit();
    const { client } = newHarness().open(1);
    const file = fx.outsidePath("plain.txt");
    writeFileSync(file, "x");
    for (const scanRoot of ["relative/path", fx.path("missing"), file]) {
      expect(await openAt(client, scanRoot)).toMatchObject({
        ok: false,
        error: { code: "invalidRequest" },
      });
    }
  });

  it("names why a folder cannot be scanned in detail.scanRoot", async () => {
    setTestGit();
    const { client } = newHarness().open(1);
    const file = fx.outsidePath("not-a-folder.txt");
    writeFileSync(file, "x");
    expect(await openAt(client, fx.path("missing"))).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", detail: { scanRoot: "missing" } },
    });
    expect(await openAt(client, file)).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", detail: { scanRoot: "notAFolder" } },
    });
  });

  it("refuses an unreadable folder rather than scanning it as empty", async () => {
    setTestGit();
    const { client } = newHarness().open(1);
    const locked = fx.outsidePath("locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(await openAt(client, locked)).toMatchObject({
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Treepeek is not allowed to read this folder.",
          detail: { scanRoot: "unreadable" },
        },
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("refuses a rescan once the folder has become unreadable", async () => {
    setTestGit();
    const { client } = newHarness().open(1);
    const folder = fx.outsidePath("becomes-locked");
    mkdirSync(folder);
    expect(await openAt(client, folder)).toMatchObject({ ok: true });
    chmodSync(folder, 0o000);
    try {
      expect(await client.call("scan.start", { requestId: "s1" })).toMatchObject({
        ok: false,
        error: { code: "invalidRequest", detail: { scanRoot: "unreadable" } },
      });
    } finally {
      chmodSync(folder, 0o755);
    }
  });

  it("fails gitNotFound or gitTooOld while no usable git is found", async () => {
    const { client } = newHarness().open(1);
    resetGitRuntime();
    setGitBinary({ found: false, problem: "notFound" }, {});
    expect(await openAt(client, fx.root)).toMatchObject({
      ok: false,
      error: { code: "gitNotFound" },
    });
    setGitBinary({ found: false, problem: "tooOld", detail: "git 2.30.0" }, {});
    expect(await openAt(client, fx.root)).toMatchObject({
      ok: false,
      error: { code: "gitTooOld" },
    });
  });
});

describe("scan.start", () => {
  it("needs session.open first", async () => {
    setTestGit();
    const { client } = newHarness().open(1);
    expect(await client.call("scan.start", { requestId: "s1" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("answers with the folder tree, then streams each checkout, then scan.done", async () => {
    setTestGit();
    const { client } = newHarness().open(1);
    await openAt(client, fx.root);
    const started = await client.call<ScanStarted>("scan.start", { requestId: "s1" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.folders.map((folder) => folder.relativePath)).toEqual([
      "",
      "app",
      "lib",
      "work",
      "work/a",
      "work/b",
    ]);
    await client.waitForEvent("scan.done");

    const order = client.arrivals
      .filter((arrival) => arrival.kind === "event" || arrival.id === 2)
      .map((arrival) => (arrival.kind === "result" ? "result" : arrival.channel));
    expect(order).toEqual([
      "result",
      "scan.checkout",
      "scan.checkout",
      "scan.checkout",
      "scan.checkout",
      "scan.done",
    ]);
    const checkouts = client.events<Checkout>("scan.checkout").map((item) => item.path);
    expect(new Set(checkouts)).toEqual(
      new Set([fx.path("app"), fx.path("work/a"), fx.path("work/b"), fx.path("lib")]),
    );
    const [done] = client.events<ScanDone>("scan.done");
    expect(done?.timeline.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    expect(done?.repositories.map((repo) => repo.displayName)).toEqual(["app", "lib"]);
    expect(done?.problems).toEqual([]);
    expect(done?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stops on request.cancel: no scan.done, and no git process left running", async () => {
    setFakeGit(slowGit(fx.outsidePath("slow-git-cancel.sh"), 0.4));
    const { client } = newHarness().open(1);
    await openAt(client, fx.root);
    const watch = spawned();
    try {
      expect(await client.call("scan.start", { requestId: "s1" })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(watch.pids.length).toBeGreaterThan(0));
      expect(await client.call("request.cancel", { requestId: "s1" })).toEqual({
        ok: true,
        value: {},
      });
      await vi.waitFor(() => expect(watch.pids.filter(isAlive)).toEqual([]), { timeout: 3_000 });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(client.events("scan.done")).toEqual([]);
      expect(client.events("scan.checkout")).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it("stops the running scan when another starts, and finishes only the newer one", async () => {
    setFakeGit(slowGit(fx.outsidePath("slow-git-restart.sh"), 0.2));
    const { client } = newHarness().open(1);
    await openAt(client, fx.root);
    expect(await client.call("scan.start", { requestId: "s1" })).toMatchObject({ ok: true });
    expect(await client.call("scan.start", { requestId: "s2" })).toMatchObject({ ok: true });
    await client.waitForEvent("scan.done");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(client.events("scan.done")).toHaveLength(1);
    expect(
      client
        .events<Checkout>("scan.checkout")
        .map((item) => item.path)
        .sort(),
    ).toEqual([fx.path("app"), fx.path("lib"), fx.path("work/a"), fx.path("work/b")].sort());
  });

  it("stops when the session closes, killing its git processes and releasing its state", async () => {
    setFakeGit(slowGit(fx.outsidePath("slow-git-close.sh"), 0.4));
    const created = newHarness();
    const { client } = created.open(1);
    await openAt(client, fx.root);
    const watch = spawned();
    try {
      expect(await client.call("scan.start", { requestId: "s1" })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(watch.pids.length).toBeGreaterThan(0));
      created.registry.close(1);
      await vi.waitFor(() => expect(watch.pids.filter(isAlive)).toEqual([]), { timeout: 3_000 });
      expect(created.state.size).toEqual({ repositories: 0, checkouts: 0 });
      expect(client.events("scan.done")).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
