import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pairKey, RepoCache } from "../../../../src/core/cache/repo-cache";
import { CoreState, type CoreStateFactories } from "../../../../src/core/cache/shared-state";
import { CatFileBatch } from "../../../../src/core/git/cat-file";
import { HashObjectBatch } from "../../../../src/core/git/hash-object";
import { spawnCount } from "../../../../src/core/git/process";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

let fx: Fixture;
let app: FixtureRepo;
let blob: string;
const states: CoreState[] = [];

const live = () => new AbortController().signal;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function coreState(factories?: CoreStateFactories): CoreState {
  const state = new CoreState(factories);
  states.push(state);
  return state;
}

beforeAll(() => {
  fx = fixture();
  app = fx.repo("app").commit({ "a.txt": "shared\n" });
  app.write({ "untracked.txt": "u\n" });
  blob = app.rev("HEAD:a.txt");
});
afterEach(() => {
  for (const state of states.splice(0)) state.close();
  resetGitRuntime();
});
afterAll(() => fx.cleanup());

describe("CoreState", () => {
  it("shares one repository's cache and cat-file process between two sessions until both release", async () => {
    setTestGit();
    const state = coreState();
    const first = state.acquireRepository(1, app.commonDir);
    const second = state.acquireRepository(2, app.commonDir);
    expect(second).toBe(first);
    expect(state.repositoryHolders(app.commonDir)).toBe(2);

    await first.catFile.read(blob, 1_000, { signal: live() });
    const pid = first.catFile.pid ?? -1;
    first.cache.immutable.counts.set(pairKey("a", "b"), 1);

    state.releaseRepository(1, app.commonDir);
    expect(state.repository(app.commonDir)).toBe(first);
    expect(isAlive(pid)).toBe(true);
    const before = spawnCount();
    const read = await second.catFile.read(blob, 1_000, { signal: live() });
    expect(read.size).toBe(7);
    expect(spawnCount()).toBe(before);
    expect(second.cache.immutable.counts.peek(pairKey("a", "b"))).toBe(1);

    state.releaseRepository(2, app.commonDir);
    expect(state.repository(app.commonDir)).toBeUndefined();
    expect(state.repositoryHolders(app.commonDir)).toBe(0);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
    expect(first.cache.immutable.counts.has(pairKey("a", "b"))).toBe(false);
    await expect(first.catFile.read(blob, 1_000, { signal: live() })).rejects.toMatchObject({
      code: "cancelled",
    });

    // A later session gets fresh resources.
    const later = state.acquireRepository(3, app.commonDir);
    expect(later).not.toBe(first);
  });

  it("shares one checkout's hash-object process the same way", async () => {
    setTestGit();
    const state = coreState();
    const first = state.acquireCheckout("window-1", app.path);
    expect(state.acquireCheckout("window-2", app.path)).toBe(first);
    await first.hashObject.hash(["untracked.txt"], { signal: live() });
    const pid = first.hashObject.pid ?? -1;
    expect(pid).toBeGreaterThan(0);

    state.releaseCheckout("window-1", app.path);
    expect(isAlive(pid)).toBe(true);
    expect(state.checkout(app.path)).toBe(first);

    state.releaseCheckout("window-2", app.path);
    expect(state.checkout(app.path)).toBeUndefined();
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  });

  it("counts a holder once however often it acquires", () => {
    const state = coreState();
    state.acquireRepository(1, app.commonDir);
    state.acquireRepository(1, app.commonDir);
    expect(state.repositoryHolders(app.commonDir)).toBe(1);
    state.releaseRepository(1, app.commonDir);
    expect(state.repository(app.commonDir)).toBeUndefined();
  });

  it("ignores a release by someone who never acquired", () => {
    const state = coreState();
    const held = state.acquireRepository(1, app.commonDir);
    state.releaseRepository(99, app.commonDir);
    state.releaseRepository(1, "/never/acquired");
    expect(state.repository(app.commonDir)).toBe(held);
  });

  it("releases everything a session holds when it closes, and nothing another session holds", () => {
    const closed: string[] = [];
    const state = coreState({
      repository: (commonDir) => ({
        commonDir,
        cache: new RepoCache(commonDir),
        catFile: closeRecorder(new CatFileBatch(commonDir), `repo:${commonDir}`, closed),
      }),
      checkout: (checkoutPath) => ({
        checkoutPath,
        hashObject: closeRecorder(
          new HashObjectBatch(checkoutPath),
          `checkout:${checkoutPath}`,
          closed,
        ),
      }),
    });
    state.acquireRepository(1, "/r/one.git");
    state.acquireRepository(1, "/r/two.git");
    state.acquireRepository(2, "/r/two.git");
    state.acquireCheckout(1, "/r/one");
    state.acquireCheckout(2, "/r/two");

    state.releaseHolder(1);
    expect(closed.sort()).toEqual(["checkout:/r/one", "repo:/r/one.git"]);
    expect(state.size).toEqual({ repositories: 1, checkouts: 1 });

    state.releaseHolder(2);
    expect(closed.sort()).toEqual([
      "checkout:/r/one",
      "checkout:/r/two",
      "repo:/r/one.git",
      "repo:/r/two.git",
    ]);
    expect(state.size).toEqual({ repositories: 0, checkouts: 0 });
  });

  it("close() releases everything at once", () => {
    const state = coreState();
    const repository = state.acquireRepository(1, app.commonDir);
    state.acquireCheckout(2, app.path);
    state.close();
    expect(state.size).toEqual({ repositories: 0, checkouts: 0 });
    expect(state.repository(app.commonDir)).toBeUndefined();
    expect(repository.catFile.pid).toBeNull();
  });
});

/** Wraps `close` so the test sees which resources were closed. */
function closeRecorder<T extends { close(): void }>(target: T, name: string, closed: string[]): T {
  const close = target.close.bind(target);
  target.close = () => {
    closed.push(name);
    close();
  };
  return target;
}
