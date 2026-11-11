import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireFileLock,
  LOCK_STALE_MS,
  LOCK_UNOWNED_STALE_MS,
} from "../../../../src/core/store/file-lock";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-lock-"));
  path = join(dir, "doc.json.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid no process has: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("no child pid");
  return child.pid;
}

function writeLock(pid: number, nonce: string): void {
  writeFileSync(path, JSON.stringify({ pid, nonce, time: new Date().toISOString() }));
}

function ageBy(ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

describe("acquireFileLock", () => {
  it("creates the lock with this process's pid, and release removes it", () => {
    const lock = acquireFileLock(path);
    expect(lock).not.toBeNull();
    expect(lock?.brokeStale).toBe(false);
    const holder = JSON.parse(readFileSync(path, "utf8"));
    expect(holder.pid).toBe(process.pid);
    expect(holder.nonce).toMatch(/^[0-9a-f]{16}$/);
    lock?.release();
    expect(existsSync(path)).toBe(false);
    // Releasing twice is harmless, and the lock can be taken again.
    lock?.release();
    const again = acquireFileLock(path);
    expect(again).not.toBeNull();
    again?.release();
  });

  it("makes a second taker wait, and gives up after the timeout", () => {
    const first = acquireFileLock(path);
    const startedAt = Date.now();
    const second = acquireFileLock(path, { timeoutMs: 150 });
    expect(second).toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    // The first holder's lock is untouched.
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    first?.release();
  });

  it("takes the lock once another process releases it", async () => {
    const script = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify({ pid: process.pid, nonce: "child" }), { flag: "wx" });
      process.stdout.write("held\\n");
      setTimeout(() => fs.rmSync(${JSON.stringify(path)}), 300);
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const startedAt = Date.now();
    const lock = acquireFileLock(path, { timeoutMs: 5_000 });
    const waited = Date.now() - startedAt;
    expect(lock).not.toBeNull();
    expect(lock?.brokeStale).toBe(false);
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(4_000);
    lock?.release();
    await exited;
  });

  it("breaks a lock whose holder is dead", () => {
    writeLock(deadPid(), "dead");
    const startedAt = Date.now();
    const lock = acquireFileLock(path, { timeoutMs: 2_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(lock?.brokeStale).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    lock?.release();
    // Breaking leaves nothing behind.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("breaks a lock older than the stale age even when its holder lives", () => {
    writeLock(process.pid, "stuck");
    ageBy(LOCK_STALE_MS + 5_000);
    const lock = acquireFileLock(path, { timeoutMs: 2_000 });
    expect(lock?.brokeStale).toBe(true);
    lock?.release();
  });

  it("waits for a fresh lock whose holder lives", () => {
    writeLock(process.pid, "busy");
    expect(acquireFileLock(path, { timeoutMs: 50 })).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe("busy");
  });

  it("breaks a lock with no readable holder only once it is a few seconds old", () => {
    writeFileSync(path, "");
    expect(acquireFileLock(path, { timeoutMs: 50 })).toBeNull();
    ageBy(LOCK_UNOWNED_STALE_MS + 1_000);
    const lock = acquireFileLock(path, { timeoutMs: 50 });
    expect(lock?.brokeStale).toBe(true);
    lock?.release();
  });

  it("never removes a lock another holder took after this one was broken", () => {
    const lock = acquireFileLock(path);
    // As if this holder had stalled, its lock was broken and another process took it.
    rmSync(path);
    writeLock(process.pid, "next-holder");
    lock?.release();
    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe("next-holder");
  });
});
