import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, SMALL_FIXTURES } from "../../../../scripts/make-diff-fixtures";
import { checkRepoPath } from "../../../../src/core/diff/file-diff";
import { parsePatch } from "../../../../src/shared/diff/parse-patch";
import type {
  ComparisonResult,
  FileCategory,
  ListableComparisonKind,
} from "../../../../src/shared/domain/compare";
import type { FileDiff, Hunk } from "../../../../src/shared/domain/diff";
import type { Result } from "../../../../src/shared/ipc";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { type Client, type Harness, harness } from "../../../support/core-session";
import { gitIn, removeTempRepos } from "../../../support/git";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

/**
 * `diff.file` against real repositories: every `FileDiff` is compared with what plain git
 * says for the same file (its patch through the shared parser, its blobs and the file on
 * disk), and with the diff viewer's fixtures, which `scripts/make-diff-fixtures.ts` builds
 * with real git the same way.
 */

const LONG = Array.from({ length: 30 }, (_, i) => `line ${i} of a file Git can follow\n`).join("");
const BACK = Array.from({ length: 12 }, (_, i) => `back on disk ${i}\n`).join("");
const COMES_BACK = Array.from({ length: 12 }, (_, i) => `comes back ${i}\n`).join("");
const BINARY_1 = new Uint8Array([0, 1, 2, 3, 0, 255, 10]);
const BINARY_2 = new Uint8Array([0, 9, 9, 9, 0, 255, 10]);
const NEWLINE_NAME = "line\nbreak.txt";
const UNICODE_NAME = "naïve-ü 名.txt";

let fx: Fixture;
let specs: FixtureRepo;
let specsWt: FixtureCheckout;
let app: FixtureRepo;
let feature: FixtureCheckout;
let empty: FixtureRepo;
let conflict: FixtureRepo;
let start: string;
let head: string;
let created: Harness;
let client: Client;

beforeAll(async () => {
  setTestGit();
  fx = fixture();

  // The diff viewer's fixtures, all in one history: before on main, after in a worktree.
  const before: Record<string, string | Uint8Array> = {};
  for (const spec of SMALL_FIXTURES) Object.assign(before, spec.before);
  specs = fx.repo("specs").commit(before);
  specsWt = specs.worktree("specs-wt", { from: "main" });
  specsWt.write(Object.fromEntries(Object.keys(before).map((path) => [path, null])));
  for (const spec of SMALL_FIXTURES) {
    for (const [path, content] of Object.entries(spec.after)) {
      const executable = spec.executableAfter?.includes(path) ?? false;
      specsWt.write({ [path]: executable ? { content, executable } : content });
    }
  }
  specsWt.commit({}, "after");

  // Renames, copies, deletions, mode and type changes, binaries, awkward names, and every
  // kind of uncommitted change.
  app = fx.repo("app").commit({
    "keep.txt": "keep\n",
    "edit.txt": "line 1\nline 2\nline 3\n",
    "gone.txt": "bye\nfor now\n",
    "move-me.txt": LONG,
    "mode.sh": "echo hi\n",
    "bin.dat": BINARY_1,
    "type.txt": "will become a link\n",
    "no-newline.txt": "a\nb",
    "with space.txt": "space\n",
    [UNICODE_NAME]: "unicode\n",
    [NEWLINE_NAME]: "newline\n",
    "staged.txt": "staged 1\n",
    "unstaged.txt": "unstaged 1\n",
    "back.txt": BACK,
    "rename-back.txt": COMES_BACK,
    "dir/inner.txt": "inner\n",
  });
  feature = app.worktree("feature", { from: "main" });
  start = feature.head();
  feature.rename("move-me.txt", "moved/renamed file.txt");
  feature.commit({
    "edit.txt": "line 1\nline 2 (feature)\nline 3\n",
    "gone.txt": null,
    "moved/renamed file.txt": `${LONG}one more line\n`,
    "mode.sh": { content: "echo hi\n", executable: true },
    "bin.dat": BINARY_2,
    "type.txt": { symlink: "keep.txt" },
    "no-newline.txt": "a\nc",
    "with space.txt": "space, edited\n",
    [UNICODE_NAME]: "unicode, edited\n",
    [NEWLINE_NAME]: "newline, edited\n",
  });
  head = feature.head();
  feature.write({ "staged.txt": "staged 2\n" }).stage(["staged.txt"]);
  feature.write({ "unstaged.txt": "unstaged 2\n" });
  // Out of the index, still on disk (and edited): modified in `review`, deleted to Git.
  feature.git(["rm", "--quiet", "--cached", "--", "back.txt"]);
  feature.write({ "back.txt": `${BACK}edited on disk\n` });
  // Renamed in the index while the old path came back on disk: a copy in `review`.
  feature.rename("rename-back.txt", "renamed-back.txt");
  feature.write({
    "renamed-back.txt": `${COMES_BACK}renamed\n`,
    "rename-back.txt": COMES_BACK,
  });
  feature.write({
    "untracked one.txt": "first\nsecond\n",
    "untracked.bin": BINARY_1,
    "untracked-[1].txt": "glob characters\n",
  });
  writeFileSync(fx.outsidePath("secret.txt"), "outside\n");
  symlinkSync(fx.outsidePath("secret.txt"), join(feature.path, "escape"));
  symlinkSync("dir", join(feature.path, "dir-link"));
  symlinkSync("keep.txt", join(feature.path, "keep-link"));

  empty = fx.repo("empty");
  empty.write({ "e.txt": "e\n" }).stage(["e.txt"]);
  empty.write({ "f.txt": "f\n" });

  // A merge stopped on a conflict: Git lists the path with no blob on the index side.
  conflict = fx.repo("conflict").commit({ "c.txt": "base\n" });
  conflict.git(["switch", "--quiet", "-c", "other"], { records: true });
  conflict.commit({ "c.txt": "theirs\n" });
  conflict.git(["switch", "--quiet", "main"], { records: true });
  conflict.commit({ "c.txt": "ours\n" });
  conflict.git(["merge", "--quiet", "--no-edit", "other"], { okExitCodes: [1] });

  created = harness();
  client = created.open(1).client;
  await client.call("session.open", { scanRoots: [fx.root] });
  await client.call("scan.start", { requestId: "scan" });
  await client.waitForEvent("scan.done");
});
afterAll(() => {
  created.dispose();
  fx.cleanup();
  removeTempRepos();
  resetGitRuntime();
});

interface DiffRequest {
  kind: ListableComparisonKind;
  path: string;
  category?: FileCategory;
  ref?: string;
}

let requests = 0;

function diffFile(checkout: FixtureCheckout, request: DiffRequest): Promise<Result<FileDiff>> {
  requests += 1;
  return client.call<FileDiff>("diff.file", {
    requestId: `diff-${requests}`,
    checkoutPath: checkout.path,
    comparison: { kind: request.kind, ...(request.ref === undefined ? {} : { ref: request.ref }) },
    path: request.path,
    ...(request.category === undefined ? {} : { category: request.category }),
  });
}

async function diffed(checkout: FixtureCheckout, request: DiffRequest): Promise<FileDiff> {
  const result = await diffFile(checkout, request);
  if (!result.ok) throw new Error(`${request.path}: ${result.error.code} ${result.error.message}`);
  return result.value;
}

const DIFF = ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U3"];

/** Every hunk of every section plain git writes for `args`. */
function gitHunks(cwd: string, args: readonly string[], okExitCodes = [0]): Hunk[] {
  const text = gitIn(cwd, [...DIFF, ...args], { okExitCodes });
  return text
    .split(/^(?=diff --git )/m)
    .filter(Boolean)
    .flatMap((section) => parsePatch(section).hunks);
}

function show(cwd: string, spec: string): string {
  return gitIn(cwd, ["cat-file", "-p", spec]);
}

function hashFile(cwd: string, path: string): string {
  return gitIn(cwd, ["hash-object", "--", path]).trim();
}

describe("diff.file matches git", () => {
  it.each(SMALL_FIXTURES.map((spec) => [spec.name, spec] as const))(
    "%s: the viewer fixture, in worktree and review",
    async (_name, spec) => {
      const expected = buildFixture(spec);
      for (const kind of ["worktree", "review"] as const) {
        expect(await diffed(specsWt, { kind, path: expected.path }), kind).toEqual(expected);
      }
    },
  );

  it("a rename with an edit, and its old path", async () => {
    for (const kind of ["worktree", "review"] as const) {
      const diff = await diffed(feature, { kind, path: "moved/renamed file.txt" });
      expect(diff).toMatchObject({
        path: "moved/renamed file.txt",
        oldPath: "move-me.txt",
        status: "renamed",
        binary: false,
        left: LONG,
        right: `${LONG}one more line\n`,
        stats: { added: 1, removed: 0 },
      });
      expect(diff.hunks).toEqual(
        gitHunks(feature.path, ["--find-renames", start, head, "--", "move-me.txt", "moved"]),
      );
    }
  });

  it("a deletion: the left text, an empty right, and deleted:<leftOid>", async () => {
    const diff = await diffed(feature, { kind: "worktree", path: "gone.txt" });
    const leftOid = feature.rev(`${start}:gone.txt`);
    expect(diff).toEqual({
      path: "gone.txt",
      status: "deleted",
      binary: false,
      hunks: gitHunks(feature.path, [start, head, "--", "gone.txt"]),
      left: "bye\nfor now\n",
      right: "",
      stats: { added: 0, removed: 2 },
      limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
      resultHash: `deleted:${leftOid}`,
    });
  });

  it("a mode change: no hunks, the same text on both sides", async () => {
    const diff = await diffed(feature, { kind: "worktree", path: "mode.sh" });
    expect(diff).toMatchObject({ status: "modified", hunks: [], left: "echo hi\n" });
    expect(diff.right).toBe("echo hi\n");
  });

  it("a type change: Git's deletion and addition as one file, the link as its target text", async () => {
    const diff = await diffed(feature, { kind: "worktree", path: "type.txt" });
    expect(diff.status).toBe("typeChanged");
    expect(diff.hunks).toEqual(gitHunks(feature.path, [start, head, "--", "type.txt"]));
    expect(diff.hunks).toHaveLength(2);
    expect(diff).toMatchObject({
      left: "will become a link\n",
      right: "keep.txt",
      stats: { added: 1, removed: 1 },
    });
  });

  it("binary files, tracked and untracked: no hunks, no texts", async () => {
    for (const [kind, path] of [
      ["worktree", "bin.dat"],
      ["review", "bin.dat"],
      ["review", "untracked.bin"],
    ] as const) {
      const diff = await diffed(feature, { kind, path });
      expect(diff, `${kind} ${path}`).toMatchObject({
        binary: true,
        hunks: [],
        left: null,
        right: null,
        stats: { added: 0, removed: 0 },
        limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
      });
    }
    const untracked = await diffed(feature, {
      kind: "working",
      path: "untracked.bin",
      category: "untracked",
    });
    expect(untracked).toMatchObject({ status: "untracked", binary: true });
    expect(untracked.resultHash).toBe(hashFile(feature.path, "untracked.bin"));
  });

  it("no newline at end of file, on both sides", async () => {
    const diff = await diffed(feature, { kind: "worktree", path: "no-newline.txt" });
    expect(diff.hunks).toEqual(gitHunks(feature.path, [start, head, "--", "no-newline.txt"]));
    expect(diff.hunks[0]?.lines.filter((line) => line.kind === "noNewline")).toHaveLength(2);
    expect(diff).toMatchObject({ left: "a\nb", right: "a\nc" });
  });

  it("paths with spaces, non-ASCII characters and newlines", async () => {
    for (const path of ["with space.txt", UNICODE_NAME, NEWLINE_NAME]) {
      for (const kind of ["worktree", "review"] as const) {
        const diff = await diffed(feature, { kind, path });
        expect(diff.path, JSON.stringify(path)).toBe(path);
        expect(diff.status).toBe("modified");
        expect(diff.hunks).toEqual(gitHunks(feature.path, [start, head, "--", path]));
        expect(diff.right).toBe(show(feature.path, `${head}:${path}`));
      }
    }
  });

  it("an untracked text file: Git's --no-index patch against /dev/null", async () => {
    for (const request of [
      { kind: "review", path: "untracked one.txt" },
      { kind: "working", path: "untracked one.txt", category: "untracked" },
      { kind: "review", path: "untracked-[1].txt" },
    ] as const) {
      const diff = await diffed(feature, request);
      expect(diff).toEqual({
        path: request.path,
        status: "untracked",
        binary: false,
        hunks: gitHunks(feature.path, ["--no-index", "--", "/dev/null", request.path], [1]),
        left: "",
        right: readFileSync(join(feature.path, request.path), "utf8"),
        stats: { added: request.path === "untracked one.txt" ? 2 : 1, removed: 0 },
        limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
        resultHash: hashFile(feature.path, request.path),
      });
    }
  });

  it("a staged-only change in working: HEAD → index", async () => {
    const diff = await diffed(feature, { kind: "working", path: "staged.txt", category: "staged" });
    expect(diff).toEqual({
      path: "staged.txt",
      status: "modified",
      binary: false,
      hunks: gitHunks(feature.path, ["--cached", "--", "staged.txt"]),
      left: "staged 1\n",
      right: show(feature.path, ":staged.txt"),
      stats: { added: 1, removed: 1 },
      limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
      resultHash: feature.rev(":staged.txt"),
    });
    expect(diff.right).toBe("staged 2\n");
  });

  it("an unstaged-only change in working: index → disk", async () => {
    const diff = await diffed(feature, {
      kind: "working",
      path: "unstaged.txt",
      category: "unstaged",
    });
    expect(diff).toEqual({
      path: "unstaged.txt",
      status: "modified",
      binary: false,
      hunks: gitHunks(feature.path, ["--", "unstaged.txt"]),
      left: show(feature.path, ":unstaged.txt"),
      right: "unstaged 2\n",
      stats: { added: 1, removed: 1 },
      limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
      resultHash: hashFile(feature.path, "unstaged.txt"),
    });
  });

  it("review: committed, staged and unstaged changes as one diff from the start", async () => {
    const diff = await diffed(feature, { kind: "review", path: "staged.txt" });
    expect(diff.hunks).toEqual(gitHunks(feature.path, [start, "--", "staged.txt"]));
    expect(diff).toMatchObject({ left: "staged 1\n", right: "staged 2\n", status: "modified" });
  });

  it("review: a path out of the index but back on disk is the left blob against the file", async () => {
    const diff = await diffed(feature, { kind: "review", path: "back.txt" });
    const blob = fx.outsidePath("back-blob.txt");
    writeFileSync(blob, show(feature.path, `${start}:back.txt`));
    try {
      expect(diff.hunks).toEqual(
        gitHunks(feature.path, ["--no-index", "--", blob, "back.txt"], [1]),
      );
    } finally {
      rmSync(blob);
    }
    expect(diff).toMatchObject({
      status: "modified",
      left: BACK,
      right: `${BACK}edited on disk\n`,
      stats: { added: 1, removed: 0 },
    });
  });

  it("review: a copy whose source came back on disk diffs from the source", async () => {
    const diff = await diffed(feature, { kind: "review", path: "renamed-back.txt" });
    expect(diff).toMatchObject({
      path: "renamed-back.txt",
      oldPath: "rename-back.txt",
      status: "copied",
      left: COMES_BACK,
      right: `${COMES_BACK}renamed\n`,
      stats: { added: 1, removed: 0 },
    });
    expect(diff.hunks).toEqual(
      gitHunks(feature.path, [
        "--find-renames",
        start,
        "--",
        "rename-back.txt",
        "renamed-back.txt",
      ]),
    );
  });

  it("untracked symlinks: the link's target text, even for a link to a folder", async () => {
    for (const [path, target] of [
      ["keep-link", "keep.txt"],
      ["dir-link", "dir"],
    ] as const) {
      const diff = await diffed(feature, { kind: "review", path });
      expect(diff, path).toMatchObject({ status: "untracked", left: "", right: target });
      expect(diff.hunks, path).toEqual([
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          header: "@@ -0,0 +1 @@",
          lines: [
            { kind: "add", text: target, oldNo: null, newNo: 1 },
            { kind: "noNewline", text: "No newline at end of file", oldNo: null, newNo: null },
          ],
        },
      ]);
    }
  });

  it("echoes the resultHash of the comparison's list", async () => {
    const listed = await client.call<ComparisonResult>("comparison.list", {
      checkoutPath: feature.path,
      kind: "review",
    });
    if (!listed.ok) throw new Error(listed.error.message);
    for (const file of listed.value.files) {
      if (file.path === "escape") continue;
      const diff = await diffed(feature, { kind: "review", path: file.path });
      expect(diff.resultHash, file.path).toBe(file.resultHash);
      expect(diff.status, file.path).toBe(file.status);
      expect(diff.oldPath, file.path).toBe(file.oldPath);
    }
  });
});

describe("diff.file in a checkout without commits", () => {
  it("diffs from nothing: the empty tree for review, an unborn HEAD for staged", async () => {
    const results = [
      await diffed(empty, { kind: "review", path: "e.txt" }),
      await diffed(empty, { kind: "working", path: "e.txt", category: "staged" }),
      await diffed(empty, { kind: "review", path: "f.txt" }),
    ];
    for (const diff of results) {
      expect(diff).toMatchObject({ left: "", stats: { added: 1, removed: 0 } });
      expect(diff.hunks).toHaveLength(1);
    }
    expect(results.map((diff) => [diff.status, diff.right])).toEqual([
      ["added", "e\n"],
      ["added", "e\n"],
      ["untracked", "f\n"],
    ]);
  });
});

describe("diff.file on a conflicted path", () => {
  it("answers for every entry the working list holds, without a blob for the index side", async () => {
    const listed = await client.call<ComparisonResult>("comparison.list", {
      checkoutPath: conflict.path,
      kind: "working",
    });
    if (!listed.ok) throw new Error(listed.error.message);
    const entries = listed.value.files.filter((file) => file.path === "c.txt");
    expect(entries.length).toBeGreaterThan(0);
    for (const file of entries) {
      const diff = await diffed(conflict, {
        kind: "working",
        path: file.path,
        ...(file.category === undefined ? {} : { category: file.category }),
      });
      expect(diff.path).toBe("c.txt");
      if (file.category === "unstaged") {
        expect(diff.right).toBe(readFileSync(join(conflict.path, "c.txt"), "utf8"));
      }
    }
  });
});

describe("diff.file refuses what it cannot trust", () => {
  it("rejects a checkout outside the scan with notInScan", async () => {
    for (const checkoutPath of [fx.outside, fx.root, join(feature.path, "dir"), "relative"]) {
      const result = await client.call("diff.file", {
        requestId: `outside-${checkoutPath}`,
        checkoutPath,
        comparison: { kind: "review" },
        path: "edit.txt",
      });
      expect(result, checkoutPath).toMatchObject({ ok: false, error: { code: "notInScan" } });
    }
  });

  it("rejects absolute paths, .. segments and symlinks out of the checkout with notInScan", async () => {
    for (const path of [
      "../app/keep.txt",
      "dir/../../app/keep.txt",
      "..",
      "/etc/passwd",
      fx.outsidePath("secret.txt"),
      "escape",
    ]) {
      expect(await diffFile(feature, { kind: "review", path }), path).toMatchObject({
        ok: false,
        error: { code: "notInScan" },
      });
    }
    // `escape` is listed (an untracked link), and still refused: it resolves outside.
    const listed = await client.call<ComparisonResult>("comparison.list", {
      checkoutPath: feature.path,
      kind: "review",
    });
    expect(listed.ok && listed.value.files.some((file) => file.path === "escape")).toBe(true);
  });

  it("rejects malformed paths and wrong categories with invalidRequest", async () => {
    for (const path of ["dir//inner.txt", "./edit.txt", "edit.txt/", "a\0b"]) {
      expect(await diffFile(feature, { kind: "review", path }), path).toMatchObject({
        ok: false,
        error: { code: "invalidRequest" },
      });
    }
    expect(await diffFile(feature, { kind: "working", path: "staged.txt" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(
      await diffFile(feature, { kind: "review", path: "staged.txt", category: "staged" }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });

  it("takes nothing but the path from the request: a file the list lacks is refused", async () => {
    for (const request of [
      { kind: "worktree", path: "keep.txt" },
      { kind: "worktree", path: "staged.txt" },
      { kind: "working", path: "staged.txt", category: "unstaged" },
      { kind: "review", path: "no/such/file.txt" },
    ] as const) {
      expect(await diffFile(feature, request), JSON.stringify(request)).toMatchObject({
        ok: false,
        error: { code: "invalidRequest", detail: { notInComparison: true } },
      });
    }
  });

  it("refuses a comparison the checkout cannot have, as comparison.list does", async () => {
    expect(await diffFile(app, { kind: "upstream", path: "edit.txt" })).toMatchObject({
      ok: false,
      error: { code: "refNotFound", detail: { unavailable: "noUpstream" } },
    });
    for (const ref of ["-x", "--output=/tmp/treepeek-pwned"]) {
      expect(await diffFile(feature, { kind: "base", ref, path: "edit.txt" }), ref).toMatchObject({
        ok: false,
        error: { code: "invalidRequest" },
      });
    }
  });

  it("refuses extra fields and unbounded strings before any handler runs", async () => {
    for (const payload of [
      { requestId: "x", checkoutPath: feature.path, comparison: { kind: "review" } },
      {
        requestId: "x",
        checkoutPath: feature.path,
        comparison: { kind: "review", left: { kind: "empty" } },
        path: "edit.txt",
      },
      {
        requestId: "x",
        checkoutPath: feature.path,
        comparison: { kind: "review" },
        path: "edit.txt",
        leftOid: "0".repeat(40),
      },
      {
        requestId: "x",
        checkoutPath: feature.path,
        // `sinceViewed` is one file's comparison: it takes no ref.
        comparison: { kind: "sinceViewed", ref: "main" },
        path: "edit.txt",
      },
      {
        requestId: "x",
        checkoutPath: feature.path,
        comparison: { kind: "review" },
        path: "a".repeat(5000),
      },
    ]) {
      expect(await client.call("diff.file", payload), JSON.stringify(payload)).toMatchObject({
        ok: false,
        error: { code: "invalidRequest" },
      });
    }
  });
});

describe("checkRepoPath", () => {
  it("tells escaping paths from malformed ones", () => {
    expect(checkRepoPath("src/a.ts")).toBeNull();
    expect(checkRepoPath("a..b/..c")).toBeNull();
    expect(checkRepoPath("line\nbreak.txt")).toBeNull();
    expect(checkRepoPath("/abs")).toBe("escapes");
    expect(checkRepoPath("a/../b")).toBe("escapes");
    expect(checkRepoPath("a//b")).toBe("malformed");
    expect(checkRepoPath("./a")).toBe("malformed");
    expect(checkRepoPath("a/")).toBe("malformed");
    expect(checkRepoPath("")).toBe("malformed");
    expect(checkRepoPath("a\0b")).toBe("malformed");
  });
});
