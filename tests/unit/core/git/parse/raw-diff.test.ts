import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitParseError } from "../../../../../src/core/git/errors";
import { parseRawDiff } from "../../../../../src/core/git/parse/raw-diff";
import { resetGitRuntime, setTestGit } from "../../../../support/core-git";
import { type Fixture, type FixtureRepo, fixture } from "../../../../support/git-fixture";
import { git } from "./helpers";

const RAW = ["diff", "--raw", "-z", "--find-renames", "--abbrev=40"];
const ZERO = "0".repeat(40);
const LONG_TEXT = Array.from({ length: 40 }, (_, index) => `line ${index}\n`).join("");
// Different from LONG_TEXT, so Git cannot pair the copy with the renamed file instead.
const COPY_TEXT = Array.from({ length: 40 }, (_, index) => `copy ${index}\n`).join("");

let fx: Fixture;
let app: FixtureRepo;
let left: string;
let right: string;

beforeAll(() => {
  setTestGit();
  fx = fixture();
  app = fx.repo("app").commit({
    "modified.txt": "1\n",
    "deleted.txt": "gone\n",
    "renamed from.txt": LONG_TEXT,
    "mode.sh": "echo\n",
    "type.txt": "a file\n",
    "copy source.txt": COPY_TEXT,
  });
  left = app.head();
  app.rename("renamed from.txt", "dir/renamed to é.txt");
  app.commit({
    "modified.txt": "2\n",
    "deleted.txt": null,
    "dir/renamed to é.txt": `${LONG_TEXT}one more\n`,
    "mode.sh": { content: "echo\n", executable: true },
    "type.txt": { symlink: "modified.txt" },
    "added\nnewline.txt": "new\n",
    "binary.bin": new Uint8Array([0, 1, 2, 0, 255]),
    "copy target.txt": COPY_TEXT,
  });
  right = app.head();
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

function blob(ref: string, path: string): string {
  return app.rev(`${ref}:${path}`);
}

describe("parseRawDiff", () => {
  it("reads every status with both modes, both ids and the paths", async () => {
    const entries = parseRawDiff(await git(app.path, [...RAW, left, right]));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("modified.txt")).toEqual({
      status: "M",
      oldMode: "100644",
      newMode: "100644",
      oldOid: blob(left, "modified.txt"),
      newOid: blob(right, "modified.txt"),
      path: "modified.txt",
    });
    expect(byPath.get("deleted.txt")).toMatchObject({
      status: "D",
      newMode: "000000",
      newOid: ZERO,
      oldOid: blob(left, "deleted.txt"),
    });
    expect(byPath.get("added\nnewline.txt")).toMatchObject({
      status: "A",
      oldMode: "000000",
      oldOid: ZERO,
    });
    expect(byPath.get("binary.bin")).toMatchObject({
      status: "A",
      newOid: blob(right, "binary.bin"),
    });
    expect(byPath.get("dir/renamed to é.txt")).toMatchObject({
      status: "R",
      oldPath: "renamed from.txt",
      oldOid: blob(left, "renamed from.txt"),
      newOid: blob(right, "dir/renamed to é.txt"),
    });
    const score = byPath.get("dir/renamed to é.txt")?.score ?? 0;
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThan(100);
    expect(byPath.get("mode.sh")).toMatchObject({
      status: "M",
      oldMode: "100644",
      newMode: "100755",
    });
    expect(byPath.get("type.txt")).toMatchObject({
      status: "T",
      oldMode: "100644",
      newMode: "120000",
    });
    expect(byPath.get("copy target.txt")).toMatchObject({ status: "A" });
    expect(entries).toHaveLength(8);
  });

  it("reads copies when Git is asked to find them", async () => {
    const entries = parseRawDiff(
      await git(app.path, [...RAW, "--find-copies-harder", left, right]),
    );
    expect(entries.find((entry) => entry.path === "copy target.txt")).toMatchObject({
      status: "C",
      oldPath: "copy source.txt",
      score: 100,
    });
  });

  it("gives a working-tree side an all-zero id", async () => {
    app.write({ "modified.txt": "3\n", "binary.bin": null });
    try {
      const entries = parseRawDiff(await git(app.path, [...RAW, right]));
      expect(entries).toEqual([
        expect.objectContaining({ status: "D", path: "binary.bin", newOid: ZERO }),
        expect.objectContaining({
          status: "M",
          path: "modified.txt",
          oldOid: blob(right, "modified.txt"),
          newOid: ZERO,
        }),
      ]);
    } finally {
      app.git(["checkout", "--quiet", "--", "."]);
    }
  });

  it("reads an empty diff, and full ids with --no-abbrev", async () => {
    expect(parseRawDiff(await git(app.path, [...RAW, right, right]))).toEqual([]);
    const full = parseRawDiff(
      await git(app.path, ["diff", "--raw", "-z", "--no-abbrev", left, right]),
    );
    expect(full.every((entry) => entry.oldOid.length === 40 && entry.newOid.length === 40)).toBe(
      true,
    );
  });

  it("rejects output it does not understand", () => {
    expect(() => parseRawDiff(":100644 100644 abc def M\0")).toThrow(GitParseError);
    expect(() => parseRawDiff(":100644 100644 abc def M\0a")).toThrow(GitParseError);
    expect(() => parseRawDiff("::100644 100644 100644 a b c MM\0x\0")).toThrow(GitParseError);
    expect(() => parseRawDiff(":100644 100644 abc def R100\0only-one\0")).toThrow(GitParseError);
  });
});
