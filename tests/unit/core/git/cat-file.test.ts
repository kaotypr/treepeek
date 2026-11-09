import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BATCH_IDLE_MS } from "../../../../src/core/git/batch-process";
import { CatFileBatch } from "../../../../src/core/git/cat-file";
import { observeSpawns, spawnCount } from "../../../../src/core/git/process";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { gitIn } from "../../../support/git";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

let fx: Fixture;
let app: FixtureRepo;
const blobs = new Map<string, Buffer>();
const batches: CatFileBatch[] = [];

const signal = () => new AbortController().signal;

function catFile(commonDir: string): CatFileBatch {
  const batch = new CatFileBatch(commonDir);
  batches.push(batch);
  return batch;
}

function blobOf(checkoutPath: string, path: string): string {
  return gitIn(checkoutPath, ["rev-parse", `HEAD:${path}`]).trim();
}

beforeAll(() => {
  fx = fixture();
  app = fx.repo("app");
  const files: Record<string, string | Uint8Array> = {};
  for (let index = 0; index < 40; index += 1)
    files[`f${index}.txt`] = `file ${index}\n`.repeat(index);
  files["binary.bin"] = new Uint8Array([0, 10, 13, 255, 10, 0, 10]);
  files["no-newline.txt"] = "last line";
  files["big.txt"] = "x".repeat(300_000);
  files["huge.txt"] = "0123456789abcdef".repeat(200_000);
  app.commit(files);
  for (const name of Object.keys(files)) {
    const oid = blobOf(app.path, name);
    const content = files[name] ?? "";
    blobs.set(name, Buffer.from(typeof content === "string" ? content : content));
    blobs.set(`oid:${name}`, Buffer.from(oid));
  }
});
afterEach(() => {
  for (const batch of batches.splice(0)) batch.close();
  vi.useRealTimers();
  resetGitRuntime();
});
afterAll(() => fx.cleanup());

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const oid = (name: string) => blobs.get(`oid:${name}`)?.toString() ?? "";

describe("CatFileBatch", () => {
  it("returns the right bytes for 1,000 sequential reads with one process", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    const names = Array.from({ length: 40 }, (_, index) => `f${index}.txt`);
    let spawned = 0;
    // The config listing that precedes the first start is not a cat-file process.
    const stop = observeSpawns((event) => {
      if (event.type === "spawn" && event.args.includes("cat-file")) spawned += 1;
    });
    try {
      for (let index = 0; index < 1_000; index += 1) {
        const name = names[index % names.length] ?? "";
        const read = await batch.read(oid(name), 1_000_000, { signal: signal() });
        if (read.tooLarge) throw new Error("unexpectedly too large");
        expect(read.data.equals(blobs.get(name) ?? Buffer.alloc(1))).toBe(true);
        expect(read.size).toBe(blobs.get(name)?.length);
      }
    } finally {
      stop();
    }
    expect(spawned).toBe(1);
  });

  it("reads binary content, content without a final newline and multi-chunk blobs exactly", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    for (const name of ["binary.bin", "no-newline.txt", "huge.txt", "f0.txt"]) {
      const read = await batch.read(oid(name), 10_000_000, { signal: signal() });
      if (read.tooLarge) throw new Error(`${name} unexpectedly too large`);
      expect(read.data.equals(blobs.get(name) ?? Buffer.alloc(1)), name).toBe(true);
    }
  });

  it("returns tooLarge for a blob over the cap without reading its body", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    await batch.read(oid("f1.txt"), 1_000, { signal: signal() });
    const before = batch.bytesRead;
    const read = await batch.read(oid("big.txt"), 10_000, { signal: signal() });
    expect(read).toEqual({ tooLarge: true, size: 300_000 });
    // Only the `info` header came back, not 300,000 bytes of body.
    expect(batch.bytesRead - before).toBeLessThan(200);
    // The process is still in step: the next read gets its own answer.
    const next = await batch.read(oid("f2.txt"), 1_000, { signal: signal() });
    expect(next.tooLarge).toBeUndefined();
    expect(next.size).toBe(blobs.get("f2.txt")?.length);
  });

  it("reads exactly at the cap", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    const read = await batch.read(oid("big.txt"), 300_000, { signal: signal() });
    expect(read.tooLarge).toBeUndefined();
    expect(read.size).toBe(300_000);
  });

  it("fails with refNotFound for a missing object and keeps working", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    await expect(
      batch.read("0123456789abcdef0123456789abcdef01234567", 100, { signal: signal() }),
    ).rejects.toMatchObject({ code: "refNotFound" });
    const pid = batch.pid;
    const read = await batch.read(oid("f3.txt"), 1_000, { signal: signal() });
    expect(read.size).toBe(blobs.get("f3.txt")?.length);
    // A missing object is an ordinary answer: the process was not restarted.
    expect(batch.pid).toBe(pid);
  });

  it("refuses a malformed id without running git, and a non-blob after asking", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    const before = spawnCount();
    for (const bad of ["HEAD", "abc\ninfo 1234", "-x", "", "1234 5678"]) {
      await expect(batch.read(bad, 100, { signal: signal() }), bad).rejects.toMatchObject({
        code: "internal",
      });
    }
    expect(spawnCount()).toBe(before);
    const tree = gitIn(app.path, ["rev-parse", "HEAD^{tree}"]).trim();
    await expect(batch.read(tree, 1_000_000, { signal: signal() })).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/not a blob/),
    });
  });

  it("reads through a bare repository's common dir, shared by its worktrees", async () => {
    const svc = fx.repo("svc").commit({ "x.txt": "from svc\n" }).bare();
    const worktree = svc.worktree("svc-main", { from: "main" });
    setTestGit();
    const batch = catFile(svc.commonDir);
    const read = await batch.read(blobOf(worktree.path, "x.txt"), 100, { signal: signal() });
    expect(read.tooLarge).toBeUndefined();
    if (!read.tooLarge) expect(read.data.toString()).toBe("from svc\n");
  });

  it("serves concurrent reads in order from one process", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    const names = ["f5.txt", "f6.txt", "binary.bin", "f7.txt", "no-newline.txt"];
    const reads = await Promise.all(
      names.map((name) => batch.read(oid(name), 1_000_000, { signal: signal() })),
    );
    reads.forEach((read, index) => {
      const name = names[index] ?? "";
      if (read.tooLarge) throw new Error("unexpectedly too large");
      expect(read.data.equals(blobs.get(name) ?? Buffer.alloc(1)), name).toBe(true);
    });
  });

  it("closes the process after 60 s idle (fake timers), and the next read starts another", async () => {
    setTestGit();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const batch = catFile(app.commonDir);
    await batch.read(oid("f1.txt"), 1_000, { signal: signal() });
    const pid = batch.pid ?? -1;
    vi.advanceTimersByTime(BATCH_IDLE_MS - 1);
    expect(isAlive(pid)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(batch.pid).toBeNull();
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
    const before = spawnCount();
    const read = await batch.read(oid("f2.txt"), 1_000, { signal: signal() });
    expect(read.size).toBe(blobs.get("f2.txt")?.length);
    expect(spawnCount() - before).toBe(1);
  });

  it("fails the read in flight when the process is killed, and the next read restarts it", async () => {
    setTestGit();
    const batch = catFile(app.commonDir);
    // Kill git the moment it starts, before it can answer the request already written.
    let killed = -1;
    const stop = observeSpawns((event) => {
      if (event.type === "spawn" && killed === -1 && event.args.includes("cat-file")) {
        killed = event.pid;
        process.kill(-event.pid, "SIGKILL");
      }
    });
    try {
      await expect(batch.read(oid("f4.txt"), 1_000, { signal: signal() })).rejects.toMatchObject({
        name: "GitError",
      });
    } finally {
      stop();
    }
    expect(killed).toBeGreaterThan(0);
    // The config listing is kept from the first read, so only cat-file starts again.
    const before = spawnCount();
    const read = await batch.read(oid("f4.txt"), 1_000, { signal: signal() });
    expect(read.size).toBe(blobs.get("f4.txt")?.length);
    expect(spawnCount() - before).toBe(1);
    expect(batch.pid).not.toBe(killed);
  });
});
