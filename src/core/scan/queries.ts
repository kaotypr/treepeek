import { GIT_SCAN_TIMEOUT_MS } from "../../shared/constants";
import { pairKey } from "../cache/repo-cache";
import type { RepositoryResources } from "../cache/shared-state";
import { GitError, GitParseError } from "../git/errors";
import { parseNulList } from "../git/parse/ls-files";
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
        { signal, timeoutMs: options.timeoutMs ?? GIT_SCAN_TIMEOUT_MS, okExitCodes: [0, 1] },
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
        {
          signal,
          timeoutMs: options.timeoutMs ?? GIT_SCAN_TIMEOUT_MS,
        },
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
        { signal, timeoutMs: options.timeoutMs ?? GIT_SCAN_TIMEOUT_MS },
      );
      return parseNulList(output.stdout);
    },
    options.signal,
  );
}
