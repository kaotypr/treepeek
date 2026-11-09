/**
 * Writes `FileDiff` fixtures for the diff viewer, made with real git.
 *
 *   bun scripts/make-diff-fixtures.ts                      small fixtures → tests/fixtures/diffs/
 *   bun scripts/make-diff-fixtures.ts --large [--out DIR]  big-20k and patch-50k → DIR
 *                                                          (a new temporary folder by default)
 *
 * Each fixture is one file changed between two commits of a throwaway repository. The patch
 * comes from `git diff` with the flags the core service will use, goes through the shared
 * `parsePatch`, and the full texts come from `git cat-file`, so a fixture is what the diff
 * pipeline will hand the renderer. Output is deterministic: running the script twice
 * writes identical files. The large fixtures (over 1 MB each) are not committed; tests
 * generate them.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DIFF_LIMITS } from "../src/shared/constants";
import { parsePatch } from "../src/shared/diff/parse-patch";
import type { FileStatus } from "../src/shared/domain/compare";
import type { FileDiff } from "../src/shared/domain/diff";
import {
  commitAll,
  gitIn,
  makeTempRepo,
  removeTempRepos,
  type TempRepo,
  writeRepoFile,
} from "../tests/support/git";

const root = resolve(import.meta.dirname, "..");
export const SMALL_FIXTURE_DIR = join(root, "tests/fixtures/diffs");

type Content = string | Uint8Array;

interface FixtureSpec {
  name: string;
  /** Files of the first commit. */
  before: Readonly<Record<string, Content>>;
  /** Files of the second commit (the whole tree: anything missing is deleted). */
  after: Readonly<Record<string, Content>>;
  /** Paths made executable in the second commit. */
  executableAfter?: readonly string[];
}

/** Git flags the core service passes for a file's patch (git-service design, "Content"). */
const DIFF_ARGS = [
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.external=",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--find-renames",
  "HEAD~1",
  "HEAD",
] as const;

export function buildFixture(spec: FixtureSpec): FileDiff {
  const repo = makeTempRepo();
  writeTree(repo, spec.before);
  commitAll(repo, "before");
  for (const path of Object.keys(spec.before)) rmSync(join(repo.path, path));
  writeTree(repo, spec.after);
  for (const path of spec.executableAfter ?? []) chmodSync(join(repo.path, path), 0o755);
  commitAll(repo, "after");
  return toFileDiff(repo, gitIn(repo, DIFF_ARGS));
}

function writeTree(repo: TempRepo, files: Readonly<Record<string, Content>>): void {
  for (const [path, content] of Object.entries(files)) writeRepoFile(repo, path, content);
}

const STATUS: Record<ReturnType<typeof parsePatch>["operation"], FileStatus> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
};

/** Assembles the `FileDiff` the diff pipeline returns, applying `DIFF_LIMITS`. */
function toFileDiff(repo: TempRepo, fullPatch: string): FileDiff {
  const patchTruncated = Buffer.byteLength(fullPatch) > DIFF_LIMITS.patchBytes;
  const patch = patchTruncated
    ? Buffer.from(fullPatch).subarray(0, DIFF_LIMITS.patchBytes).toString("utf8")
    : fullPatch;
  const parsed = parsePatch(patch, { truncated: patchTruncated });
  const path = parsed.newPath ?? parsed.oldPath;
  if (path === undefined) throw new Error("The patch names no file");
  const status = STATUS[parsed.operation];

  const leftOid = parsed.oldPath === undefined ? null : blobId(repo, "HEAD~1", parsed.oldPath);
  const rightOid = parsed.newPath === undefined ? null : blobId(repo, "HEAD", parsed.newPath);

  let left: string | null = leftOid === null ? "" : catBlob(repo, leftOid);
  let right: string | null = rightOid === null ? "" : catBlob(repo, rightOid);
  const contentOmitted =
    !parsed.binary &&
    (overLimit(left, DIFF_LIMITS.contentBytes, DIFF_LIMITS.contentLines) ||
      overLimit(right, DIFF_LIMITS.contentBytes, DIFF_LIMITS.contentLines));
  const highlightOff =
    !parsed.binary &&
    (overLimit(left, DIFF_LIMITS.highlightBytes, DIFF_LIMITS.highlightLines) ||
      overLimit(right, DIFF_LIMITS.highlightBytes, DIFF_LIMITS.highlightLines));
  if (parsed.binary || contentOmitted) {
    left = null;
    right = null;
  }

  const diff: FileDiff = {
    path,
    status,
    binary: parsed.binary,
    hunks: parsed.hunks,
    left,
    right,
    stats: parsed.stats,
    limits: { patchTruncated: parsed.truncated, contentOmitted, highlightOff },
    resultHash: rightOid ?? `deleted:${leftOid ?? ""}`,
  };
  if ((status === "renamed" || status === "copied") && parsed.oldPath !== undefined) {
    diff.oldPath = parsed.oldPath;
  }
  return diff;
}

function blobId(repo: TempRepo, commit: string, path: string): string {
  return gitIn(repo, ["rev-parse", `${commit}:${path}`]).trim();
}

function catBlob(repo: TempRepo, oid: string): string {
  return gitIn(repo, ["cat-file", "blob", oid]);
}

function overLimit(text: string | null, bytes: number, lines: number): boolean {
  if (text === null) return false;
  return Buffer.byteLength(text) > bytes || countLines(text) > lines;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count += 1;
  return text.endsWith("\n") ? count - 1 : count;
}

// ---------------------------------------------------------------------------------------
// Fixture contents

function lines(...rows: string[]): string {
  return `${rows.join("\n")}\n`;
}

/** A TypeScript module of `count` small functions, so highlighting has real work to do. */
function tsModule(count: number, edit?: (index: number) => string | null): string {
  const rows: string[] = ['import { strict as assert } from "node:assert";', ""];
  for (let i = 0; i < count; i += 1) {
    const replacement = edit?.(i) ?? null;
    rows.push(
      `/** Returns the ${i}th checksum step. */`,
      `export function step${i}(input: number): number {`,
      replacement ?? `  const value = (input * ${(i % 97) + 3}) % 65_521;`,
      `  assert(value >= 0, "step ${i} went negative");`,
      "  return value;",
      "}",
      "",
    );
  }
  return lines(...rows);
}

const SMALL_EDIT_BEFORE = tsModule(9);
const SMALL_EDIT_AFTER = tsModule(9, (i) =>
  i === 1
    ? "  const value = (input * 5 + 1) % 65_521;"
    : i === 7
      ? "  const value = Math.abs(input * 10) % 65_521;"
      : null,
).replace("export function step4(", "export async function step4(");

const RENAME_BEFORE = lines(
  "export interface Point {",
  "  x: number;",
  "  y: number;",
  "}",
  "",
  "export function distance(a: Point, b: Point): number {",
  "  const dx = a.x - b.x;",
  "  const dy = a.y - b.y;",
  "  return Math.sqrt(dx * dx + dy * dy);",
  "}",
  "",
  "export function midpoint(a: Point, b: Point): Point {",
  "  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };",
  "}",
  "",
  "export const ORIGIN: Point = { x: 0, y: 0 };",
);
const RENAME_AFTER = RENAME_BEFORE.replace(
  "  return Math.sqrt(dx * dx + dy * dy);",
  "  return Math.hypot(dx, dy);",
).replace(
  "export const ORIGIN: Point = { x: 0, y: 0 };",
  "export const ORIGIN: Readonly<Point> = { x: 0, y: 0 };",
);

const ADDED = lines(
  "# Release checklist",
  "",
  "1. Bump the version in `package.json`.",
  "2. Run `bun run lint`, `bun run typecheck` and `bun run test`.",
  "3. Package with `bun run package` and smoke-test the app.",
  "4. Tag the release: `git tag v0.1.0`.",
);

const DELETED = lines(
  "def legacy_sum(values):",
  '    """Kept for the old importer; nothing calls it now."""',
  "    total = 0",
  "    for value in values:",
  "        total += value",
  "    return total",
);

const NO_NEWLINE_BEFORE = "[core]\n\tbare = false\n\tfilemode = true";
const NO_NEWLINE_AFTER = "[core]\n\tbare = false\n\tfilemode = false\n";

const CRLF_BEFORE = "first line\r\nsecond line\r\nthird line\r\nfourth line\r\nfifth line\r\n";
const CRLF_AFTER = "first line\r\nsecond line, edited\r\nthird line\r\nfourth line\nfifth line\r\n";

const UNICODE_BEFORE = lines(
  "{",
  '  "greeting": "Hello",',
  '  "japanese": "こんにちは世界",',
  '  "arabic": "مرحبا بالعالم",',
  '  "combining": "Café",',
  '  "emoji": "🌳 tree 👀 peek",',
  '  "flag": "🇮🇩"',
  "}",
);
const UNICODE_AFTER = UNICODE_BEFORE.replace('"Hello"', '"Halo 👋"')
  .replace("こんにちは世界", "こんばんは世界")
  .replace("🌳 tree 👀 peek", "🌲 tree 🔍 peek 🧑‍💻");

function longLine(seed: number): string {
  const parts: string[] = [];
  for (let i = 0; parts.join(",").length < 2_400; i += 1) {
    parts.push(`{"id":${i},"key":"k${(i * seed) % 1_000}","on":${i % 3 === 0}}`);
  }
  return `export const DATA = [${parts.join(",")}];`;
}
const LONG_BEFORE = lines("// Generated; do not edit.", longLine(7), "export const COUNT = 1;");
const LONG_AFTER = lines("// Generated; do not edit.", longLine(11), "export const COUNT = 2;");

const BINARY_BEFORE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);
const BINARY_AFTER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 2, 0,
]);

const SCRIPT = lines("#!/bin/sh", 'echo "run"');

export const SMALL_FIXTURES: readonly FixtureSpec[] = [
  {
    name: "small-edit",
    before: { "src/checksum.ts": SMALL_EDIT_BEFORE },
    after: { "src/checksum.ts": SMALL_EDIT_AFTER },
  },
  {
    name: "rename-edit",
    before: { "src/geometry.ts": RENAME_BEFORE },
    after: { "src/math/points.ts": RENAME_AFTER },
  },
  { name: "added", before: {}, after: { "docs/RELEASING.md": ADDED } },
  { name: "deleted", before: { "tools/legacy_sum.py": DELETED }, after: {} },
  {
    name: "no-newline",
    before: { "config/settings.ini": NO_NEWLINE_BEFORE },
    after: { "config/settings.ini": NO_NEWLINE_AFTER },
  },
  {
    name: "crlf",
    before: { "notes/windows.txt": CRLF_BEFORE },
    after: { "notes/windows.txt": CRLF_AFTER },
  },
  {
    name: "unicode",
    before: { "i18n/strings.json": UNICODE_BEFORE },
    after: { "i18n/strings.json": UNICODE_AFTER },
  },
  {
    name: "long-lines",
    before: { "src/data.generated.ts": LONG_BEFORE },
    after: { "src/data.generated.ts": LONG_AFTER },
  },
  {
    name: "binary",
    before: { "assets/logo.png": BINARY_BEFORE },
    after: { "assets/logo.png": BINARY_AFTER },
  },
  {
    name: "mode-only",
    before: { "scripts/run.sh": SCRIPT },
    after: { "scripts/run.sh": SCRIPT },
    executableAfter: ["scripts/run.sh"],
  },
];

/** Just under 20,000 lines a side (the highlighting limit), with 41 scattered one-line edits. */
function big20k(): FixtureSpec {
  const functions = 2_856;
  const edited = (i: number): string | null =>
    i % 71 === 13 ? `  const value = (input ^ ${i}) % 65_521; // changed` : null;
  return {
    name: "big-20k",
    before: { "src/big.ts": tsModule(functions) },
    after: { "src/big.ts": tsModule(functions, edited) },
  };
}

/** Every one of 25,000 lines rewritten: a 50,000-line patch, past the highlighting limit. */
function patch50k(): FixtureSpec {
  const side = (version: number): string => {
    const rows: string[] = [];
    for (let i = 0; i < 25_000; i += 1) {
      rows.push(
        `export const ROW_${i} = { version: ${version}, weight: ${(i * 37 + version) % 1_000} };`,
      );
    }
    return lines(...rows);
  };
  return {
    name: "patch-50k",
    before: { "src/rows.ts": side(1) },
    after: { "src/rows.ts": side(2) },
  };
}

export const LARGE_FIXTURES: readonly (() => FixtureSpec)[] = [big20k, patch50k];

function writeFixtures(specs: readonly FixtureSpec[], dir: string, pretty: boolean): string[] {
  mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  try {
    for (const spec of specs) {
      const diff = buildFixture(spec);
      const json = pretty ? JSON.stringify(diff, null, 2) : JSON.stringify(diff);
      writeFileSync(join(dir, `${spec.name}.json`), `${json}\n`);
      names.push(spec.name);
    }
  } finally {
    removeTempRepos();
  }
  return names;
}

/** Writes the large fixtures and an `index.json` listing them; returns the folder. */
export function writeLargeFixtures(dir?: string): string {
  const out = dir ?? mkdtempSync(join(tmpdir(), "treepeek-diff-fixtures-"));
  const names = writeFixtures(
    LARGE_FIXTURES.map((make) => make()),
    out,
    false,
  );
  writeFileSync(join(out, "index.json"), `${JSON.stringify(names)}\n`);
  return out;
}

function main(argv: readonly string[]): void {
  if (argv.includes("--large")) {
    const at = argv.indexOf("--out");
    const dir = at === -1 ? undefined : argv[at + 1];
    if (at !== -1 && dir === undefined) throw new Error("--out needs a folder");
    console.log(writeLargeFixtures(dir === undefined ? undefined : resolve(dir)));
    return;
  }
  const names = writeFixtures(SMALL_FIXTURES, SMALL_FIXTURE_DIR, true);
  console.log(`Wrote ${names.length} fixtures to ${SMALL_FIXTURE_DIR}`);
}

if (import.meta.main) main(process.argv.slice(2));
