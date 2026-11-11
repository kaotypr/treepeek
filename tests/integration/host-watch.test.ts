/**
 * Live refresh fed by a host's watcher: the core service in plain Node with a backend
 * shaped like the editor extension's (`tests/support/host-backend.ts`), which watches git
 * dirs without recursion, on real repositories. The core asks it only for narrow targets,
 * and still refreshes the right checkout after each change.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CoreService, createCoreService } from "../../src/core/service";
import { isWithin } from "../../src/core/sessions/path-rule";
import type { CoreEvents } from "../../src/shared/ipc";
import type { EventPayload } from "../../src/shared/ipc/define";
import { resetGitRuntime } from "../support/core-git";
import { adapt, type Client, client } from "../support/core-session";
import { testGitPath } from "../support/git";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../support/git-fixture";
import { HostBackend } from "../support/host-backend";

type RefreshCheckout = EventPayload<CoreEvents["refresh.checkout"]>;
type RefreshPaused = EventPayload<CoreEvents["refresh.paused"]>;

let fx: Fixture;
let repo: FixtureRepo;
let wtA: FixtureCheckout;
let wtB: FixtureCheckout;
let common: string;
let gitA: string;
let gitB: string;
let host: HostBackend;
let service: CoreService | null;
let port: MessagePort | null;
let dataDir: string;

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  fx = fixture();
  repo = fx.repo("app").commit({ "a.txt": "a\n", "b.txt": "b\n" });
  // Branch names with `/`: their folders exist before the scan, so a recursive watch of
  // `refs/` has them from the start on every platform.
  wtA = repo.worktree("wt-a", { from: "main", branch: "feature/a" }).commit({ "one.txt": "1\n" });
  wtB = repo.worktree("wt-b", { from: "main", branch: "agent/b" });
  common = repo.commonDir;
  gitA = join(common, "worktrees/wt-a");
  gitB = join(common, "worktrees/wt-b");
  host = new HostBackend();
  service = null;
  port = null;
  dataDir = mkdtempSync(join(tmpdir(), "treepeek-host-watch-"));
});

afterEach(async () => {
  // Every watcher stops before the folders it watches are deleted.
  await service?.dispose();
  port?.close();
  fx.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetGitRuntime();
});

/** Starts the service with the host backend, opens a session on the fixture and scans. */
async function watching(): Promise<Client> {
  service = createCoreService({
    dataDir,
    logSink: () => undefined,
    gitPathOverride: testGitPath(),
    loginPath: null,
    watchBackends: [host],
    onGitState: () => undefined,
  });
  const channel = new MessageChannel();
  port = channel.port2;
  service.attachSession(1, adapt(channel.port1));
  const renderer = client(channel.port2);
  expect(await renderer.call("session.open", { scanRoots: [fx.root] })).toMatchObject({
    ok: true,
  });
  expect(await renderer.call("scan.start", { requestId: "scan-1" })).toMatchObject({ ok: true });
  await renderer.waitForEvent("scan.done");
  // Sent once the scan's folders are watched.
  await renderer.waitForEvent("refresh.paused");
  return renderer;
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

function nextRefresh(
  renderer: Client,
  from: number,
  match: (payload: RefreshCheckout) => boolean,
  what: string,
): Promise<RefreshCheckout> {
  return until(
    () => renderer.events<RefreshCheckout>("refresh.checkout").slice(from).find(match),
    what,
  );
}

function seen(renderer: Client): number {
  return renderer.events("refresh.checkout").length;
}

function watched(path: string): true | undefined {
  return host.open().some((subscription) => subscription.path === path) ? true : undefined;
}

describe("live refresh fed by a host's backend", () => {
  it("asks for no recursive watch of a common dir, only of its refs/", async () => {
    await watching();
    const open = host.open();
    const recursive = open.filter((item) => item.recursive).map((item) => item.path);
    const flat = open.filter((item) => !item.recursive).map((item) => item.path);
    expect(recursive.filter((path) => isWithin(path, common))).toEqual([`${common}/refs`]);
    expect(recursive.sort()).toEqual(
      [fx.root, `${common}/refs`, repo.path, wtA.path, wtB.path].sort(),
    );
    expect(flat.sort()).toEqual(
      [
        common,
        `${common}/logs`,
        `${common}/worktrees`,
        gitA,
        `${gitA}/logs`,
        gitB,
        `${gitB}/logs`,
      ].sort(),
    );
    expect(host.refused).toEqual([]);
  });

  it("refreshes the right checkout after a commit, a git add and a branch rename", async () => {
    const renderer = await watching();

    let from = seen(renderer);
    wtB.commit({ "two.txt": "2\n" });
    const head = wtB.head();
    const committed = await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtB.path && p.checkout.head === head,
      "the commit in wt-b",
    );
    expect(committed.changed).toContain("head");

    wtA.write({ "staged.txt": "new\n" });
    await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.working.untracked === 1,
      "the new file in wt-a",
    );
    from = seen(renderer);
    wtA.stage(["staged.txt"]);
    const staged = await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.working.staged === 1,
      "the git add in wt-a",
    );
    expect(staged.changed).toContain("index");

    from = seen(renderer);
    // Renamed from the main checkout: the ref moves, and Git rewrites wt-a's HEAD to follow
    // it, which only wt-a's own git-dir watch sees.
    repo.git(["branch", "-m", "feature/a", "feature/b"]);
    await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtA.path && p.checkout.branch === "feature/b",
      "the branch rename",
    );
    await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtA.path && p.changed.includes("head"),
      "wt-a's HEAD following the rename",
    );
    expect(
      renderer
        .events<RefreshCheckout>("refresh.checkout")
        .slice(from)
        .filter((p) => p.checkoutPath !== wtA.path)
        .every((p) => !p.changed.includes("head")),
    ).toBe(true);
  });

  it("refreshes a worktree whose nested branch moved from outside it", async () => {
    const renderer = await watching();
    const from = seen(renderer);
    // Only `refs/heads/agent/b` (and its reflog) changes: nothing in wt-b's own git dir.
    repo.git(["update-ref", "refs/heads/agent/b", wtA.head()]);
    const moved = await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtB.path && p.checkout.head === wtA.head(),
      "the ref update",
    );
    expect(moved.changed).toEqual(expect.arrayContaining(["head", "refs"]));
  });

  it("adds worktrees inside and outside the root, and a repository's first one", async () => {
    const solo = fx.repo("solo").commit({ "s.txt": "s\n" });
    const soloWorktrees = `${solo.commonDir}/worktrees`;
    const renderer = await watching();
    // A repository without linked worktrees has no worktrees/ yet: absent, not paused.
    expect(host.refused).toContain(soloWorktrees);
    expect(renderer.events<RefreshPaused>("refresh.paused").at(-1)?.paused).toEqual([]);

    let from = seen(renderer);
    const wtC = repo.worktree("wt-c", { from: "main" });
    const added = await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtC.path,
      "the worktree added under the root",
    );
    expect(added.changed).toEqual(["structure"]);
    await until(() => watched(join(common, "worktrees/wt-c")), "wt-c's git dir watched");

    from = seen(renderer);
    const outside = repo.outsideWorktree("agents/wt-out", { from: "main" });
    const appeared = await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === outside.path,
      "the worktree added outside the root",
    );
    expect(appeared.changed).toEqual(["structure"]);
    expect(appeared.checkout.location).toBe("outside");
    await until(() => watched(outside.path), "the outside worktree watched");

    // Outside the root, only the repository's own watch can see this one come.
    from = seen(renderer);
    const first = solo.outsideWorktree("agents/solo-wt", { from: "main" });
    const soloAdded = await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === first.path,
      "solo's first worktree",
    );
    expect(soloAdded.changed).toEqual(["structure"]);
    // Its worktrees/ is there now, and watched from the scan that found the worktree.
    await until(() => watched(soloWorktrees), "solo's worktrees/ watched");
    expect(renderer.events<RefreshPaused>("refresh.paused").at(-1)?.paused).toEqual([]);
  });

  it("re-reads a worktree whose git dir lost events", async () => {
    const renderer = await watching();
    const from = seen(renderer);
    host.muted.add(gitA);
    // Only wt-a's index changes: the file leaves the index and stays on disk.
    wtA.git(["rm", "--cached", "--quiet", "one.txt"]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(renderer.events<RefreshCheckout>("refresh.checkout").slice(from)).toEqual([]);

    host.muted.delete(gitA);
    host.lose(gitA);
    const reread = await nextRefresh(
      renderer,
      from,
      (p) => p.checkoutPath === wtA.path,
      "wt-a read again",
    );
    expect(reread.checkout.working).toEqual({ staged: 1, unstaged: 0, untracked: 1 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      renderer
        .events<RefreshCheckout>("refresh.checkout")
        .slice(from)
        .map((p) => p.checkoutPath),
    ).toEqual([wtA.path]);
  });
});
