import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BATCH_IDLE_MS, BatchProcess } from "../../../../src/core/git/batch-process";
import { GitError } from "../../../../src/core/git/errors";
import { observeSpawns, spawnCount } from "../../../../src/core/git/process";
import { gitQueue } from "../../../../src/core/git/run";
import { resetGitRuntime, setFakeGit } from "../../../support/core-git";

let scripts: string;
let marker: string;

/**
 * A fake git that echoes each line back, except `hang …`, which it records in `marker`
 * and then never answers.
 */
function echoGit(): string {
  const file = join(scripts, "echo-git.sh");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'while IFS= read -r line; do case "$line" in',
      `hang*) printf '%s\\n' "$line" >> '${marker}'; sleep 30 ;;`,
      `*) printf '%s\\n' "$line" ;;`,
      "esac; done",
    ].join("\n"),
    { mode: 0o755 },
  );
  return file;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!condition()) throw new Error("not yet");
  }, 5_000);
}

/**
 * Counts the batch processes started until `stop()`. Every request first makes sure the
 * folder's config overrides are current, which here (not a repository) means listing the
 * config again; those short-lived listings are not batch processes.
 */
function countBatchSpawns(): { count(): number; stop(): void } {
  let spawned = 0;
  const stop = observeSpawns((event) => {
    if (event.type === "spawn" && event.args.includes("--batch-command")) spawned += 1;
  });
  return { count: () => spawned, stop };
}

/** Sends `line` and returns the line read back. */
function echo(batch: BatchProcess, line: string, signal = new AbortController().signal) {
  return batch.request(
    async (io) => {
      io.write(`${line}\n`);
      return (await io.readLine()).toString("utf8");
    },
    { signal },
  );
}

const batches: BatchProcess[] = [];
function batch(options: { idleMs?: number; timeoutMs?: number } = {}): BatchProcess {
  const created = new BatchProcess({
    cwd: scripts,
    args: ["cat-file", "--batch-command"],
    ...options,
  });
  batches.push(created);
  return created;
}

beforeAll(() => {
  scripts = mkdtempSync(join(tmpdir(), "treepeek-batch-"));
  marker = join(scripts, "received.log");
});
afterEach(() => {
  for (const created of batches.splice(0)) created.close();
  rmSync(marker, { force: true });
  vi.useRealTimers();
  resetGitRuntime();
});
afterAll(() => {
  rmSync(scripts, { recursive: true, force: true });
});

describe("BatchProcess", () => {
  it("refuses a command the guard refuses before starting anything", () => {
    const before = spawnCount();
    expect(
      () => new BatchProcess({ cwd: scripts, args: ["hash-object", "-w", "--stdin-paths"] }),
    ).toThrow(GitError);
    expect(spawnCount()).toBe(before);
  });

  it("starts on the first request and serves every later one from the same process", async () => {
    setFakeGit(echoGit());
    const echoer = batch();
    expect(echoer.pid).toBeNull();
    const spawns = countBatchSpawns();
    try {
      for (let index = 0; index < 50; index += 1) {
        expect(await echo(echoer, `line ${index}`)).toBe(`line ${index}`);
      }
    } finally {
      spawns.stop();
    }
    expect(spawns.count()).toBe(1);
    expect(echoer.pid).not.toBeNull();
  });

  it("runs requests one at a time, in the order they were made", async () => {
    setFakeGit(echoGit());
    const echoer = batch();
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, index) => echo(echoer, `r${index}`)),
    );
    expect(answers).toEqual(Array.from({ length: 20 }, (_, index) => `r${index}`));
  });

  it("kills the process when a running request is aborted, and restarts for the next", async () => {
    setFakeGit(echoGit());
    const echoer = batch();
    await echo(echoer, "warm up");
    const pid = echoer.pid ?? -1;
    const controller = new AbortController();
    const hanging = echo(echoer, "hang please", controller.signal);
    await waitUntil(() => existsSync(marker));
    controller.abort();
    await expect(hanging).rejects.toMatchObject({ code: "cancelled" });
    await waitUntil(() => !isAlive(pid));
    const spawns = countBatchSpawns();
    try {
      expect(await echo(echoer, "after")).toBe("after");
    } finally {
      spawns.stop();
    }
    expect(spawns.count()).toBe(1);
    expect(echoer.pid).not.toBe(pid);
  });

  it("drops a waiting request on abort without touching the running one", async () => {
    setFakeGit(echoGit());
    const echoer = batch();
    const controller = new AbortController();
    const first = echoer.request(
      async (io) => {
        io.write("one\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        return (await io.readLine()).toString("utf8");
      },
      { signal: new AbortController().signal },
    );
    const second = echo(echoer, "two", controller.signal);
    const third = echo(echoer, "three");
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: "cancelled" });
    expect(await first).toBe("one");
    expect(await third).toBe("three");
  });

  it("times out a request that gets no answer and kills the process", async () => {
    setFakeGit(echoGit());
    const echoer = batch({ timeoutMs: 200 });
    const hanging = echo(echoer, "hang now");
    await waitUntil(() => echoer.pid !== null);
    const pid = echoer.pid ?? -1;
    await expect(hanging).rejects.toMatchObject({ code: "timeout" });
    await waitUntil(() => !isAlive(pid));
  });

  it("fails the request in flight when the process dies, then starts a new one", async () => {
    setFakeGit(echoGit());
    const echoer = batch();
    const hanging = echo(echoer, "hang until killed");
    await waitUntil(() => existsSync(marker));
    const pid = echoer.pid ?? -1;
    process.kill(-pid, "SIGKILL");
    await expect(hanging).rejects.toBeInstanceOf(GitError);
    const spawns = countBatchSpawns();
    try {
      expect(await echo(echoer, "again")).toBe("again");
    } finally {
      spawns.stop();
    }
    expect(spawns.count()).toBe(1);
  });

  it("closes after BATCH_IDLE_MS without requests (fake timers)", async () => {
    expect(BATCH_IDLE_MS).toBe(60_000);
    setFakeGit(echoGit());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const echoer = batch();
    await echo(echoer, "hello");
    const pid = echoer.pid ?? -1;
    vi.advanceTimersByTime(BATCH_IDLE_MS - 1);
    expect(echoer.pid).toBe(pid);
    expect(isAlive(pid)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(echoer.pid).toBeNull();
    await waitUntil(() => !isAlive(pid));
    // The next request starts a new process.
    expect(await echo(echoer, "back")).toBe("back");
    expect(echoer.pid).not.toBe(pid);
  });

  it("a request restarts the idle clock", async () => {
    setFakeGit(echoGit());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const echoer = batch();
    await echo(echoer, "one");
    const pid = echoer.pid;
    vi.advanceTimersByTime(BATCH_IDLE_MS - 10);
    await echo(echoer, "two");
    vi.advanceTimersByTime(BATCH_IDLE_MS - 10);
    expect(echoer.pid).toBe(pid);
  });

  it("close() kills the process and refuses later requests", async () => {
    setFakeGit(echoGit());
    const echoer = batch();
    await echo(echoer, "x");
    const pid = echoer.pid ?? -1;
    echoer.close();
    await waitUntil(() => !isAlive(pid));
    await expect(echo(echoer, "y")).rejects.toMatchObject({ code: "cancelled" });
  });

  it("holds a git-queue slot only while a request runs", async () => {
    setFakeGit(echoGit());
    const echoer = batch();
    let activeDuring = -1;
    await echoer.request(
      async (io) => {
        activeDuring = gitQueue().active;
        io.write("q\n");
        return io.readLine();
      },
      { signal: new AbortController().signal },
    );
    expect(activeDuring).toBeGreaterThanOrEqual(1);
    expect(gitQueue().active).toBe(0);
    expect(echoer.pid).not.toBeNull();
  });

  it("reports each process to observeSpawns, including its exit", async () => {
    setFakeGit(echoGit());
    const events: { type: string; pid: number }[] = [];
    const stop = observeSpawns((event) => events.push({ type: event.type, pid: event.pid }));
    let pid = -1;
    try {
      const echoer = batch();
      await echo(echoer, "seen");
      pid = echoer.pid ?? -1;
      echoer.close();
      await waitUntil(() => events.some((event) => event.type === "exit" && event.pid === pid));
    } finally {
      stop();
    }
    // Other tests' processes may exit meanwhile; only this one's events count.
    expect(events.filter((event) => event.pid === pid).map((event) => event.type)).toEqual([
      "spawn",
      "exit",
    ]);
  });
});
