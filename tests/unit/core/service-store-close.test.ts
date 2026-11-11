/**
 * Disposing the host-free core service when the store's last write fails. A JSON store
 * whose lock another process still holds throws from `close()`; `dispose()` must still
 * finish, because a host calls it while shutting down (the desktop from its `exit` handler).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService } from "../../../src/core/service";
import { worktreeId } from "../../../src/core/store/identity";
import { JsonReviewStore, repositoryFileName } from "../../../src/core/store/json-store";
import type { OpenStoreOptions } from "../../../src/core/store/open-store";
import { StoreError } from "../../../src/core/store/review-store";
import type { WatchBackend } from "../../../src/core/watch/backends";
import { testGitPath } from "../../support/git";

const opened = vi.hoisted(() => ({ stores: [] as JsonReviewStore[] }));

// The service opens its own store. This one is a JSON store whose writes give up on a busy
// lock after 50 ms instead of 5 s, so the failing close is quick.
vi.mock("../../../src/core/store/open-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/store/open-store")>();
  return {
    ...actual,
    openReviewStore: (userDataDir: string, options: OpenStoreOptions = {}) => {
      const dir = join(userDataDir, "store");
      mkdirSync(dir, { recursive: true });
      const store = new JsonReviewStore(dir, {
        lockTimeoutMs: 50,
        ...(options.log ? { log: options.log } : {}),
      });
      opened.stores.push(store);
      return store;
    },
  };
});

const COMMON = "/repos/app/.git";
const START = "a".repeat(40);

/** Watches nothing: no session in this test scans. */
const idleBackend: WatchBackend = {
  name: "fs.watch",
  subscribe: async () => ({ close: async () => {} }),
};

const dataDirs: string[] = [];
afterEach(() => {
  opened.stores.length = 0;
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createCoreService dispose", () => {
  it("finishes and logs when the store's last write fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "treepeek-service-close-"));
    dataDirs.push(dataDir);
    const lines: string[] = [];
    const service = createCoreService({
      dataDir,
      logSink: (line) => lines.push(line),
      gitPathOverride: testGitPath(),
      loginPath: null,
      watchBackends: [idleBackend],
      onGitState: () => {},
    });
    const [store] = opened.stores;
    if (!store) throw new Error("the service opened no store");

    // A scan's sighting, gathered for a later write that another process's lock now blocks.
    store.upsertWorktree({
      worktreeId: worktreeId(COMMON, "/repos/app", START),
      commonDir: COMMON,
      checkoutPath: "/repos/app",
      startCommit: START,
      startObservedAt: "2025-01-01T00:00:00Z",
      firstSeenAt: "2025-02-01T00:00:00Z",
      lastSeenAt: "2025-02-01T00:00:00Z",
    });
    writeFileSync(
      join(store.dir, `${repositoryFileName(COMMON)}.lock`),
      JSON.stringify({ pid: process.pid, nonce: "other", time: new Date().toISOString() }),
    );
    // The write the store's close will make fails as it stands.
    expect(() => store.flush()).toThrow(StoreError);

    const disposing = service.dispose();
    await expect(disposing).resolves.toBeUndefined();
    expect(lines.some((line) => line.includes("could not close the local store"))).toBe(true);
    // Disposing again answers the same promise and closes nothing twice.
    expect(service.dispose()).toBe(disposing);
    expect(lines.filter((line) => line.includes("could not close the local store"))).toHaveLength(
      1,
    );
  });
});
