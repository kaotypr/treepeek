import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitEnv } from "../../../../src/core/git/env";
import { observeSpawns } from "../../../../src/core/git/process";
import { setGitBinary } from "../../../../src/core/git/runtime";
import { DIFF_LIMITS } from "../../../../src/shared/constants";
import { parsePatch } from "../../../../src/shared/diff/parse-patch";
import type { FileDiff } from "../../../../src/shared/domain/diff";
import type { Result } from "../../../../src/shared/ipc";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import {
  type Client,
  type Harness,
  harness,
  isAlive,
  slowGit,
} from "../../../support/core-session";
import { gitIn, gitTestEnv, testGitVersion } from "../../../support/git";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

/**
 * `diff.file` at the diff pipeline's size limits, and cancelled half way. Every file here
 * is changed on disk only, so it is read through the `working` comparison's unstaged list.
 */

/** `count` numbered lines of about `width` bytes; `edit(i)` replaces line `i`. */
function rows(count: number, width: number, edit?: (i: number) => string | null): string {
  const pad = "x".repeat(Math.max(0, width - 13));
  const out: string[] = [];
  for (let i = 0; i < count; i += 1)
    out.push(edit?.(i) ?? `row ${String(i).padStart(7, "0")} ${pad}`);
  return `${out.join("\n")}\n`;
}

// About 6 MB; every 8th line changed, so each change is its own hunk: a patch over 5 MB.
const HUGE_BEFORE = rows(150_000, 40);
const HUGE_AFTER = rows(150_000, 40, (i) => (i % 8 === 0 ? `row ${i} changed` : null));
// About 2.5 MB in 30,000 lines: over the content limit by size only.
const LARGE_BEFORE = rows(30_000, 85);
const LARGE_AFTER = rows(30_000, 85, (i) => (i === 15_000 ? "the one changed line" : null));
// 60,000 short lines (under 1 MB): over the content limit by lines only.
const LONG_BEFORE = rows(60_000, 12);
const LONG_AFTER = rows(60_000, 12, (i) => (i === 3 ? "changed" : null));
// About 1.5 MB in 15,000 lines: past the highlighting limit, within the content limit.
const PLAIN_BEFORE = rows(15_000, 100);
const PLAIN_AFTER = rows(15_000, 100, (i) => (i === 7 ? "changed" : null));

let fx: Fixture;
let big: FixtureRepo;
let created: Harness;
let client: Client;
let requests = 0;

beforeAll(async () => {
  setTestGit();
  fx = fixture();
  big = fx.repo("big").commit({
    "huge.txt": HUGE_BEFORE,
    "large.txt": LARGE_BEFORE,
    "long.txt": LONG_BEFORE,
    "plain.txt": PLAIN_BEFORE,
    "small.txt": "small\n",
  });
  big.write({
    "huge.txt": HUGE_AFTER,
    "large.txt": LARGE_AFTER,
    "long.txt": LONG_AFTER,
    "plain.txt": PLAIN_AFTER,
    "small.txt": "small, edited\n",
  });
  created = harness();
  client = created.open(1).client;
  await client.call("session.open", { scanRoot: fx.root });
  await client.call("scan.start", { requestId: "scan" });
  await client.waitForEvent("scan.done");
});
afterAll(() => {
  created.dispose();
  fx.cleanup();
  resetGitRuntime();
});

function unstaged(path: string, requestId = `diff-${++requests}`): Promise<Result<FileDiff>> {
  return client.call<FileDiff>("diff.file", {
    requestId,
    checkoutPath: big.path,
    comparison: { kind: "working" },
    path,
    category: "unstaged",
  });
}

async function diffed(path: string): Promise<FileDiff> {
  const result = await unstaged(path);
  if (!result.ok) throw new Error(`${path}: ${result.error.code} ${result.error.message}`);
  return result.value;
}

function gitPatch(path: string): string {
  return gitIn(big.path, ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", path]);
}

describe("diff.file size limits", () => {
  it("omits both texts of a file over 2 MB, and still sends Git's hunks", async () => {
    expect(Buffer.byteLength(LARGE_AFTER)).toBeGreaterThan(DIFF_LIMITS.contentBytes);
    const diff = await diffed("large.txt");
    expect(diff).toMatchObject({
      binary: false,
      left: null,
      right: null,
      stats: { added: 1, removed: 1 },
      limits: { patchTruncated: false, contentOmitted: true, highlightOff: true },
    });
    expect(diff.hunks).toEqual(parsePatch(gitPatch("large.txt")).hunks);
    expect(diff.hunks).toHaveLength(1);
  });

  it("omits both texts of a file over 50,000 lines", async () => {
    expect(Buffer.byteLength(LONG_AFTER)).toBeLessThan(DIFF_LIMITS.highlightBytes);
    const diff = await diffed("long.txt");
    expect(diff).toMatchObject({
      left: null,
      right: null,
      limits: { patchTruncated: false, contentOmitted: true, highlightOff: true },
    });
    expect(diff.hunks).toEqual(parsePatch(gitPatch("long.txt")).hunks);
  });

  it("keeps the texts but turns highlighting off past 1 MB", async () => {
    const diff = await diffed("plain.txt");
    expect(diff.limits).toEqual({
      patchTruncated: false,
      contentOmitted: false,
      highlightOff: true,
    });
    expect(diff.left).toBe(PLAIN_BEFORE);
    expect(diff.right).toBe(PLAIN_AFTER);
  });

  it("cuts a patch over 5 MB at a hunk boundary, with the whole file's line counts", async () => {
    const full = gitPatch("huge.txt");
    expect(Buffer.byteLength(full)).toBeGreaterThan(DIFF_LIMITS.patchBytes);
    const all = parsePatch(full).hunks;
    const diff = await diffed("huge.txt");
    expect(diff.limits).toEqual({ patchTruncated: true, contentOmitted: true, highlightOff: true });
    expect(diff.hunks.length).toBeGreaterThan(1_000);
    expect(diff.hunks.length).toBeLessThan(all.length);
    // Every hunk kept is whole and is Git's, in order: the cut fell between two hunks.
    expect(diff.hunks).toEqual(all.slice(0, diff.hunks.length));
    for (const hunk of diff.hunks) {
      const old = hunk.lines.filter((line) => line.kind !== "add" && line.kind !== "noNewline");
      const added = hunk.lines.filter(
        (line) => line.kind !== "remove" && line.kind !== "noNewline",
      );
      expect(old).toHaveLength(hunk.oldLines);
      expect(added).toHaveLength(hunk.newLines);
    }
    expect(diff.stats).toEqual({ added: 18_750, removed: 18_750 });
    expect(diff.left).toBeNull();
    expect(diff.right).toBeNull();
  });

  it("leaves a small file whole", async () => {
    const diff = await diffed("small.txt");
    expect(diff).toMatchObject({
      left: "small\n",
      right: "small, edited\n",
      limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
    });
  });
});

describe("cancelling diff.file", () => {
  it("answers cancelled and leaves no git process running", async () => {
    // A git that waits before doing anything, so the call is still running when cancelled.
    const slow = slowGit(join(fx.outside, "slow-git.sh"), 10);
    setGitBinary({ found: true, path: slow, version: testGitVersion() }, gitEnv(gitTestEnv()));
    const pids: number[] = [];
    const stop = observeSpawns((event) => {
      if (event.type === "spawn") pids.push(event.pid);
    });
    try {
      const started = Date.now();
      const pending = unstaged("small.txt", "to-cancel");
      await until(() => pids.length > 0, 5_000);
      expect(await client.call("request.cancel", { requestId: "to-cancel" })).toEqual({
        ok: true,
        value: {},
      });
      expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(Date.now() - started).toBeLessThan(5_000);
      await until(() => pids.every((pid) => !isAlive(pid)), 3_000);
      const spawned = pids.length;
      // Nothing the cancelled call would have done next starts later.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pids).toHaveLength(spawned);
      expect(pids.filter(isAlive)).toEqual([]);
    } finally {
      stop();
      setTestGit();
    }
    // The next request works again with the real git.
    expect((await diffed("small.txt")).right).toBe("small, edited\n");
  });
});

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
