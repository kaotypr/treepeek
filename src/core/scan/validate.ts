import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import type { CheckoutKind, ScanProblem } from "../../shared/domain/scan";
import type { RepositoryResources } from "../cache/shared-state";
import { revalidate, worktreeListStamp } from "../cache/stamps";
import { asIpcError, GitError } from "../git/errors";
import { parseIdentity } from "../git/parse/rev-parse";
import { parseWorktreeList, type WorktreeEntry } from "../git/parse/worktree-list";
import { type ScanContext, scanGit } from "./context";

/** A folder that passed all three checkout tests (domain model, Checkout). */
export interface ValidCandidate {
  /** Real absolute path; Git's top level and the scanned folder. */
  path: string;
  /** Path relative to the scan root, `/`-separated. */
  relativePath: string;
  /** Real path of the checkout's own git dir. */
  gitDir: string;
  /** Real path of the repository's common dir. */
  commonDir: string;
  kind: CheckoutKind;
  repo: RepositoryResources;
}

export interface Validation {
  /** In the order of `candidates`. */
  valid: ValidCandidate[];
  problems: ScanProblem[];
  /** Git's worktree list for every repository with a valid candidate, by common dir. */
  worktreeLists: Map<string, readonly WorktreeEntry[]>;
  /** The real paths of the checkouts in each of those lists, by common dir. */
  listed: Map<string, ReadonlySet<string>>;
}

interface Identified {
  path: string;
  gitDir: string;
  commonDir: string;
}

/**
 * Keeps the candidates that are checkouts (git-service design, "The scan", steps 2 and 3):
 *
 * 1. One `rev-parse` per folder: Git must report the folder as its own top level. A folder
 *    Git does not take for a repository (a dangling `.git` file) is dropped silently; one it
 *    refuses for another reason (`dubiousOwnership`, a timeout) becomes a problem.
 * 2. Git's worktree list, once per common dir, is the authority: a folder it does not list
 *    (a copied `.git` file) is dropped. The list is cached until the repository's
 *    `worktrees/` folder changes, so a worktree added since the last scan is found.
 */
export async function validateCandidates(
  candidates: readonly string[],
  ctx: ScanContext,
): Promise<Validation> {
  const problems: ScanProblem[] = [];
  const identified = await Promise.all(
    candidates.map((candidate) => identify(candidate, ctx, problems)),
  );

  const byRepository = new Map<string, Identified[]>();
  for (const item of identified) {
    if (!item) continue;
    const group = byRepository.get(item.commonDir) ?? [];
    group.push(item);
    byRepository.set(item.commonDir, group);
  }

  const worktreeLists = new Map<string, readonly WorktreeEntry[]>();
  const listedPaths = new Map<string, ReadonlySet<string>>();
  const accepted = new Map<string, ValidCandidate>();
  await Promise.all(
    [...byRepository].map(async ([commonDir, items]) => {
      const repo = ctx.repository(commonDir);
      try {
        const listed = await listedCheckouts(repo, ctx, worktreeLists);
        listedPaths.set(commonDir, listed);
        for (const item of items) {
          if (!listed.has(item.path)) continue;
          accepted.set(item.path, {
            ...item,
            relativePath: relative(ctx.scanRoot, item.path),
            kind: item.gitDir === commonDir ? "main" : "linked",
            repo,
          });
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const ipc = asIpcError(error);
        for (const item of items) {
          problems.push({ path: item.path, code: ipc.code, message: ipc.message });
        }
      }
    }),
  );

  const valid = candidates.flatMap((candidate) => {
    const item = accepted.get(candidate);
    return item ? [item] : [];
  });
  problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { valid, problems, worktreeLists, listed: listedPaths };
}

async function identify(
  candidate: string,
  ctx: ScanContext,
  problems: ScanProblem[],
): Promise<Identified | null> {
  let stdout: Buffer;
  try {
    const output = await scanGit(
      candidate,
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      ctx.signal,
    );
    stdout = output.stdout;
  } catch (error) {
    if (ctx.signal.aborted) throw cancelled();
    const ipc = asIpcError(error);
    if (ipc.code !== "notARepository") {
      problems.push({ path: candidate, code: ipc.code, message: ipc.message });
    }
    return null;
  }
  try {
    const identity = parseIdentity(stdout, candidate);
    const [topLevel, gitDir, commonDir] = await Promise.all([
      realpath(identity.topLevel),
      realpath(identity.gitDir),
      realpath(identity.commonDir),
    ]);
    // An empty or broken `.git` makes Git find the repository around the folder instead.
    if (topLevel !== candidate) return null;
    return { path: candidate, gitDir, commonDir };
  } catch (error) {
    ctx.log.warn("could not read a candidate's git identity", { path: candidate, error });
    return null;
  }
}

/** Real paths of the checkouts Git lists for the repository. */
async function listedCheckouts(
  repo: RepositoryResources,
  ctx: ScanContext,
  lists: Map<string, readonly WorktreeEntry[]>,
): Promise<Set<string>> {
  const entries = await worktreeList(repo, ctx.signal);
  lists.set(repo.commonDir, entries);
  return realPaths(entries);
}

/**
 * `worktree list --porcelain -z`, shared through the repository's cache and read again
 * when the repository's `worktrees/` folder changes (`worktreeListStamp`).
 */
export async function worktreeList(
  repo: RepositoryResources,
  signal: AbortSignal,
): Promise<readonly WorktreeEntry[]> {
  const stamp = await worktreeListStamp(repo.commonDir);
  revalidate(repo.cache.worktreeList, repo.cache.stamps.worktreeList, repo.commonDir, stamp);
  return repo.cache.worktreeList.get(
    repo.commonDir,
    async (computeSignal) => {
      const output = await scanGit(
        repo.commonDir,
        ["worktree", "list", "--porcelain", "-z"],
        computeSignal,
      );
      return parseWorktreeList(output.stdout);
    },
    signal,
  );
}

async function realPaths(entries: readonly WorktreeEntry[]): Promise<Set<string>> {
  const paths = await Promise.all(
    entries.map((entry) =>
      entry.bare ? Promise.resolve(null) : realpath(entry.path).catch(() => null),
    ),
  );
  return new Set(paths.filter((path): path is string => path !== null));
}

function cancelled(): GitError {
  return new GitError("cancelled", "The scan was cancelled.");
}
