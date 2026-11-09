import { chmodSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HashObjectBatch, stdinPathLine } from "../../../../src/core/git/hash-object";
import { observeSpawns, spawnCount } from "../../../../src/core/git/process";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { gitIn } from "../../../support/git";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

let fx: Fixture;
let app: FixtureRepo;
const batches: HashObjectBatch[] = [];

const signal = () => new AbortController().signal;

function hasher(): HashObjectBatch {
  const batch = new HashObjectBatch(app.path);
  batches.push(batch);
  return batch;
}

/** What `git hash-object <file>` prints for `path`, run by the tests' own git. */
function gitHash(path: string): string {
  return gitIn(app.path, ["hash-object", "--", path]).trim();
}

/** Every file under the repository's object database. */
function countObjects(): number {
  let count = 0;
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(folder, entry.name));
      else count += 1;
    }
  };
  walk(join(app.commonDir, "objects"));
  return count;
}

const NAMES = [
  "plain.txt",
  "with space.txt",
  "naïve-ünïcode-名前.txt",
  "line\nbreak.txt",
  '"leading-quote.txt',
  "back\\slash.txt",
  "trailing-cr\r",
  "tab\there.txt",
  "dir/nested/deep.txt",
  "binary.bin",
];

beforeAll(() => {
  fx = fixture();
  app = fx.repo("app").commit({ "README.md": "hello\n" });
  app.write({
    "plain.txt": "plain\n",
    "with space.txt": "space\n",
    "naïve-ünïcode-名前.txt": "unicode\n",
    "line\nbreak.txt": "newline in name\n",
    '"leading-quote.txt': "quote\n",
    "back\\slash.txt": "backslash\n",
    "trailing-cr\r": "cr\n",
    "tab\there.txt": "tab\n",
    "dir/nested/deep.txt": "deep\n",
    "binary.bin": new Uint8Array([0, 1, 2, 0, 255, 10]),
  });
});
afterEach(() => {
  for (const batch of batches.splice(0)) batch.close();
  resetGitRuntime();
});
afterAll(() => {
  chmodSync(join(app.path, "locked.txt"), 0o644);
  fx.cleanup();
});

describe("stdinPathLine", () => {
  it("sends ordinary paths as they are and C-quotes the ones a line cannot carry", () => {
    expect(stdinPathLine("a b/ç.txt")).toBe("a b/ç.txt");
    expect(stdinPathLine("back\\slash")).toBe("back\\slash");
    expect(stdinPathLine("a\nb")).toBe('"a\\nb"');
    expect(stdinPathLine("cr\r")).toBe('"cr\\r"');
    expect(stdinPathLine('"q')).toBe('"\\"q"');
    expect(stdinPathLine("x\\\ny")).toBe('"x\\\\\\ny"');
    expect(stdinPathLine("bell\u0007")).toBe('"bell\\007"');
  });
});

describe("HashObjectBatch", () => {
  it("returns the same ids as git hash-object for every kind of path, with one process", async () => {
    setTestGit();
    const batch = hasher();
    const before = spawnCount();
    const hashes = await batch.hash(NAMES, { signal: signal() });
    expect(spawnCount() - before).toBe(1);
    for (const name of NAMES) expect(hashes.get(name), JSON.stringify(name)).toBe(gitHash(name));
    expect(hashes.size).toBe(NAMES.length);
  });

  it("writes nothing to the object database", async () => {
    setTestGit();
    const objects = countObjects();
    const batch = hasher();
    await batch.hash([...NAMES, "README.md"], { signal: signal() });
    expect(countObjects()).toBe(objects);
  });

  it("answers unchanged files from the (path, size, mtimeNs) cache without asking git", async () => {
    setTestGit();
    app.write({ "cached.txt": "version one\n" });
    const batch = hasher();
    const first = await batch.hash(["cached.txt", "plain.txt"], { signal: signal() });
    const pid = batch.pid;
    // Kill git: if the second call asked it anything, a new process would start.
    if (pid !== null) process.kill(-pid, "SIGKILL");
    const before = spawnCount();
    const second = await batch.hash(["cached.txt", "plain.txt"], { signal: signal() });
    expect(second).toEqual(first);
    expect(spawnCount()).toBe(before);
  });

  it("hashes again when the size or the mtime changes", async () => {
    setTestGit();
    app.write({ "changing.txt": "aaaa\n" });
    const batch = hasher();
    const first = await batch.hash(["changing.txt"], { signal: signal() });
    expect(first.get("changing.txt")).toBe(gitHash("changing.txt"));

    app.write({ "changing.txt": "a longer version\n" });
    const bySize = await batch.hash(["changing.txt"], { signal: signal() });
    expect(bySize.get("changing.txt")).toBe(gitHash("changing.txt"));
    expect(bySize.get("changing.txt")).not.toBe(first.get("changing.txt"));

    // Same size, different content: only the mtime tells them apart.
    const file = join(app.path, "changing.txt");
    const { mtime } = statSync(file);
    app.write({ "changing.txt": "A LONGER VERSION\n" });
    utimesSync(file, mtime, new Date(mtime.getTime() + 5_000));
    const byTime = await batch.hash(["changing.txt"], { signal: signal() });
    expect(byTime.get("changing.txt")).toBe(gitHash("changing.txt"));
    expect(byTime.get("changing.txt")).not.toBe(bySize.get("changing.txt"));
  });

  it("leaves out a file git cannot open and hashes the rest with a new process", async () => {
    setTestGit();
    app.write({ "before.txt": "before\n", "locked.txt": "locked\n", "after.txt": "after\n" });
    chmodSync(join(app.path, "locked.txt"), 0o000);
    const batch = hasher();
    let spawned = 0;
    const stop = observeSpawns((event) => {
      if (event.type === "spawn") spawned += 1;
    });
    let hashes: Map<string, string>;
    try {
      hashes = await batch.hash(["before.txt", "locked.txt", "after.txt"], { signal: signal() });
    } finally {
      stop();
      chmodSync(join(app.path, "locked.txt"), 0o644);
    }
    expect([...hashes.keys()].sort()).toEqual(["after.txt", "before.txt"]);
    expect(hashes.get("before.txt")).toBe(gitHash("before.txt"));
    expect(hashes.get("after.txt")).toBe(gitHash("after.txt"));
    expect(spawned).toBe(2);
  });

  it("hashes a symlink as Git stores it: its target text", async () => {
    setTestGit();
    app.write({ "link-to-plain": { symlink: "plain.txt" }, dangling: { symlink: "nowhere" } });
    app.stage(["link-to-plain", "dangling"]);
    const batch = hasher();
    const hashes = await batch.hash(["link-to-plain", "dangling"], { signal: signal() });
    expect(hashes.get("link-to-plain")).toBe(
      gitIn(app.path, ["rev-parse", ":link-to-plain"]).trim(),
    );
    expect(hashes.get("dangling")).toBe(gitIn(app.path, ["rev-parse", ":dangling"]).trim());
    expect(hashes.get("link-to-plain")).not.toBe(gitHash("plain.txt"));
  });

  it("leaves out missing paths, folders and paths that leave the checkout, without running git", async () => {
    setTestGit();
    const batch = hasher();
    const before = spawnCount();
    const hashes = await batch.hash(
      ["missing.txt", "dir", "dir/nested", "../outside.txt", "/etc/hosts", "a/../plain.txt", ""],
      { signal: signal() },
    );
    expect(hashes.size).toBe(0);
    expect(spawnCount()).toBe(before);
  });

  it("hashes more paths than one request carries, with one process", async () => {
    setTestGit();
    const files: Record<string, string> = {};
    for (let index = 0; index < 600; index += 1) files[`many/f${index}.txt`] = `${index}\n`;
    app.write(files);
    const batch = hasher();
    const before = spawnCount();
    const hashes = await batch.hash(Object.keys(files), { signal: signal() });
    expect(spawnCount() - before).toBe(1);
    expect(hashes.size).toBe(600);
    expect(hashes.get("many/f599.txt")).toBe(gitHash("many/f599.txt"));
    expect(hashes.get("many/f0.txt")).toBe(gitHash("many/f0.txt"));
  });

  it("fails with cancelled when the signal is already aborted", async () => {
    setTestGit();
    const batch = hasher();
    const controller = new AbortController();
    controller.abort();
    await expect(batch.hash(["plain.txt"], { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});
