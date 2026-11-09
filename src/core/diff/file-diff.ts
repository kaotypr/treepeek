import { join } from "node:path";
import { DIFF_LIMITS } from "../../shared/constants";
import type { ParsedPatch } from "../../shared/diff/parse-patch";
import type { FileCategory, FileChange } from "../../shared/domain/compare";
import type { DiffStats, FileDiff, Hunk } from "../../shared/domain/diff";
import type { IpcError } from "../../shared/ipc/result";
import { isIpcError } from "../compare/kinds";
import { type ComparisonContext, type ComparisonRequest, listComparison } from "../compare/list";
import { isWithin, realPathOf } from "../sessions/path-rule";
import { readSide, type SideContent } from "./contents";
import { filePatch } from "./patch";

/** What `diff.file` needs: the same as a comparison list, whose files it re-derives. */
export type FileDiffContext = ComparisonContext;

export interface FileDiffRequest {
  /** Which comparison, as `comparison.list` takes it: the kind, plus `ref`/`startOverride`. */
  comparison: ComparisonRequest;
  /** Repository-relative, `/`-separated: the file's path on the right side. */
  path: string;
  /** Which part of `working` the file is in; required there, refused for other kinds. */
  category?: FileCategory;
}

/** Why a `path` is refused before anything reads it. */
export type PathProblem = "escapes" | "malformed";

const GITLINK = "160000";

/**
 * Checks a repository-relative path from the renderer. `escapes`: absolute, or a `..`
 * segment, so it could name something outside the checkout. `malformed`: a NUL byte, or an
 * empty or `.` segment, none of which Git ever lists.
 */
export function checkRepoPath(path: string): PathProblem | null {
  if (path.startsWith("/")) return "escapes";
  const segments = path.split("/");
  if (segments.includes("..")) return "escapes";
  if (path.includes("\0") || segments.some((segment) => segment === "" || segment === ".")) {
    return "malformed";
  }
  return null;
}

/**
 * One file's diff (`diff.file`, diff pipeline "Pipeline"). Nothing in the request is
 * trusted beyond its shape:
 *
 * 1. `path` must be repository-relative and, after resolving symlinks, lie inside the
 *    checkout (the path rule): otherwise `notInScan`.
 * 2. The comparison's sides are resolved again and the file's `FileChange` (status, old
 *    path, blob ids, `resultHash`) is taken from that comparison's list, the same list
 *    and cache `comparison.list` uses. A path that list does not hold fails
 *    `invalidRequest` with `detail.notInComparison`.
 * 3. The patch comes from Git (`filePatch`), the full texts from the blobs or the disk
 *    (`readSide`), both within `DIFF_LIMITS`.
 *
 * Returns the error for a request the checkout cannot answer; throws a `GitError` when git
 * fails or the call is cancelled.
 */
export async function buildFileDiff(
  ctx: FileDiffContext,
  request: FileDiffRequest,
): Promise<FileDiff | IpcError> {
  const problem = checkRepoPath(request.path);
  if (problem === "escapes") return notInScan();
  if (problem === "malformed") {
    return { code: "invalidRequest", message: "That is not a repository-relative file path." };
  }
  const working = request.comparison.kind === "working";
  if (working !== (request.category !== undefined)) {
    return {
      code: "invalidRequest",
      message: working
        ? "Say which part of the working comparison the file is in (staged, unstaged or untracked)."
        : "Only the working comparison has categories.",
    };
  }

  const checkoutPath = ctx.checkout.checkout.path;
  const real = await realPathOf(join(checkoutPath, request.path));
  if (real === null || !isWithin(real, checkoutPath)) return notInScan();

  const listed = await listComparison(ctx, request.comparison);
  if (isIpcError(listed)) return listed;
  const change = listed.files.find(
    (file) => file.path === request.path && file.category === request.category,
  );
  if (!change) {
    return {
      code: "invalidRequest",
      message: "That file has no changes in this comparison. The list may be out of date.",
      detail: { notInComparison: true },
    };
  }

  const patch = await filePatch(
    { checkoutPath, repo: ctx.repo, signal: ctx.signal },
    listed.comparison,
    change,
  );
  const merged = merge(patch.sections);
  const content = { checkoutPath, catFile: ctx.repo.catFile, signal: ctx.signal };
  const [left, right] = await Promise.all([
    readSide(content, change, "left", { gitlink: merged.oldMode === GITLINK }),
    readSide(content, change, "right", { gitlink: merged.newMode === GITLINK }),
  ]);
  return assemble(change, merged, patch.truncated, patch.stats, left, right);
}

/** The file's sections as one: a type change's deletion and addition together. */
interface MergedPatch {
  hunks: Hunk[];
  stats: DiffStats;
  binary: boolean;
  truncated: boolean;
  oldMode: string | undefined;
  newMode: string | undefined;
}

function merge(sections: readonly ParsedPatch[]): MergedPatch {
  const merged: MergedPatch = {
    hunks: [],
    stats: { added: 0, removed: 0 },
    binary: false,
    truncated: false,
    oldMode: undefined,
    newMode: undefined,
  };
  for (const section of sections) {
    merged.hunks.push(...section.hunks);
    merged.stats.added += section.stats.added;
    merged.stats.removed += section.stats.removed;
    merged.binary ||= section.binary;
    merged.truncated ||= section.truncated;
    merged.oldMode ??= section.oldMode;
    if (section.newMode !== undefined) merged.newMode = section.newMode;
  }
  return merged;
}

function assemble(
  change: FileChange,
  merged: MergedPatch,
  truncated: boolean,
  fullStats: DiffStats | undefined,
  left: SideContent,
  right: SideContent,
): FileDiff {
  // Git's binary marker, or a NUL byte in the first bytes of either side (diff pipeline,
  // "Binary detection"); what Git calls text with NUL bytes is not shown as text either.
  const binary = merged.binary || looksBinary(left) || looksBinary(right);
  const contentOmitted =
    !binary &&
    (left.omitted ||
      right.omitted ||
      over(left, DIFF_LIMITS.contentBytes, DIFF_LIMITS.contentLines) ||
      over(right, DIFF_LIMITS.contentBytes, DIFF_LIMITS.contentLines));
  const highlightOff =
    !binary &&
    (contentOmitted ||
      over(left, DIFF_LIMITS.highlightBytes, DIFF_LIMITS.highlightLines) ||
      over(right, DIFF_LIMITS.highlightBytes, DIFF_LIMITS.highlightLines));
  const showText = !binary && !contentOmitted;
  const diff: FileDiff = {
    path: change.path,
    status: change.status,
    binary,
    hunks: binary ? [] : merged.hunks,
    left: showText ? textOf(left) : null,
    right: showText ? textOf(right) : null,
    stats: binary ? { added: 0, removed: 0 } : (fullStats ?? merged.stats),
    limits: { patchTruncated: truncated || merged.truncated, contentOmitted, highlightOff },
    resultHash: change.resultHash,
  };
  if (change.oldPath !== undefined) diff.oldPath = change.oldPath;
  return diff;
}

function looksBinary(side: SideContent): boolean {
  if (side.omitted) return side.binary;
  return side.data.subarray(0, DIFF_LIMITS.binarySniffBytes).includes(0);
}

function over(side: SideContent, bytes: number, lines: number): boolean {
  if (side.omitted) return true;
  return side.data.length > bytes || lineCount(side.data) > lines;
}

/** Lines as an editor counts them: a last line without a newline still counts. */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let at = data.indexOf(0x0a); at !== -1; at = data.indexOf(0x0a, at + 1)) count += 1;
  return data[data.length - 1] === 0x0a ? count : count + 1;
}

function textOf(side: SideContent): string | null {
  return side.omitted ? null : side.data.toString("utf8");
}

function notInScan(): IpcError {
  return { code: "notInScan", message: "That file is not inside this checkout." };
}
