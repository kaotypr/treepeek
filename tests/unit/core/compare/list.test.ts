import { lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ComparisonResult,
  ContentSide,
  FileChange,
  ListableComparisonKind,
} from "../../../../src/shared/domain/compare";
import type { Result } from "../../../../src/shared/ipc";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { type Client, type Harness, harness } from "../../../support/core-session";
import { gitIn } from "../../../support/git";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

/**
 * Every comparison kind's file list on one fixture, compared with what the prototype's
 * `comparison()` returns for the same checkout (`prototypeList` below ports it: plain git,
 * `--name-status`), and with hand-written lists where the prototype has no such kind
 * (`review`). The only intended differences: `review` is new, `resultHash` is set on every
 * file, and deleted files carry `deleted:<leftOid>`.
 */

const LONG = Array.from({ length: 30 }, (_, i) => `line ${i} of a file Git can follow\n`).join("");
const LONG_COPY = Array.from({ length: 30 }, (_, i) => `copied line ${i}\n`).join("");
const BINARY_1 = new Uint8Array([0, 1, 2, 3, 0, 255, 10]);
const BINARY_2 = new Uint8Array([0, 9, 9, 9, 0, 255, 10]);

let fx: Fixture;
let app: FixtureRepo;
let feature: FixtureCheckout;
let lost: FixtureRepo;
let par: FixtureRepo;
let parA: FixtureCheckout;
let empty: FixtureRepo;
let basePoint: string;
let next: string;
let head: string;
let created: Harness;
let client: Client;

beforeAll(async () => {
  setTestGit();
  fx = fixture();
  app = fx.repo("app").commit({
    "keep.txt": "keep\n",
    "edit.txt": "line 1\nline 2\n",
    "gone.txt": "bye\n",
    "move-me.txt": LONG,
    "mode.sh": "echo hi\n",
    "bin.dat": BINARY_1,
    "copy-src.txt": LONG_COPY,
    "type.txt": "will become a link\n",
    "no-newline.txt": "a\nb",
    "rename-back.txt": "comes back\n",
  });
  basePoint = app.head();
  app.git(["branch", "base-point"]);
  app.git(["switch", "--quiet", "-c", "next"], { records: true });
  app.commit({ "incoming.txt": "arrived\n", "edit.txt": "line 1 (next)\nline 2\n" });
  next = app.head();
  app.git(["switch", "--quiet", "main"], { records: true });

  // Starts from `next`, ahead of main's HEAD: its relation to the main checkout is `after`.
  feature = app.worktree("feature", { from: "next", branch: "feature" });
  feature.rename("move-me.txt", "moved/renamed file.txt");
  feature.commit({
    "edit.txt": "line 1 (feature)\nline 2\n",
    "gone.txt": null,
    "moved/renamed file.txt": `${LONG}one more line\n`,
    "mode.sh": { content: "echo hi\n", executable: true },
    "with space.txt": "space\n",
    "naïve-ü 名.txt": "unicode\n",
    "line\nbreak.txt": "newline\n",
    "bin.dat": BINARY_2,
    "copy-dst.txt": LONG_COPY,
    "type.txt": { symlink: "keep.txt" },
    "no-newline.txt": "a\nc",
  });
  head = feature.head();
  feature.git(["branch", "--quiet", "--set-upstream-to=next"]);
  // Uncommitted: staged, unstaged, untracked, and two paths back on disk after leaving the index.
  feature.write({ "staged.txt": "staged\n", "edit.txt": "line 1 (staged)\nline 2\n" });
  feature.stage(["staged.txt", "edit.txt"]);
  feature.write({
    "edit.txt": "line 1 (unstaged)\nline 2\n",
    "keep.txt": "kept, and changed\n",
    "copy-src.txt": null,
  });
  feature.git(["rm", "--quiet", "--cached", "--", "mode.sh"]);
  feature.rename("rename-back.txt", "renamed-back.txt");
  feature.write({
    "rename-back.txt": "comes back\n",
    "untracked one.txt": "u\n",
    "untracked.bin": BINARY_1,
    "dir/deep/u.txt": "deep\n",
  });

  // A history with no start left (expired reflog), parallel worktrees, and no commits.
  lost = fx.repo("lost").commit({ "l.txt": "1\n" }).commit({ "l.txt": "2\n" });
  lost.write({ "l.txt": "3\n" }).expireReflog();
  par = fx.repo("par").commit({ "p.txt": "1\n" });
  parA = par.worktree("par-a", { from: "main" });
  par.commit({ "p.txt": "2\n" });
  empty = fx.repo("empty");
  empty.write({ "e.txt": "e\n" }).stage(["e.txt"]);
  empty.write({ "f.txt": "f\n" });

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

type Request = { kind: ListableComparisonKind; ref?: string; startOverride?: string };

async function list(checkout: FixtureCheckout, request: Request) {
  return client.call<ComparisonResult>("comparison.list", {
    checkoutPath: checkout.path,
    ...request,
  });
}

async function listed(checkout: FixtureCheckout, request: Request): Promise<ComparisonResult> {
  const result = await list(checkout, request);
  if (!result.ok) throw new Error(`${request.kind}: ${result.error.code} ${result.error.message}`);
  return result.value;
}

interface Summary {
  path: string;
  status: FileChange["status"];
  oldPath?: string;
  category?: FileChange["category"];
}

function summary(file: FileChange): Summary {
  return {
    path: file.path,
    status: file.status,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    ...(file.category === undefined ? {} : { category: file.category }),
  };
}

const LETTERS: Record<string, FileChange["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "typeChanged",
};

/** The prototype's `entries_from_diff`: `diff --find-renames --name-status -z`. */
function prototypeEntries(cwd: string, category: string | null, args: readonly string[]) {
  const raw = gitIn(cwd, [
    "diff",
    "--no-ext-diff",
    "--find-renames",
    "--name-status",
    "-z",
    ...args,
  ]);
  const parts = raw.split("\0").filter(Boolean);
  const entries: Summary[] = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++] ?? "";
    const withCategory = category === null ? {} : { category: category as Summary["category"] };
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[index++] ?? "";
      const path = parts[index++] ?? "";
      entries.push({
        path,
        status: status.startsWith("R") ? "renamed" : "copied",
        oldPath,
        ...withCategory,
      });
    } else {
      const path = parts[index++] ?? "";
      entries.push({ path, status: LETTERS[status.slice(0, 1)] ?? "modified", ...withCategory });
    }
  }
  return entries;
}

/** The prototype's `untracked`: `ls-files --others --exclude-standard -z`. */
function prototypeUntracked(cwd: string): Summary[] {
  return gitIn(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, status: "untracked", category: "untracked" }));
}

/** What the prototype's `comparison()` lists for a range (`committed` has no category here). */
function prototypeRange(cwd: string, left: string, right: string): Summary[] {
  return prototypeEntries(cwd, null, [`${left}..${right}`]);
}

function byPath(a: Summary, b: Summary): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function blob(cwd: string, spec: string): string {
  return gitIn(cwd, ["rev-parse", "--verify", "--end-of-options", spec]).trim();
}

function sideBlob(cwd: string, side: ContentSide, path: string): string | undefined {
  if (side.kind === "commit") return blob(cwd, `${side.oid}:${path}`);
  if (side.kind === "index") return blob(cwd, `:${path}`);
  return undefined;
}

/** The blob id Git would give a working-tree file; a symlink hashes as its target text. */
function workingHash(cwd: string, path: string): string {
  const file = join(cwd, path);
  if (lstatSync(file).isSymbolicLink()) {
    return gitIn(cwd, ["hash-object", "--stdin"], { input: readlinkSync(file, "utf8") }).trim();
  }
  return gitIn(cwd, ["hash-object", "--", path]).trim();
}

/** Checks every file's blob ids and `resultHash` against plain git. */
function expectIdentities(checkout: FixtureCheckout, files: readonly FileChange[]): void {
  for (const file of files) {
    const what = `${file.category ?? ""} ${JSON.stringify(file.path)}`;
    const left = sideBlob(checkout.path, file.left, file.oldPath ?? file.path);
    expect(file.leftOid, what).toBe(left);
    if (file.status === "deleted") {
      expect(file.right, what).toEqual({ kind: "empty" });
      expect(file.resultHash, what).toBe(`deleted:${left}`);
      continue;
    }
    if (file.right.kind === "workingTree") {
      expect(file.rightOid, what).toBeUndefined();
      expect(file.resultHash, what).toBe(workingHash(checkout.path, file.path));
    } else {
      const right = sideBlob(checkout.path, file.right, file.path);
      expect(file.rightOid, what).toBe(right);
      expect(file.resultHash, what).toBe(right);
    }
    if (file.status === "added" || file.status === "untracked") {
      expect(file.left, what).toEqual({ kind: "empty" });
    }
  }
}

const commit = (oid: string): ContentSide => ({ kind: "commit", oid });

describe("comparison.list", () => {
  it("review: start → working tree, committed and uncommitted in one list, each path once", async () => {
    const result = await listed(feature, { kind: "review" });
    expect(result.comparison).toEqual({
      kind: "review",
      left: commit(next),
      right: { kind: "workingTree" },
    });
    const expected: Summary[] = [
      { path: "bin.dat", status: "modified" },
      // Committed as a copy, and the source since deleted on disk: from the start, a rename.
      { path: "copy-dst.txt", status: "renamed", oldPath: "copy-src.txt" },
      { path: "dir/deep/u.txt", status: "untracked" },
      { path: "edit.txt", status: "modified" },
      { path: "gone.txt", status: "deleted" },
      { path: "keep.txt", status: "modified" },
      { path: "line\nbreak.txt", status: "added" },
      // Gone from the index but still on disk: modified since the start, listed once.
      { path: "mode.sh", status: "modified" },
      { path: "moved/renamed file.txt", status: "renamed", oldPath: "move-me.txt" },
      { path: "naïve-ü 名.txt", status: "added" },
      { path: "no-newline.txt", status: "modified" },
      // Renamed in the index, while the old path came back on disk.
      { path: "rename-back.txt", status: "modified" },
      { path: "renamed-back.txt", status: "copied", oldPath: "rename-back.txt" },
      { path: "staged.txt", status: "added" },
      { path: "type.txt", status: "typeChanged" },
      { path: "untracked one.txt", status: "untracked" },
      { path: "untracked.bin", status: "untracked" },
      { path: "with space.txt", status: "added" },
    ];
    expect(result.files.map(summary)).toEqual([...expected].sort(byPath));
    expect(new Set(result.files.map((file) => file.path)).size).toBe(result.files.length);
    expectIdentities(feature, result.files);
    expect(result.files.every((file) => file.category === undefined)).toBe(true);
    expect(result.commits).toBe(1);
    expect(result.contained).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it("review: sniffs working-tree content for binary, and leaves blob sides to diff.file", async () => {
    const { files } = await listed(feature, { kind: "review" });
    const binary = new Set(files.filter((file) => file.binary).map((file) => file.path));
    expect(binary).toEqual(new Set(["untracked.bin", "bin.dat"]));
    const worktree = await listed(feature, { kind: "worktree" });
    expect(worktree.files.find((file) => file.path === "bin.dat")?.binary).toBe(false);
  });

  it("worktree, incoming, sincePrevious: the prototype's start, incoming and previous modes", async () => {
    const worktree = await listed(feature, { kind: "worktree" });
    expect(worktree.comparison).toEqual({
      kind: "worktree",
      left: commit(next),
      right: commit(head),
    });
    expect(worktree.files.map(summary)).toEqual(prototypeRange(feature.path, next, head));
    expect(worktree.files.map(summary)).toContainEqual({
      path: "moved/renamed file.txt",
      status: "renamed",
      oldPath: "move-me.txt",
    });
    expect(worktree.files.map(summary)).toContainEqual({ path: "mode.sh", status: "modified" });
    expect(worktree.files.map(summary)).toContainEqual({ path: "type.txt", status: "typeChanged" });
    // `--find-renames` finds no copies, as in the prototype: a copy is a new file.
    expect(worktree.files.map(summary)).toContainEqual({ path: "copy-dst.txt", status: "added" });
    expect(worktree).toMatchObject({ commits: 1, contained: false });

    const incoming = await listed(feature, { kind: "incoming" });
    expect(incoming.comparison).toEqual({
      kind: "incoming",
      left: commit(basePoint),
      right: commit(next),
    });
    expect(incoming.files.map(summary)).toEqual([
      { path: "edit.txt", status: "modified" },
      { path: "incoming.txt", status: "added" },
    ]);
    expect(incoming.files.map(summary)).toEqual(prototypeRange(feature.path, basePoint, next));
    expect(incoming).toMatchObject({ commits: 1, contained: false });

    const since = await listed(feature, { kind: "sincePrevious" });
    expect(since.comparison).toEqual({
      kind: "sincePrevious",
      left: commit(basePoint),
      right: commit(head),
    });
    expect(since.files.map(summary)).toEqual(prototypeRange(feature.path, basePoint, head));
    expect(since).toMatchObject({ commits: 2, contained: false });

    for (const result of [worktree, incoming, since]) expectIdentities(feature, result.files);
  });

  it("base and upstream: from the merge base with the ref, and whether HEAD is contained", async () => {
    const base = await listed(feature, { kind: "base", ref: "base-point" });
    expect(base.comparison).toEqual({ kind: "base", left: commit(basePoint), right: commit(head) });
    expect(base.files.map(summary)).toEqual(prototypeRange(feature.path, basePoint, head));
    expect(base).toMatchObject({ commits: 2, contained: false });
    expect(base.note).toBeUndefined();

    const upstream = await listed(feature, { kind: "upstream" });
    expect(upstream.comparison).toEqual({
      kind: "upstream",
      left: commit(next),
      right: commit(head),
    });
    expect(upstream.files.map(summary)).toEqual(prototypeRange(feature.path, next, head));
    expect(upstream).toMatchObject({ commits: 1, contained: false });
    expectIdentities(feature, [...base.files, ...upstream.files]);

    // Comparing with a ref HEAD is already part of: nothing to show, and the note says why.
    const contained = await listed(feature, { kind: "base", ref: "feature" });
    expect(contained).toEqual({
      comparison: { kind: "base", left: commit(head), right: commit(head) },
      files: [],
      commits: 0,
      contained: true,
      note: "HEAD is contained in the selected ref",
    });
  });

  it("working: staged, unstaged and untracked, as the prototype's working mode", async () => {
    const result = await listed(feature, { kind: "working" });
    expect(result.comparison).toEqual({
      kind: "working",
      left: commit(head),
      right: { kind: "workingTree" },
    });
    const prototype = [
      ...prototypeEntries(feature.path, "staged", ["--cached"]),
      ...prototypeEntries(feature.path, "unstaged", []),
      ...prototypeUntracked(feature.path),
    ];
    expect(result.files.map(summary)).toEqual(prototype);
    expect(result.files.map(summary)).toEqual([
      { path: "edit.txt", status: "modified", category: "staged" },
      { path: "mode.sh", status: "deleted", category: "staged" },
      {
        path: "renamed-back.txt",
        status: "renamed",
        oldPath: "rename-back.txt",
        category: "staged",
      },
      { path: "staged.txt", status: "added", category: "staged" },
      { path: "copy-src.txt", status: "deleted", category: "unstaged" },
      { path: "edit.txt", status: "modified", category: "unstaged" },
      { path: "keep.txt", status: "modified", category: "unstaged" },
      { path: "dir/deep/u.txt", status: "untracked", category: "untracked" },
      { path: "mode.sh", status: "untracked", category: "untracked" },
      { path: "rename-back.txt", status: "untracked", category: "untracked" },
      { path: "untracked one.txt", status: "untracked", category: "untracked" },
      { path: "untracked.bin", status: "untracked", category: "untracked" },
    ]);
    const sides = (category: string) =>
      result.files
        .filter((file) => file.category === category && file.status === "modified")
        .map((file) => [file.left.kind, file.right.kind]);
    expect(sides("staged")).toEqual([["commit", "index"]]);
    expect(sides("unstaged")).toEqual([
      ["index", "workingTree"],
      ["index", "workingTree"],
    ]);
    expectIdentities(feature, result.files);
    expect(result.commits).toBeUndefined();
    expect(result.contained).toBeUndefined();
  });

  it("uses a start override for that call only, without storing it", async () => {
    const overridden = await listed(feature, { kind: "review", startOverride: "base-point" });
    expect(overridden.comparison.left).toEqual(commit(basePoint));
    expect(overridden.files.map(summary)).toContainEqual({ path: "incoming.txt", status: "added" });
    expect(overridden.commits).toBe(2);
    const worktree = await listed(feature, { kind: "worktree", startOverride: basePoint });
    expect(worktree.files.map(summary)).toEqual(prototypeRange(feature.path, basePoint, head));
    // The main checkout's HEAD is the override itself, so the relation stays `after`.
    expect((await listed(feature, { kind: "incoming", startOverride: basePoint })).files).toEqual(
      [],
    );
    const again = await listed(feature, { kind: "review" });
    expect(again.comparison.left).toEqual(commit(next));
  });

  it("lists only uncommitted changes when the start is unknown, and says so", async () => {
    const result = await listed(lost, { kind: "review" });
    expect(result.comparison).toEqual({
      kind: "review",
      left: commit(lost.head()),
      right: { kind: "workingTree" },
    });
    expect(result.files.map(summary)).toEqual([{ path: "l.txt", status: "modified" }]);
    expect(result.commits).toBe(0);
    expect(result.contained).toBeUndefined();
    expect(result.note).toMatch(/only uncommitted changes/);
    for (const kind of ["worktree", "incoming", "sincePrevious"] as const) {
      expect(await list(lost, { kind }), kind).toMatchObject({
        ok: false,
        error: { code: "refNotFound", detail: { unavailable: "noStart" } },
      });
    }
  });

  it("refuses incoming and sincePrevious without a direct previous checkout", async () => {
    for (const checkout of [parA, par, app]) {
      for (const kind of ["incoming", "sincePrevious"] as const) {
        expect(await list(checkout, { kind }), `${checkout.path} ${kind}`).toMatchObject({
          ok: false,
          error: {
            code: "refNotFound",
            message: "There is no direct previous checkout in this repository.",
            detail: { unavailable: "notAfter" },
          },
        });
      }
    }
  });

  it("refuses upstream without one, base without a ref or with a bad one, and unrelated history", async () => {
    expect(await list(app, { kind: "upstream" })).toMatchObject({
      ok: false,
      error: { code: "refNotFound", detail: { unavailable: "noUpstream" } },
    });
    expect(await list(feature, { kind: "base" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", detail: { unavailable: "noRef" } },
    });
    expect(await list(feature, { kind: "base", ref: "-x" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    for (const request of [
      { kind: "base", ref: "no-such-branch" },
      { kind: "base", ref: "HEAD^{tree}" },
      { kind: "review", startOverride: "no-such-start" },
    ] as const) {
      expect(await list(feature, request), JSON.stringify(request)).toMatchObject({
        ok: false,
        error: { code: "refNotFound" },
      });
    }
    const orphan = app.git(["commit-tree", app.rev("HEAD^{tree}"), "-m", "orphan"]).trim();
    app.git(["branch", "orphan", orphan]);
    expect(await list(feature, { kind: "base", ref: "orphan" })).toMatchObject({
      ok: false,
      error: { code: "refNotFound", detail: { unavailable: "noMergeBase" } },
    });
  });

  it("handles a checkout without commits: every file new, and no history kinds", async () => {
    const working = await listed(empty, { kind: "working" });
    expect(working.comparison.left).toEqual({ kind: "empty" });
    expect(working.files.map(summary)).toEqual([
      { path: "e.txt", status: "added", category: "staged" },
      { path: "f.txt", status: "untracked", category: "untracked" },
    ]);
    const review = await listed(empty, { kind: "review" });
    expect(review.comparison.left).toEqual({ kind: "empty" });
    expect(review.files.map(summary)).toEqual([
      { path: "e.txt", status: "added" },
      { path: "f.txt", status: "untracked" },
    ]);
    expect(review.note).toMatch(/no commits yet/);
    expect(review.commits).toBeUndefined();
    expectIdentities(empty, [...working.files, ...review.files]);
    for (const kind of ["worktree", "base", "upstream"] as const) {
      expect(await list(empty, { kind, ref: "main" }), kind).toMatchObject({
        ok: false,
        error: { code: "refNotFound", detail: { unavailable: "noHead" } },
      });
    }
  });

  it("rejects a path outside the scan, or one that is not a checkout, with notInScan", async () => {
    const outsideLink = fx.path("link-to-outside");
    symlinkSync(fx.outside, outsideLink);
    const checkoutLink = fx.outsidePath("link-to-feature");
    symlinkSync(feature.path, checkoutLink);
    for (const checkoutPath of [
      fx.outside,
      fx.path("feature/edit.txt"),
      "/",
      fx.root,
      outsideLink,
      "relative/path",
    ]) {
      const result: Result<unknown> = await client.call("comparison.list", {
        checkoutPath,
        kind: "review",
      });
      expect(result, checkoutPath).toMatchObject({ ok: false, error: { code: "notInScan" } });
    }
    // A link that resolves to a scanned checkout names that checkout.
    const viaLink = await client.call<ComparisonResult>("comparison.list", {
      checkoutPath: checkoutLink,
      kind: "worktree",
    });
    expect(viaLink).toMatchObject({
      ok: true,
      value: { comparison: { kind: "worktree", left: commit(next), right: commit(head) } },
    });
  });
});
