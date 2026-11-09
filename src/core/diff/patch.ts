import { lstat, mkdtemp, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFF_LIMITS, GIT_TIMEOUT_MS } from "../../shared/constants";
import { type ParsedPatch, parsePatch } from "../../shared/diff/parse-patch";
import type { Comparison, FileChange } from "../../shared/domain/compare";
import type { DiffStats } from "../../shared/domain/diff";
import type { RepositoryResources } from "../cache/shared-state";
import { emptyTree } from "../compare/list";
import { GitError } from "../git/errors";
import { runGit } from "../git/run";

export interface PatchContext {
  /** The checkout's real path: every patch command runs there. */
  readonly checkoutPath: string;
  /** The repository's resources: its `cat-file` process reads a left blob when needed. */
  readonly repo: RepositoryResources;
  readonly signal: AbortSignal;
}

/** One file's patch, as Git wrote it, parsed. */
export interface FilePatch {
  /**
   * The `diff --git` sections Git wrote for the file: usually one, two for a type change
   * (Git writes a deletion and an addition), none when the content no longer differs.
   */
  sections: ParsedPatch[];
  /**
   * Git's output passed `DIFF_LIMITS.patchBytes` and was cut there; the sections keep only
   * the hunks that were complete before the cut.
   */
  truncated: boolean;
  /** Lines added and removed across the whole patch (`--numstat`), when it was truncated. */
  stats?: DiffStats;
}

/** One patch command: the arguments around the output format, which `--numstat` swaps. */
interface PatchCommand {
  /** Arguments before the format: the subcommand and its options. */
  readonly options: readonly string[];
  /** Arguments after the format: revisions, `--`, paths. */
  readonly operands: readonly string[];
  /** `diff --no-index`: exit code 1 means "differences". */
  readonly noIndex: boolean;
  /** The path the file's sections are written under (`b/<path>`). */
  readonly path: string;
}

/** Git's default context, as the prototype used and the viewer expects. */
const PATCH_FORMAT = "-U3";
const NUMSTAT_FORMAT = "--numstat";
const DEV_NULL = "/dev/null";
const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t/;

/**
 * The file's patch from the git-service catalogue's content command, run in the checkout:
 *
 * | Change | Command |
 * | --- | --- |
 * | untracked | `diff --no-index -U3 -- /dev/null <path>` |
 * | `working`, staged | `diff --cached --find-renames -U3 [<HEAD>] -- <oldPath> <path>` |
 * | `working`, unstaged | `diff --find-renames -U3 -- <path>` |
 * | commit → commit | `diff --find-renames -U3 <left> <right> -- <oldPath> <path>` |
 * | commit → working tree (`review`) | `diff --find-renames -U3 <left> -- <oldPath> <path>` |
 *
 * `runGit` adds `--no-ext-diff --no-textconv --no-color` and the `a/`/`b/` prefixes, and
 * its environment makes every path a literal name (`GIT_LITERAL_PATHSPECS`), so a name such
 * as `a[1].txt` matches only itself. Output is read up to `DIFF_LIMITS.patchBytes`; past it Git is stopped and the patch is
 * cut at the last whole hunk.
 *
 * An untracked symlink to a folder is the one file `diff --no-index` cannot read as a link
 * (it follows the link and fails), so its one-line patch, the link's target, is written
 * here the way Git writes it for any other link.
 *
 * In `review`, a path the left commit has that is out of the index but back on disk
 * (untracked) is listed as modified, while Git, which reads the working tree through the
 * index, calls it deleted. Its patch compares the left blob, written to a private
 * temporary file, with the file on disk instead (`diff --no-index`).
 */
export async function filePatch(
  ctx: PatchContext,
  comparison: Comparison,
  change: FileChange,
): Promise<FilePatch> {
  if (change.status === "untracked") {
    const link = await linkToFolder(join(ctx.checkoutPath, change.path));
    if (link !== null) return { sections: [addedLinkSection(change.path, link)], truncated: false };
  }
  const command = await patchCommand(ctx, comparison, change);
  const patch = await run(ctx, command);
  const backOnDisk =
    comparison.right.kind === "workingTree" &&
    change.right.kind === "workingTree" &&
    change.status !== "deleted" &&
    change.status !== "untracked" &&
    change.leftOid !== undefined &&
    patch.sections.length === 1 &&
    patch.sections[0]?.operation === "deleted" &&
    (await isOnDisk(join(ctx.checkoutPath, change.path)));
  if (backOnDisk && change.leftOid !== undefined) {
    return blobAgainstFile(ctx, change.leftOid, change.path);
  }
  return patch;
}

async function patchCommand(
  ctx: PatchContext,
  comparison: Comparison,
  change: FileChange,
): Promise<PatchCommand> {
  if (change.status === "untracked") {
    return {
      options: ["diff", "--no-index"],
      operands: ["--", DEV_NULL, change.path],
      noIndex: true,
      path: change.path,
    };
  }
  const paths = pathspecs(change);
  if (comparison.kind === "working") {
    if (change.category === "staged") {
      const head = comparison.left.kind === "commit" ? [comparison.left.oid] : [];
      return {
        options: ["diff", "--cached", "--find-renames"],
        operands: [...head, "--", ...paths],
        noIndex: false,
        path: change.path,
      };
    }
    return {
      options: ["diff", "--find-renames"],
      operands: ["--", ...paths],
      noIndex: false,
      path: change.path,
    };
  }
  const left =
    comparison.left.kind === "commit"
      ? comparison.left.oid
      : await emptyTree(ctx.checkoutPath, ctx.signal);
  let revisions: string[];
  if (comparison.right.kind === "commit") revisions = [left, comparison.right.oid];
  else if (comparison.right.kind === "workingTree") revisions = [left];
  else throw new GitError("internal", `No patch command for a ${comparison.kind} comparison.`);
  return {
    options: ["diff", "--find-renames"],
    operands: [...revisions, "--", ...paths],
    noIndex: false,
    path: change.path,
  };
}

/** The change's old path (for a rename or copy) and its path. */
function pathspecs(change: FileChange): string[] {
  return change.oldPath !== undefined && change.oldPath !== change.path
    ? [change.oldPath, change.path]
    : [change.path];
}

function args(command: PatchCommand, format: string): string[] {
  return [...command.options, format, ...command.operands];
}

async function run(ctx: PatchContext, command: PatchCommand): Promise<FilePatch> {
  const options = {
    signal: ctx.signal,
    timeoutMs: GIT_TIMEOUT_MS,
    okExitCodes: command.noIndex ? [0, 1] : [0],
  };
  const output = await runGit(ctx.checkoutPath, args(command, PATCH_FORMAT), {
    ...options,
    maxBytes: DIFF_LIMITS.patchBytes,
    overflow: "truncate",
  });
  // `--no-index` exits 1 for "differences" and for some errors alike; only errors print nothing.
  if (command.noIndex && output.code === 1 && output.stdout.length === 0) {
    throw new GitError("internal", "Git could not compare the file.", {
      exitCode: 1,
      stderr: output.stderr,
    });
  }
  const truncated = output.truncated === true;
  const sections = sectionsOf(splitSections(output.stdout, truncated), command.path);
  if (!truncated) return { sections, truncated };
  const counted = await runGit(ctx.checkoutPath, args(command, NUMSTAT_FORMAT), options);
  return { sections, truncated, stats: readNumstat(counted.stdout) };
}

/**
 * Splits Git's output into its `diff --git` sections and parses each. A content line never
 * starts with `diff --git `, since every hunk line starts with a space, `+`, `-` or `\`.
 * Output that was cut off is first cut back to its last line feed.
 */
function splitSections(stdout: Buffer, truncated: boolean): ParsedPatch[] {
  const bytes = truncated ? stdout.subarray(0, stdout.lastIndexOf(0x0a) + 1) : stdout;
  const text = bytes.toString("utf8");
  const header = "diff --git ";
  const starts: number[] = text.startsWith(header) ? [0] : [];
  for (let at = text.indexOf(`\n${header}`); at !== -1; at = text.indexOf(`\n${header}`, at + 1)) {
    starts.push(at + 1);
  }
  return starts.map((start, index) =>
    parsePatch(text.slice(start, starts[index + 1] ?? text.length), {
      truncated: truncated && index === starts.length - 1,
    }),
  );
}

/**
 * The sections written under `path` (its right side, or its left side for a deletion). The
 * pathspec already limits Git to this file, so a lone section is the file's even when its
 * header names it differently.
 */
function sectionsOf(sections: readonly ParsedPatch[], path: string): ParsedPatch[] {
  const own = sections.filter((section) => (section.newPath ?? section.oldPath) === path);
  if (own.length > 0) return own;
  return sections.length === 1 ? [...sections] : [];
}

/** Sums `--numstat` lines; a binary file's `-` counts as nothing. */
function readNumstat(stdout: Buffer): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0 };
  for (const line of stdout.toString("utf8").split("\n")) {
    const match = NUMSTAT_LINE.exec(line);
    if (!match) continue;
    if (match[1] !== "-") stats.added += Number(match[1]);
    if (match[2] !== "-") stats.removed += Number(match[2]);
  }
  return stats;
}

/**
 * The left blob against the file on disk, for a path Git cannot reach through the index:
 * the blob goes to a private temporary file (outside every repository), compared with
 * `diff --no-index`. A blob over `DIFF_LIMITS.patchBytes` is not compared at all.
 */
async function blobAgainstFile(
  ctx: PatchContext,
  leftOid: string,
  path: string,
): Promise<FilePatch> {
  const blob = await ctx.repo.catFile.read(leftOid, DIFF_LIMITS.patchBytes, {
    signal: ctx.signal,
  });
  if (blob.tooLarge) return { sections: [], truncated: true };
  const folder = await mkdtemp(join(tmpdir(), "treepeek-diff-"));
  try {
    const left = join(folder, "left");
    await writeFile(left, blob.data, { mode: 0o600 });
    return await run(ctx, {
      options: ["diff", "--no-index"],
      operands: ["--", left, path],
      noIndex: true,
      path,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Whether a regular file or a symlink sits at `file` (without following it). */
async function isOnDisk(file: string): Promise<boolean> {
  try {
    const stats = await lstat(file);
    return stats.isFile() || stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The target of `file` when it is a symlink to a folder, otherwise `null`. */
async function linkToFolder(file: string): Promise<string | null> {
  try {
    if (!(await lstat(file)).isSymbolicLink() || !(await stat(file)).isDirectory()) return null;
    return await readlink(file);
  } catch {
    return null;
  }
}

/** The section Git writes for a new symlink: its target as one line without a newline. */
function addedLinkSection(path: string, target: string): ParsedPatch {
  return {
    hunks: [
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
    ],
    stats: { added: 1, removed: 0 },
    binary: false,
    newPath: path,
    newMode: "120000",
    operation: "added",
    truncated: false,
  };
}
