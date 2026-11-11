import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_TIMEOUT_MS } from "../../../../src/core/store/file-lock";
import { worktreeId } from "../../../../src/core/store/identity";
import { JsonReviewStore, repositoryFileName } from "../../../../src/core/store/json-store";
import type { MarkInput, WorktreeRow } from "../../../../src/core/store/review-store";
import { SNAPSHOT_FOLDER } from "../../../../src/core/store/snapshots";
import type { Logger } from "../../../../src/shared/log";

/**
 * The JSON store shared by real processes. Children load the store's TypeScript with
 * Node's own type stripping and a resolve hook (`tests/support/json-store-child.ts`),
 * which needs Node 22.18 or later; CI runs Node 24.
 */
const canFork =
  typeof nodeModule.registerHooks === "function" && Boolean(process.features.typescript);

const CHILD = join(import.meta.dirname, "../../../support/json-store-child.ts");
const COMMON = "/repos/app/.git";
const FILE = repositoryFileName(COMMON);

const row: WorktreeRow = {
  worktreeId: worktreeId(COMMON, "/repos/app", "a".repeat(40)),
  commonDir: COMMON,
  checkoutPath: "/repos/app",
  startCommit: "a".repeat(40),
  startObservedAt: "2025-01-01T00:00:00Z",
  firstSeenAt: "2025-02-01T00:00:00Z",
  lastSeenAt: "2025-02-01T00:00:00Z",
};
const W = row.worktreeId;

const mark = (path: string): MarkInput => ({
  path,
  resultHash: "d".repeat(40),
  viewedAt: "2025-07-01T00:00:00Z",
  snapshotHash: null,
});

function silentLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger & { warnings: string[] } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
    child: () => log,
  };
  return log;
}

/** A child process writing the store, and the messages it sent. */
interface Child {
  process: ChildProcess;
  messages: Record<string, unknown>[];
  /** Resolves once a message passes `test`; rejects if the child exits first. */
  until(test: (message: Record<string, unknown>) => boolean): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let dir: string;
let children: ChildProcess[];

function start(args: string[]): Child {
  const child = fork(CHILD, args, { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
  children.push(child);
  const messages: Record<string, unknown>[] = [];
  const waiting = new Set<() => void>();
  child.on("message", (message) => {
    if (typeof message === "object" && message !== null) {
      messages.push(message as Record<string, unknown>);
    }
    for (const check of waiting) check();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return {
    process: child,
    messages,
    exited,
    until(test) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!messages.some(test)) return;
          waiting.delete(check);
          resolve();
        };
        waiting.add(check);
        check();
        void exited.then(({ code, signal }) => {
          if (!waiting.has(check)) return;
          waiting.delete(check);
          reject(new Error(`the child exited (${code ?? signal}) before the awaited message`));
        });
      });
    },
  };
}

/** Records the worktree (and `seed` marks) so every child finds it when it opens. */
function seed(paths: string[] = []): void {
  const store = new JsonReviewStore(dir);
  store.upsertWorktree(row);
  if (paths.length > 0) store.setMarks(W, paths.map(mark));
  store.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-processes-"));
  children = [];
});
afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(canFork)("the JSON store shared by real processes", () => {
  it("keeps every mark when several processes write at once", async () => {
    seed();
    const writers = ["one", "two", "three", "four"].map((label) =>
      start(["marks", dir, W, label, "50"]),
    );
    await Promise.all(writers.map((child) => child.until((message) => message.ready === true)));
    for (const child of writers) child.process.send("go");
    await Promise.all(writers.map((child) => child.until((message) => message.done === 50)));
    for (const child of writers) expect((await child.exited).code).toBe(0);

    const saved = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    const paths = Object.keys(saved.marks[W]).sort();
    expect(paths).toHaveLength(200);
    for (const label of ["one", "two", "three", "four"]) {
      for (let index = 0; index < 50; index += 1) expect(paths).toContain(`${label}/${index}.txt`);
    }
    const store = new JsonReviewStore(dir);
    expect(store.getMarks(W)).toHaveLength(200);
    store.close();
    expect(readdirSync(dir).sort()).toEqual([FILE, SNAPSHOT_FOLDER].sort());
  }, 60_000);

  it("survives a writer killed at any point of a write, again and again", async () => {
    // A large document, so a write takes long enough for a kill to land inside one.
    seed(Array.from({ length: 3_000 }, (_, index) => `seed/${index}.txt`));
    for (let round = 0; round < 4; round += 1) {
      const label = `round-${round}`;
      const child = start(["loop", dir, W, label]);
      await child.until((message) => message.ready === true);
      const killAfter = 2 + Math.floor(Math.random() * 10);
      child.process.send("go");
      await child.until((message) => message.written === killAfter - 1);
      // A kill sent right on a report lands at the child's next system call; a random wait
      // spreads the kills over every step of a write.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
      child.process.kill("SIGKILL");
      expect((await child.exited).signal).toBe("SIGKILL");
      const reported = child.messages.flatMap((message) =>
        typeof message.written === "number" ? [message.written] : [],
      );

      // The file is whole, and a new store opens it without setting anything aside.
      const saved = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
      expect(Object.keys(saved.marks[W]).length).toBeGreaterThanOrEqual(3_000);
      const log = silentLog();
      const store = new JsonReviewStore(dir, { log });
      expect(log.warnings).toEqual([]);
      expect(readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(false);
      const paths = new Set(store.getMarks(W).map((entry) => entry.path));
      for (const index of reported) expect(paths).toContain(`${label}/${index}.txt`);

      // The next write does not wait out the lock the killed writer may have left.
      const startedAt = Date.now();
      store.setMarks(W, [mark(`after-${round}.txt`)]);
      store.flush();
      expect(Date.now() - startedAt).toBeLessThan(LOCK_TIMEOUT_MS);
      store.close();
      expect(log.warnings).toEqual([]);
      const after = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
      expect(after.marks[W][`after-${round}.txt`]).toBeDefined();
      // Whatever the killed writer left half done is gone after that write.
      expect(readdirSync(dir).sort()).toEqual([FILE, SNAPSHOT_FOLDER].sort());
    }
  }, 60_000);
});
