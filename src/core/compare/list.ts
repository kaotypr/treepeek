import { GIT_TIMEOUT_MS } from "../../shared/constants";
import type {
  ComparisonResult,
  ContentSide,
  FileCategory,
  FileChange,
  FileStatus,
} from "../../shared/domain/compare";
import type { IpcError } from "../../shared/ipc/result";
import type { RepositoryResources } from "../cache/shared-state";
import { GitParseError } from "../git/errors";
import type { HashObjectBatch } from "../git/hash-object";
import { parseNulList } from "../git/parse/ls-files";
import { parseRawDiff, type RawEntry, type RawStatus } from "../git/parse/raw-diff";
import { runGit } from "../git/run";
import { commitCount, isAncestor, RAW_DIFF_FLAGS, rawDiff } from "../scan/queries";
import type { ScannedCheckout } from "../scan/resolve-checkout";
import {
  containedNote,
  EMPTY,
  INDEX,
  isIpcError,
  type ResolvedSides,
  resolveSides,
  type SidesRequest,
  WORKING_TREE,
} from "./kinds";
import { fillResultHashes, type ListedFile } from "./result-hash";

export type { SidesRequest as ComparisonRequest } from "./kinds";

export interface ComparisonContext {
  readonly checkout: ScannedCheckout;
  /** See `SidesContext.predecessor`. */
  readonly predecessor: ScannedCheckout | null | undefined;
  readonly repo: RepositoryResources;
  /** The checkout's `hash-object` process, for working-tree result hashes. */
  readonly hashObject: HashObjectBatch;
  readonly signal: AbortSignal;
}

const STATUS: Readonly<Record<RawStatus, FileStatus>> = Object.freeze({
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "typeChanged",
  // A conflicted path; the list shows it changed, its patch shows the conflict.
  U: "modified",
  X: "modified",
});

const UNTRACKED_ARGS = ["ls-files", "--others", "--exclude-standard", "-z"] as const;

/**
 * One comparison's file list (`comparison.list`), with the git-service catalogue's
 * commands: `diff --raw -z --find-renames --no-abbrev`, plus
 * `ls-files --others --exclude-standard -z` wherever the right side is the working tree.
 *
 * Caching (git-service design, "Caching"):
 * - a list between two commits is content-addressed, so its raw diff is kept for good in
 *   the repository's immutable caches;
 * - a list involving the index or the working tree is kept in `comparisons(checkoutPath)`
 *   under its kind and left commit, until `invalidate(checkoutPath, kinds)` or the next
 *   scan of the checkout clears it.
 *
 * Returns the error for a kind the checkout cannot have; throws a `GitError` when git fails.
 */
export async function listComparison(
  ctx: ComparisonContext,
  request: SidesRequest,
): Promise<ComparisonResult | IpcError> {
  const sides = await resolveSides(request, ctx);
  if (isIpcError(sides)) return sides;
  const files = await filesOf(sides, ctx);
  const result: ComparisonResult = { comparison: sides.comparison, files: [...files] };
  const head = ctx.checkout.checkout.head;
  const query = { signal: ctx.signal, timeoutMs: GIT_TIMEOUT_MS };
  if (sides.counted) {
    result.commits = await commitCount(ctx.repo, sides.counted.left, sides.counted.right, query);
  }
  let note = sides.note;
  if (sides.containedIn && head) {
    result.contained = await isAncestor(ctx.repo, head, sides.containedIn, query);
    if (result.contained) note ??= containedNote(sides.comparison.kind);
  }
  if (note !== undefined) result.note = note;
  return result;
}

async function filesOf(
  sides: ResolvedSides,
  ctx: ComparisonContext,
): Promise<readonly FileChange[]> {
  const { left, right, kind } = sides.comparison;
  const query = { signal: ctx.signal, timeoutMs: GIT_TIMEOUT_MS };
  if (left.kind === "commit" && right.kind === "commit") {
    const raw = await rawDiff(ctx.repo, left.oid, right.oid, query);
    return finish(
      raw.map((entry) => fromRaw(entry, left, right)),
      ctx,
    );
  }
  const memo = ctx.repo.cache.comparisons(ctx.checkout.checkout.path);
  const leftKey = left.kind === "commit" ? left.oid : "empty";
  if (kind === "working") {
    return memo.get(
      `working:${leftKey}`,
      (signal) => listWorking(left, { ...ctx, signal }),
      ctx.signal,
    );
  }
  return memo.get(
    `review:${leftKey}`,
    (signal) => listReview(left, { ...ctx, signal }),
    ctx.signal,
  );
}

/**
 * `review`: the left commit against the working tree in one list, each path once.
 * `git diff <commit>` takes the working tree's paths from the index, so untracked files
 * come from `ls-files` and are merged in:
 *
 * - a path deleted from the index but still on disk, untracked, is modified, not deleted
 *   and untracked;
 * - when a renamed file's old path is back on disk, untracked, the new path is a copy and
 *   the old path is modified.
 */
async function listReview(left: ContentSide, ctx: ComparisonContext): Promise<FileChange[]> {
  const cwd = ctx.checkout.checkout.path;
  const options = { signal: ctx.signal, timeoutMs: GIT_TIMEOUT_MS };
  const from = left.kind === "commit" ? left.oid : await emptyTree(cwd, ctx.signal);
  const [diffOut, untrackedOut] = await Promise.all([
    runGit(cwd, ["diff", ...RAW_DIFF_FLAGS, from, "--"], options),
    runGit(cwd, UNTRACKED_ARGS, options),
  ]);
  const untracked = new Set(parseNulList(untrackedOut.stdout));
  const listed: ListedFile[] = [];
  for (const entry of parseRawDiff(diffOut.stdout)) {
    if (entry.status === "D" && untracked.delete(entry.path)) {
      listed.push(backOnDisk(entry.path, entry.oldOid, left));
      continue;
    }
    if (entry.status === "R" && entry.oldPath !== undefined && untracked.delete(entry.oldPath)) {
      const copy = fromRaw(entry, left, WORKING_TREE);
      copy.change.status = "copied";
      listed.push(copy, backOnDisk(entry.oldPath, entry.oldOid, left));
      continue;
    }
    listed.push(fromRaw(entry, left, WORKING_TREE));
  }
  for (const path of untracked) listed.push(untrackedFile(path));
  listed.sort((a, b) => compare(a.change.path, b.change.path));
  return finish(listed, ctx);
}

/** `working`: staged (HEAD → index), unstaged (index → disk) and untracked (empty → disk). */
async function listWorking(head: ContentSide, ctx: ComparisonContext): Promise<FileChange[]> {
  const cwd = ctx.checkout.checkout.path;
  const options = { signal: ctx.signal, timeoutMs: GIT_TIMEOUT_MS };
  const [stagedOut, unstagedOut, untrackedOut] = await Promise.all([
    runGit(cwd, ["diff", ...RAW_DIFF_FLAGS, "--cached", "--"], options),
    runGit(cwd, ["diff", ...RAW_DIFF_FLAGS, "--"], options),
    runGit(cwd, UNTRACKED_ARGS, options),
  ]);
  const listed = [
    ...parseRawDiff(stagedOut.stdout).map((entry) => fromRaw(entry, head, INDEX, "staged")),
    ...parseRawDiff(unstagedOut.stdout).map((entry) =>
      fromRaw(entry, INDEX, WORKING_TREE, "unstaged"),
    ),
    ...parseNulList(untrackedOut.stdout)
      .sort(compare)
      .map((path) => untrackedFile(path, "untracked")),
  ];
  return finish(listed, ctx);
}

function finish(listed: readonly ListedFile[], ctx: ComparisonContext): Promise<FileChange[]> {
  return fillResultHashes(listed, {
    checkoutPath: ctx.checkout.checkout.path,
    hashObject: ctx.hashObject,
    signal: ctx.signal,
  });
}

/** A file from `diff --raw`, read from `left` and `right` (empty where it is absent). */
function fromRaw(
  entry: RawEntry,
  left: ContentSide,
  right: ContentSide,
  category?: FileCategory,
): ListedFile {
  const status = STATUS[entry.status];
  const fileLeft = status === "added" ? EMPTY : left;
  const fileRight = status === "deleted" ? EMPTY : right;
  const change: FileChange = {
    path: entry.path,
    status,
    left: fileLeft,
    right: fileRight,
    resultHash: "",
    binary: false,
  };
  if (entry.oldPath !== undefined) change.oldPath = entry.oldPath;
  if (category !== undefined) change.category = category;
  if (hasBlob(fileLeft) && !isZero(entry.oldOid)) change.leftOid = entry.oldOid;
  if (hasBlob(fileRight) && !isZero(entry.newOid)) change.rightOid = entry.newOid;
  return {
    change,
    reportedOid: status === "deleted" ? null : entry.newOid,
    rightMode: status === "deleted" ? null : entry.newMode,
  };
}

/** A path the left commit has that is on disk again, untracked: modified, not deleted. */
function backOnDisk(path: string, leftOid: string, left: ContentSide): ListedFile {
  const change: FileChange = {
    path,
    status: "modified",
    left,
    right: WORKING_TREE,
    resultHash: "",
    binary: false,
  };
  if (!isZero(leftOid)) change.leftOid = leftOid;
  return { change, reportedOid: null, rightMode: null };
}

function untrackedFile(path: string, category?: FileCategory): ListedFile {
  const change: FileChange = {
    path,
    status: "untracked",
    left: EMPTY,
    right: WORKING_TREE,
    resultHash: "",
    binary: false,
  };
  if (category !== undefined) change.category = category;
  return { change, reportedOid: null, rightMode: null };
}

/**
 * The empty tree's id in this repository's object format, for a checkout without commits:
 * `hash-object -t tree --stdin` with no input, which writes nothing.
 */
async function emptyTree(cwd: string, signal: AbortSignal): Promise<string> {
  const output = await runGit(cwd, ["hash-object", "-t", "tree", "--stdin"], { signal, stdin: "" });
  const oid = output.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid))
    throw new GitParseError("hash-object -t tree", `got "${oid}"`);
  return oid;
}

function hasBlob(side: ContentSide): boolean {
  return side.kind === "commit" || side.kind === "index";
}

function isZero(oid: string): boolean {
  return /^0+$/.test(oid);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
