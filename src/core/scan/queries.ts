import { GIT_SCAN_TIMEOUT_MS } from "../../shared/constants";
import { pairKey } from "../cache/repo-cache";
import type { RepositoryResources } from "../cache/shared-state";
import { GitError, GitParseError } from "../git/errors";
import { parseNulList } from "../git/parse/ls-files";
import { parseRawDiff, type RawEntry } from "../git/parse/raw-diff";
import type { GitPriority } from "../git/queue";
import { runGit } from "../git/run";

/**
 * Commit-pair questions about a repository, each answered once and cached for good in the
 * repository's `RepoCache` (commit ancestry and content never change). Git runs in the
 * common dir: none of these needs a working tree. Equal commits are answered without git.
 */

export interface QueryOptions {
  signal: AbortSignal;
  /** Default `GIT_SCAN_TIMEOUT_MS`: the scan is the main caller. */
  timeoutMs?: number;
  /** Queue lane for a query not answered yet. Default `normal`. */
  priority?: GitPriority;
}

/** The `runGit` options of a query's one git call. */
function gitOptions(signal: AbortSignal, options: QueryOptions) {
  return {
    signal,
    timeoutMs: options.timeoutMs ?? GIT_SCAN_TIMEOUT_MS,
    ...(options.priority ? { priority: options.priority } : {}),
  };
}

/** A commit id from git's own output; anything else would be a bug, never an option. */
const OID = /^[0-9a-f]{40,64}$/;

function checkOid(oid: string): void {
  if (!OID.test(oid)) throw new GitError("internal", `Not a full commit id: ${oid}`);
}

/** `merge-base --is-ancestor <ancestor> <descendant>`: exit 0 yes, 1 no. */
export function isAncestor(
  repo: RepositoryResources,
  ancestor: string,
  descendant: string,
  options: QueryOptions,
): Promise<boolean> {
  checkOid(ancestor);
  checkOid(descendant);
  if (ancestor === descendant) return Promise.resolve(true);
  return repo.cache.immutable.ancestry.get(
    pairKey(ancestor, descendant),
    async (signal) => {
      const output = await runGit(
        repo.commonDir,
        ["merge-base", "--is-ancestor", ancestor, descendant],
        { ...gitOptions(signal, options), okExitCodes: [0, 1] },
      );
      return output.code === 0;
    },
    options.signal,
  );
}

/** `rev-list --count <left>..<right>`: commits in `right` that `left` lacks. */
export function commitCount(
  repo: RepositoryResources,
  left: string,
  right: string,
  options: QueryOptions,
): Promise<number> {
  checkOid(left);
  checkOid(right);
  if (left === right) return Promise.resolve(0);
  return repo.cache.immutable.counts.get(
    pairKey(left, right),
    async (signal) => {
      const output = await runGit(
        repo.commonDir,
        ["rev-list", "--count", `${left}..${right}`, "--"],
        gitOptions(signal, options),
      );
      const text = output.stdout.toString("utf8").trim();
      if (!/^\d+$/.test(text)) throw new GitParseError("rev-list --count", `got "${text}"`);
      return Number(text);
    },
    options.signal,
  );
}

/** `diff --name-only -z <left> <right>`: the paths that differ between two commits. */
export function changedPaths(
  repo: RepositoryResources,
  left: string,
  right: string,
  options: QueryOptions,
): Promise<readonly string[]> {
  checkOid(left);
  checkOid(right);
  if (left === right) return Promise.resolve([]);
  return repo.cache.immutable.nameLists.get(
    pairKey(left, right),
    async (signal) => {
      const output = await runGit(
        repo.commonDir,
        ["diff", "--name-only", "-z", left, right, "--"],
        gitOptions(signal, options),
      );
      return parseNulList(output.stdout);
    },
    options.signal,
  );
}

/**
 * `merge-base <a> <b>`: the best common ancestor, or `null` when the two histories share
 * none (exit 1).
 */
export function mergeBase(
  repo: RepositoryResources,
  a: string,
  b: string,
  options: QueryOptions,
): Promise<string | null> {
  checkOid(a);
  checkOid(b);
  if (a === b) return Promise.resolve(a);
  return repo.cache.immutable.mergeBases.get(
    pairKey(a, b),
    async (signal) => {
      const output = await runGit(repo.commonDir, ["merge-base", a, b], {
        ...gitOptions(signal, options),
        okExitCodes: [0, 1],
      });
      if (output.code === 1) return null;
      const oid = output.stdout.toString("utf8").trim();
      if (!OID.test(oid)) throw new GitParseError("merge-base", `got "${oid.slice(0, 80)}"`);
      return oid;
    },
    options.signal,
  );
}

/**
 * The flags of every comparison file list (git-service command catalogue): status, both
 * modes and both full blob ids in one pass, renames found. Git caps `--abbrev=<n>` at the
 * object format's id length, so 64 prints whole ids for SHA-1 and SHA-256 alike, where the
 * catalogue's `--abbrev=40` would cut SHA-256 ids (`--no-abbrev` is undocumented).
 */
export const RAW_DIFF_FLAGS: readonly string[] = Object.freeze([
  "--raw",
  "-z",
  "--find-renames",
  "--abbrev=64",
]);

/** `diff --raw -z --find-renames --abbrev=64 <left> <right>` between two commits. */
export function rawDiff(
  repo: RepositoryResources,
  left: string,
  right: string,
  options: QueryOptions,
): Promise<readonly RawEntry[]> {
  checkOid(left);
  checkOid(right);
  if (left === right) return Promise.resolve([]);
  return repo.cache.immutable.rawDiffs.get(
    pairKey(left, right),
    async (signal) => {
      const output = await runGit(
        repo.commonDir,
        ["diff", ...RAW_DIFF_FLAGS, left, right, "--"],
        gitOptions(signal, options),
      );
      return parseRawDiff(output.stdout);
    },
    options.signal,
  );
}
