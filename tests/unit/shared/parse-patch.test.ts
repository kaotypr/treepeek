import { afterAll, describe, expect, it } from "vitest";
import { type ParsedPatch, parsePatch } from "../../../src/shared/diff/parse-patch";
import type { Hunk } from "../../../src/shared/domain";
import {
  commitAll,
  gitIn,
  makeTempRepo,
  removeTempRepos,
  type TempRepo,
  writeRepoFile,
} from "../../support/git";

afterAll(removeTempRepos);

/** The flags the git service uses for one file's patch (git-service commands). */
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3"];

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`);
}

function lf(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

/** A file's lines as the patch numbers them: split on LF, so a CR stays in its line. */
function fileLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

interface GitHunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
}

/** The hunk headers in a patch, read independently of the parser. */
function gitHunkHeaders(patch: string): GitHunkHeader[] {
  const headers: GitHunkHeader[] = [];
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    headers.push({
      oldStart: Number(match[1]),
      oldLines: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newLines: Number(match[4] ?? 1),
      header: line,
    });
  }
  return headers;
}

function headerOf(hunk: Hunk): GitHunkHeader {
  const { oldStart, oldLines, newStart, newLines, header } = hunk;
  return { oldStart, oldLines, newStart, newLines, header };
}

/**
 * The parsed hunks carry git's hunk headers, their lines add up to the header counts, the
 * line numbers run on from each header's start, and every numbered line is the line at
 * that number in the real old and new file.
 */
function expectMatchesGit(
  parsed: ParsedPatch,
  patch: string,
  oldText: string,
  newText: string,
): void {
  expect(parsed.hunks.map(headerOf)).toEqual(gitHunkHeaders(patch));
  const oldFile = fileLines(oldText);
  const newFile = fileLines(newText);
  for (const hunk of parsed.hunks) {
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let oldCount = 0;
    let newCount = 0;
    for (const line of hunk.lines) {
      switch (line.kind) {
        case "context":
          expect(line).toEqual({ kind: "context", text: line.text, oldNo, newNo });
          expect(oldFile[oldNo - 1]).toBe(line.text);
          expect(newFile[newNo - 1]).toBe(line.text);
          oldNo += 1;
          newNo += 1;
          oldCount += 1;
          newCount += 1;
          break;
        case "remove":
          expect(line).toEqual({ kind: "remove", text: line.text, oldNo, newNo: null });
          expect(oldFile[oldNo - 1]).toBe(line.text);
          oldNo += 1;
          oldCount += 1;
          break;
        case "add":
          expect(line).toEqual({ kind: "add", text: line.text, oldNo: null, newNo });
          expect(newFile[newNo - 1]).toBe(line.text);
          newNo += 1;
          newCount += 1;
          break;
        case "noNewline":
          expect(line).toEqual({
            kind: "noNewline",
            text: "No newline at end of file",
            oldNo: null,
            newNo: null,
          });
          break;
      }
    }
    expect(oldCount).toBe(hunk.oldLines);
    expect(newCount).toBe(hunk.newLines);
  }
}

function kinds(hunk: Hunk | undefined): string[] {
  return hunk?.lines.map((line) => line.kind) ?? [];
}

/** Commits `before` at `path`, writes `after` to the working tree, and returns the patch. */
function workingPatch(repo: TempRepo, path: string, before: string, after: string): string {
  writeRepoFile(repo, path, before);
  commitAll(repo, "before");
  writeRepoFile(repo, path, after);
  return gitIn(repo, [...DIFF, "--", path]);
}

function similarityIn(patch: string): number {
  const match = /^similarity index (\d+)%$/m.exec(patch);
  return Number(match?.[1]);
}

describe("parsePatch", () => {
  it("returns an empty result for an empty patch", () => {
    expect(parsePatch("")).toEqual({
      hunks: [],
      stats: { added: 0, removed: 0 },
      binary: false,
      operation: "modified",
      truncated: false,
    });
  });

  it("parses an ordinary hunk", () => {
    const repo = makeTempRepo();
    const before = lf(numbered(10));
    const afterLines = numbered(10);
    afterLines[4] = "line 5, changed";
    const after = lf(afterLines);
    const patch = workingPatch(repo, "file.txt", before, after);

    const parsed = parsePatch(patch);

    expect(parsed).toMatchObject({
      oldPath: "file.txt",
      newPath: "file.txt",
      oldMode: "100644",
      newMode: "100644",
      binary: false,
      operation: "modified",
      truncated: false,
      stats: { added: 1, removed: 1 },
    });
    expect(parsed.similarity).toBeUndefined();
    expect(parsed.hunks).toHaveLength(1);
    expect(kinds(parsed.hunks[0])).toEqual([
      "context",
      "context",
      "context",
      "remove",
      "add",
      "context",
      "context",
      "context",
    ]);
    expectMatchesGit(parsed, patch, before, after);
  });

  it("parses several hunks in one file", () => {
    const repo = makeTempRepo();
    const beforeLines = numbered(60);
    const before = lf(beforeLines);
    const afterLines = [...beforeLines];
    afterLines[4] = "line 5, changed";
    afterLines.splice(30, 0, "inserted A", "inserted B");
    afterLines.splice(56, 1); // removes "line 55"
    const after = lf(afterLines);
    const patch = workingPatch(repo, "many.txt", before, after);

    const parsed = parsePatch(patch);

    expect(gitHunkHeaders(patch)).toHaveLength(3);
    expect(parsed.hunks).toHaveLength(3);
    expect(parsed.stats).toEqual({ added: 3, removed: 2 });
    expect(parsed.truncated).toBe(false);
    expectMatchesGit(parsed, patch, before, after);
  });

  it("recognizes binary files", () => {
    const repo = makeTempRepo();
    writeRepoFile(repo, "image.bin", Uint8Array.from([0, 1, 2, 3, 0, 255]));
    commitAll(repo, "binary");
    writeRepoFile(repo, "image.bin", Uint8Array.from([0, 9, 8, 7, 0, 254, 0]));
    const modified = gitIn(repo, [...DIFF, "--", "image.bin"]);

    expect(modified).toContain("Binary files a/image.bin and b/image.bin differ");
    expect(parsePatch(modified)).toEqual({
      hunks: [],
      stats: { added: 0, removed: 0 },
      binary: true,
      oldPath: "image.bin",
      newPath: "image.bin",
      oldMode: "100644",
      newMode: "100644",
      operation: "modified",
      truncated: false,
    });

    writeRepoFile(repo, "new.bin", Uint8Array.from([0, 0, 1]));
    gitIn(repo, ["add", "new.bin"]);
    const added = gitIn(repo, [...DIFF, "--cached", "--", "new.bin"]);

    expect(added).toContain("Binary files /dev/null and b/new.bin differ");
    const parsedAdded = parsePatch(added);
    expect(parsedAdded).toMatchObject({ binary: true, newPath: "new.bin", operation: "added" });
    expect(parsedAdded.oldPath).toBeUndefined();
    expect(parsedAdded.hunks).toEqual([]);
  });

  describe("\\ No newline at end of file", () => {
    it("on the old side", () => {
      const repo = makeTempRepo();
      const before = "a\nb\nc";
      const after = "a\nb\nc\n";
      const patch = workingPatch(repo, "f.txt", before, after);

      const parsed = parsePatch(patch);

      expect(kinds(parsed.hunks[0])).toEqual(["context", "context", "remove", "noNewline", "add"]);
      expect(parsed.stats).toEqual({ added: 1, removed: 1 });
      expectMatchesGit(parsed, patch, before, after);
    });

    it("on the new side", () => {
      const repo = makeTempRepo();
      const before = "a\nb\nc\n";
      const after = "a\nb\nc";
      const patch = workingPatch(repo, "f.txt", before, after);

      const parsed = parsePatch(patch);

      expect(kinds(parsed.hunks[0])).toEqual(["context", "context", "remove", "add", "noNewline"]);
      expectMatchesGit(parsed, patch, before, after);
    });

    it("on both sides", () => {
      const repo = makeTempRepo();
      const before = "a\nb\nc";
      const after = "a\nb\nC";
      const patch = workingPatch(repo, "f.txt", before, after);

      const parsed = parsePatch(patch);

      expect(kinds(parsed.hunks[0])).toEqual([
        "context",
        "context",
        "remove",
        "noNewline",
        "add",
        "noNewline",
      ]);
      expectMatchesGit(parsed, patch, before, after);
    });
  });

  describe("renames and copies", () => {
    it("reads a rename with changes and its similarity", () => {
      const repo = makeTempRepo();
      const beforeLines = numbered(20);
      const before = lf(beforeLines);
      writeRepoFile(repo, "old name.txt", before);
      commitAll(repo, "before");
      gitIn(repo, ["rm", "--quiet", "old name.txt"]);
      const afterLines = [...beforeLines];
      afterLines[9] = "line 10, changed";
      const after = lf(afterLines);
      writeRepoFile(repo, "moved/new name.txt", after);
      commitAll(repo, "rename");
      const patch = gitIn(repo, [
        ...DIFF,
        "--find-renames",
        "HEAD~1",
        "HEAD",
        "--",
        "old name.txt",
        "moved/new name.txt",
      ]);

      const parsed = parsePatch(patch);

      expect(patch).toContain("rename from old name.txt");
      expect(parsed).toMatchObject({
        oldPath: "old name.txt",
        newPath: "moved/new name.txt",
        operation: "renamed",
        similarity: similarityIn(patch),
        stats: { added: 1, removed: 1 },
      });
      expect(parsed.similarity).toBeGreaterThan(50);
      expect(parsed.similarity).toBeLessThan(100);
      expectMatchesGit(parsed, patch, before, after);
    });

    it("reads a pure rename with no hunks", () => {
      const repo = makeTempRepo();
      writeRepoFile(repo, "a.txt", lf(numbered(5)));
      commitAll(repo, "before");
      gitIn(repo, ["mv", "a.txt", "b.txt"]);
      const patch = gitIn(repo, [...DIFF, "--find-renames", "--cached"]);

      expect(parsePatch(patch)).toEqual({
        hunks: [],
        stats: { added: 0, removed: 0 },
        binary: false,
        oldPath: "a.txt",
        newPath: "b.txt",
        similarity: 100,
        operation: "renamed",
        truncated: false,
      });
    });

    it("reads a copy and its similarity", () => {
      const repo = makeTempRepo();
      const beforeLines = numbered(20);
      const before = lf(beforeLines);
      writeRepoFile(repo, "source.txt", before);
      commitAll(repo, "before");
      const copyLines = [...beforeLines];
      copyLines[0] = "line 1 of the copy";
      const after = lf(copyLines);
      writeRepoFile(repo, "copy.txt", after);
      gitIn(repo, ["add", "copy.txt"]);
      const patch = gitIn(repo, [...DIFF, "--cached", "--find-copies-harder"]);

      const parsed = parsePatch(patch);

      expect(patch).toContain("copy from source.txt");
      expect(parsed).toMatchObject({
        oldPath: "source.txt",
        newPath: "copy.txt",
        operation: "copied",
        similarity: similarityIn(patch),
      });
      expect(parsed.similarity).toBeGreaterThan(50);
      expectMatchesGit(parsed, patch, before, after);
    });
  });

  it("reads a mode-only change", () => {
    const repo = makeTempRepo();
    writeRepoFile(repo, "tools/run me.sh", "echo hi\n");
    commitAll(repo, "script");
    gitIn(repo, ["update-index", "--chmod=+x", "tools/run me.sh"]);
    const patch = gitIn(repo, [...DIFF, "--cached", "--", "tools/run me.sh"]);

    expect(patch).not.toContain("@@");
    expect(parsePatch(patch)).toEqual({
      hunks: [],
      stats: { added: 0, removed: 0 },
      binary: false,
      oldPath: "tools/run me.sh",
      newPath: "tools/run me.sh",
      oldMode: "100644",
      newMode: "100755",
      operation: "modified",
      truncated: false,
    });
  });

  describe("added and deleted files", () => {
    it("reads an added file", () => {
      const repo = makeTempRepo();
      commitAll(repo, "empty");
      const content = "one\ntwo\nthree\n";
      writeRepoFile(repo, "new.txt", content);
      gitIn(repo, ["add", "new.txt"]);
      const patch = gitIn(repo, [...DIFF, "--cached", "--", "new.txt"]);

      const parsed = parsePatch(patch);

      expect(parsed).toMatchObject({
        newPath: "new.txt",
        newMode: "100644",
        operation: "added",
        stats: { added: 3, removed: 0 },
      });
      expect(parsed.oldPath).toBeUndefined();
      expect(parsed.oldMode).toBeUndefined();
      expect(parsed.hunks.map(headerOf)[0]).toMatchObject({
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
      });
      expectMatchesGit(parsed, patch, "", content);
    });

    it("reads an untracked file diffed against /dev/null", () => {
      const repo = makeTempRepo();
      const content = "fresh\nfile\n";
      writeRepoFile(repo, "untracked.txt", content);
      const patch = gitIn(repo, [...DIFF, "--no-index", "--", "/dev/null", "untracked.txt"], {
        okExitCodes: [1],
      });

      const parsed = parsePatch(patch);

      expect(parsed).toMatchObject({
        newPath: "untracked.txt",
        operation: "added",
        stats: { added: 2, removed: 0 },
      });
      expect(parsed.oldPath).toBeUndefined();
      expectMatchesGit(parsed, patch, "", content);
    });

    it("reads an added empty file", () => {
      const repo = makeTempRepo();
      commitAll(repo, "empty");
      writeRepoFile(repo, "empty.txt", "");
      gitIn(repo, ["add", "empty.txt"]);
      const patch = gitIn(repo, [...DIFF, "--cached", "--", "empty.txt"]);

      const parsed = parsePatch(patch);

      expect(parsed).toMatchObject({ newPath: "empty.txt", newMode: "100644", operation: "added" });
      expect(parsed.oldPath).toBeUndefined();
      expect(parsed.hunks).toEqual([]);
    });

    it("reads a deleted file", () => {
      const repo = makeTempRepo();
      const content = "going\naway\n";
      writeRepoFile(repo, "doomed.txt", content);
      commitAll(repo, "before");
      gitIn(repo, ["rm", "--quiet", "doomed.txt"]);
      const patch = gitIn(repo, [...DIFF, "--cached", "--", "doomed.txt"]);

      const parsed = parsePatch(patch);

      expect(parsed).toMatchObject({
        oldPath: "doomed.txt",
        oldMode: "100644",
        operation: "deleted",
        stats: { added: 0, removed: 2 },
      });
      expect(parsed.newPath).toBeUndefined();
      expect(parsed.newMode).toBeUndefined();
      expectMatchesGit(parsed, patch, content, "");
    });
  });

  describe("non-ASCII and CRLF content", () => {
    const path = "naïve/café 日本.txt";
    const before = "héllo\nwörld 🎉\n日本語\n";
    const after = "héllo\nwörld 🎊 ünïcode\n日本語\n";

    it("reads non-ASCII paths quoted by git and non-ASCII content", () => {
      const repo = makeTempRepo();
      const patch = workingPatch(repo, path, before, after);

      const parsed = parsePatch(patch);

      expect(patch).toContain('--- "a/na\\303\\257ve/');
      expect(parsed).toMatchObject({
        oldPath: path,
        newPath: path,
        stats: { added: 1, removed: 1 },
      });
      expectMatchesGit(parsed, patch, before, after);
    });

    it("reads non-ASCII paths with core.quotePath=false", () => {
      const repo = makeTempRepo();
      writeRepoFile(repo, path, before);
      commitAll(repo, "before");
      writeRepoFile(repo, path, after);
      const patch = gitIn(repo, ["-c", "core.quotePath=false", ...DIFF, "--", path]);

      const parsed = parsePatch(patch);

      expect(patch).toContain(`--- a/${path}`);
      expect(parsed).toMatchObject({ oldPath: path, newPath: path });
      expectMatchesGit(parsed, patch, before, after);
    });

    it("keeps the CR of CRLF lines", () => {
      const repo = makeTempRepo();
      const crlfBefore = "one\r\ntwo\r\nthree\r\n";
      const crlfAfter = "one\r\nTWO\r\nthree\r\n";
      const patch = workingPatch(repo, "dos.txt", crlfBefore, crlfAfter);

      const parsed = parsePatch(patch);

      expect(parsed.hunks[0]?.lines).toEqual([
        { kind: "context", text: "one\r", oldNo: 1, newNo: 1 },
        { kind: "remove", text: "two\r", oldNo: 2, newNo: null },
        { kind: "add", text: "TWO\r", oldNo: null, newNo: 2 },
        { kind: "context", text: "three\r", oldNo: 3, newNo: 3 },
      ]);
      expectMatchesGit(parsed, patch, crlfBefore, crlfAfter);
    });

    it("shows a line-ending-only change", () => {
      const repo = makeTempRepo();
      const lfText = "one\ntwo\nthree\n";
      const mixed = "one\ntwo\r\nthree\n";
      const patch = workingPatch(repo, "eol.txt", lfText, mixed);

      const parsed = parsePatch(patch);

      expect(parsed.hunks[0]?.lines.filter((line) => line.kind !== "context")).toEqual([
        { kind: "remove", text: "two", oldNo: 2, newNo: null },
        { kind: "add", text: "two\r", oldNo: null, newNo: 2 },
      ]);
      expectMatchesGit(parsed, patch, lfText, mixed);
    });
  });

  describe("input truncated mid-hunk", () => {
    function twoHunkPatch(): { patch: string; before: string; after: string } {
      const repo = makeTempRepo();
      const beforeLines = numbered(40);
      const before = lf(beforeLines);
      const afterLines = [...beforeLines];
      afterLines[2] = "line 3, changed";
      afterLines[29] = "line 30, changed";
      afterLines[30] = "line 31, changed";
      const after = lf(afterLines);
      return { patch: workingPatch(repo, "cut.txt", before, after), before, after };
    }

    /** The offset just after the `count`-th LF following the second hunk header. */
    function offsetIntoSecondHunk(patch: string, count: number): number {
      let offset = patch.indexOf("\n@@ ", patch.indexOf("\n@@ ") + 1) + 1;
      for (let i = 0; i < count; i += 1) offset = patch.indexOf("\n", offset) + 1;
      return offset;
    }

    it("drops a hunk cut mid-line and marks the result truncated", () => {
      const { patch, before, after } = twoHunkPatch();
      const full = parsePatch(patch);
      expect(full.hunks).toHaveLength(2);

      // The header and two body lines survive, then half of the third body line.
      const cut = patch.slice(0, offsetIntoSecondHunk(patch, 3) + 3);
      const parsed = parsePatch(cut, { truncated: true });

      expect(parsed.truncated).toBe(true);
      expect(parsed.hunks).toEqual(full.hunks.slice(0, 1));
      expect(parsed.stats).toEqual({ added: 1, removed: 1 });
      expect(parsed).toMatchObject({ oldPath: "cut.txt", newPath: "cut.txt" });
      expectMatchesGit(parsed, patch.slice(0, offsetIntoSecondHunk(patch, 0)), before, after);
    });

    it("detects a hunk cut at a line boundary without being told", () => {
      const { patch } = twoHunkPatch();
      const full = parsePatch(patch);

      const parsed = parsePatch(patch.slice(0, offsetIntoSecondHunk(patch, 4)));

      expect(parsed.truncated).toBe(true);
      expect(parsed.hunks).toEqual(full.hunks.slice(0, 1));
    });

    it("drops a last line cut short even when it would complete the hunk", () => {
      const { patch } = twoHunkPatch();
      const full = parsePatch(patch);

      // Cut inside the final context line: its prefix would still satisfy the counts.
      const parsed = parsePatch(patch.slice(0, -3), { truncated: true });

      expect(parsed.truncated).toBe(true);
      expect(parsed.hunks).toEqual(full.hunks.slice(0, 1));
    });

    it("keeps the headers when the first hunk is cut", () => {
      const { patch } = twoHunkPatch();
      const firstHunk = patch.indexOf("\n@@ ") + 1;

      const parsed = parsePatch(patch.slice(0, patch.indexOf("\n", firstHunk) + 4), {
        truncated: true,
      });

      expect(parsed).toMatchObject({
        hunks: [],
        stats: { added: 0, removed: 0 },
        oldPath: "cut.txt",
        newPath: "cut.txt",
        truncated: true,
      });
    });

    it("keeps every complete hunk when the cut falls after the last one", () => {
      const { patch } = twoHunkPatch();
      const full = parsePatch(patch);

      const parsed = parsePatch(patch, { truncated: true });

      expect(parsed.truncated).toBe(true);
      expect(parsed.hunks).toEqual(full.hunks);
    });
  });
});
