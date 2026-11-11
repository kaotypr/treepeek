/**
 * The host-free core service in plain Node: no Electron, no process handlers, no
 * `process.exit`, and nothing left running once it is disposed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import * as v from "valibot";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { observeSpawns } from "../../../src/core/git/process";
import { createCoreService } from "../../../src/core/service";
import type { BackendName, WatchBackend } from "../../../src/core/watch/backends";
import type { WatchTarget } from "../../../src/core/watch/targets";
import type { GitState } from "../../../src/shared/domain/git";
import { coreCalls } from "../../../src/shared/ipc";
import { resetGitRuntime } from "../../support/core-git";
import { adapt, client } from "../../support/core-session";
import { testGitPath } from "../../support/git";
import { type Fixture, type FixtureCheckout, fixture } from "../../support/git-fixture";

/** An in-memory backend: records every subscription and whether it was closed. */
class FakeBackend implements WatchBackend {
  readonly name: BackendName = "fs.watch";
  readonly subscriptions: { target: WatchTarget; closed: boolean }[] = [];

  async subscribe(target: WatchTarget) {
    const subscription = { target, closed: false };
    this.subscriptions.push(subscription);
    return {
      close: async () => {
        subscription.closed = true;
      },
    };
  }
}

let fx: Fixture;
let worktree: FixtureCheckout;
const dataDirs: string[] = [];
const cleanups: (() => void)[] = [];

beforeAll(() => {
  fx = fixture();
  const app = fx.repo("app").commit({ "a.txt": "1\n" });
  worktree = app.worktree("work/a", { from: "main" }).commit({ "a.txt": "1\nmore\n" });
});
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetGitRuntime();
});
afterAll(() => {
  fx.cleanup();
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "treepeek-service-"));
  dataDirs.push(dir);
  return dir;
}

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(
    process.eventNames().map((name) => [String(name), process.listenerCount(name)]),
  );
}

/** The git processes started from now on that are still running, by pid. */
function runningGit(): Map<number, string> {
  const running = new Map<number, string>();
  cleanups.push(
    observeSpawns((event) => {
      if (event.type === "spawn") running.set(event.pid, event.args.join(" "));
      else running.delete(event.pid);
    }),
  );
  return running;
}

/** How many active resources (handles and requests) of each kind keep the process alive. */
function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/** The kinds of resource there are more of now than in `before`, with how many more. */
function leftOver(before: Record<string, number>): Record<string, number> {
  const extra: Record<string, number> = {};
  for (const [kind, count] of Object.entries(activeResources())) {
    if (count > (before[kind] ?? 0)) extra[kind] = count - (before[kind] ?? 0);
  }
  return extra;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function newService(backend: FakeBackend, lines: string[], states: GitState[]) {
  return createCoreService({
    dataDir: dataDir(),
    logSink: (line) => lines.push(line),
    gitPathOverride: testGitPath(),
    loginPath: null,
    watchBackends: [backend],
    onGitState: (state) => states.push(state),
  });
}

describe("createCoreService", () => {
  it("serves a session in plain Node and leaves nothing behind once disposed", async () => {
    const listenersBefore = listenerCounts();
    const resourcesBefore = activeResources();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

    const running = runningGit();
    const backend = new FakeBackend();
    const lines: string[] = [];
    const states: GitState[] = [];
    const service = newService(backend, lines, states);

    const { port1, port2 } = new MessageChannel();
    service.attachSession(1, adapt(port1));
    const renderer = client(port2);

    expect(await renderer.call("session.open", { scanRoot: fx.root })).toMatchObject({
      ok: true,
    });
    expect(await renderer.call("scan.start", { requestId: "scan-1" })).toMatchObject({
      ok: true,
    });
    await renderer.waitForEvent("scan.done");
    const diff = await renderer.call("diff.file", {
      requestId: "diff-1",
      checkoutPath: worktree.path,
      comparison: { kind: "review" },
      path: "a.txt",
    });
    expect(diff).toMatchObject({
      ok: true,
      value: { path: "a.txt", status: "modified", left: "1\n", right: "1\nmore\n" },
    });

    const info = await renderer.call("app.info", {});
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    expect(v.safeParse(coreCalls["app.info"].response, info.value).success).toBe(true);
    const value = v.parse(coreCalls["app.info"].response, info.value);
    expect(value.versions.node).toBe(process.versions.node);
    expect("electron" in value.versions).toBe(false);

    expect(states).toEqual([expect.objectContaining({ found: true })]);
    expect(lines.some((line) => line.includes("[core:service] core service started"))).toBe(true);
    // The scan's checkouts are watched through the backend the host passed in.
    await until(() => backend.subscriptions.length > 0);
    expect(backend.subscriptions.length).toBeGreaterThan(0);

    // The diff read the old side through a long-lived `git cat-file`, still running here.
    expect([...running.values()].some((args) => args.includes("cat-file --batch"))).toBe(true);

    await service.dispose();
    port2.close();

    expect(backend.subscriptions.every((subscription) => subscription.closed)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(listenerCounts()).toEqual(listenersBefore);
    // `git cat-file` and the like are stopped on dispose; give them time to exit. Those
    // processes are unref'd, so `getActiveResourcesInfo` does not list them: they are
    // checked by pid. The test runner's own timers come and go, so only resources beyond
    // the baseline count.
    await until(() => running.size === 0);
    expect([...running.values()]).toEqual([]);
    await until(() => Object.keys(leftOver(resourcesBefore)).length === 0);
    expect(leftOver(resourcesBefore)).toEqual({});
  });

  it("closes a port attached after dispose, and calls back no more", async () => {
    const lines: string[] = [];
    const states: GitState[] = [];
    const service = newService(new FakeBackend(), lines, states);
    await service.dispose();

    const { port1, port2 } = new MessageChannel();
    const closed = new Promise<void>((resolve) => port2.once("close", () => resolve()));
    service.attachSession(1, adapt(port1));
    await closed;

    service.setGitPath(testGitPath());
    expect(await service.validatePaths([fx.root])).toEqual([false]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(states).toEqual([]);
  });

  it("closes only the session a handle attached", async () => {
    const service = newService(new FakeBackend(), [], []);
    const first = new MessageChannel();
    const second = new MessageChannel();
    const older = service.attachSession(7, adapt(first.port1));
    service.attachSession(7, adapt(second.port1));
    const renderer = client(second.port2);

    // The first window's port closing late must not close the session that replaced it.
    older.close();
    expect(await renderer.call("session.open", { scanRoot: fx.root })).toMatchObject({
      ok: true,
    });

    await service.dispose();
    first.port2.close();
    second.port2.close();
  });
});
