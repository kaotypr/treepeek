import { realpath } from "node:fs/promises";
import type { CheckoutKind, CheckoutLocation, ScanProblem } from "../../shared/domain/scan";
import type { RepositoryResources } from "../cache/shared-state";
import { revalidate, worktreeListStamp } from "../cache/stamps";
import { asIpcError, GitError } from "../git/errors";
import { parseIdentity } from "../git/parse/rev-parse";
import { parseWorktreeList, type WorktreeEntry } from "../git/parse/worktree-list";
import { isWithin } from "../sessions/path-rule";
import { type ScanContext, scanGit } from "./context";

/** A folder that passed all three checkout tests (domain model, Checkout). */
export interface ValidCandidate {
  /** Real absolute path; Git's top level. */
  path: string;
  /** Real path of the checkout's own git dir. */
  gitDir: string;
  /** Real path of the repository's common dir. */
  commonDir: string;
  kind: CheckoutKind;
  location: CheckoutLocation;
  /** Git's worktree list says it is locked. */
  locked: boolean;
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
 *
 * The walk found every candidate, so each one lies inside a scan root.
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
  const listedByRepository = new Map<string, ReadonlySet<string>>();
  const accepted = new Map<string, ValidCandidate>();
  await Promise.all(
    [...byRepository].map(async ([commonDir, items]) => {
      const repo = ctx.repository(commonDir);
      try {
        const entries = await worktreeList(repo, ctx.signal);
        worktreeLists.set(commonDir, entries);
        const listed = await listedEntries(entries);
        listedByRepository.set(commonDir, new Set(listed.keys()));
        for (const item of items) {
          const entry = listed.get(item.path);
          if (!entry) continue;
          accepted.set(item.path, {
            ...item,
            kind: item.gitDir === commonDir ? "main" : "linked",
            location: "inside",
            locked: entry.locked,
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
  return { valid, problems, worktreeLists, listed: listedByRepository };
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

/** A checkout a repository's worktree list holds that the walk did not find. */
export interface UnwalkedCheckout {
  /** Real absolute path. */
  path: string;
  location: CheckoutLocation;
  locked: boolean;
}

/**
 * The checkouts of a repository's worktree list that a scan lists besides the walked ones:
 * not bare, not prunable (its folder is gone), with a folder that exists, and not among
 * `walked` (every candidate the walk found, which validation has already judged). Each is
 * `inside` when it lies under a scan root the walk did not reach into (inside another
 * checkout, say) and `outside` otherwise; the session's choice leaves out the outside ones
 * (`inside`) or all of them (`walked`).
 */
export async function unwalkedCheckouts(
  entries: readonly WorktreeEntry[],
  walked: ReadonlySet<string>,
  ctx: Pick<ScanContext, "scanRoots" | "worktrees">,
): Promise<UnwalkedCheckout[]> {
  if (ctx.worktrees === "walked") return [];
  const found = new Map<string, UnwalkedCheckout>();
  const resolved = await Promise.all(
    entries.map(async (entry) =>
      entry.bare || entry.prunable
        ? null
        : { entry, path: await realpath(entry.path).catch(() => null) },
    ),
  );
  for (const item of resolved) {
    if (!item?.path || walked.has(item.path) || found.has(item.path)) continue;
    const location = locationOf(item.path, ctx.scanRoots);
    if (location === "outside" && ctx.worktrees === "inside") continue;
    found.set(item.path, { path: item.path, location, locked: item.entry.locked });
  }
  return [...found.values()];
}

/**
 * Turns the unwalked checkouts of repositories the walk found (by common dir, with their
 * worktree lists) into valid candidates. Each goes through the walk's own `rev-parse`
 * check and must report the same common dir; a folder Git refuses becomes a problem, as a
 * walked one would.
 */
export async function deriveCheckouts(
  lists: ReadonlyMap<string, readonly WorktreeEntry[]>,
  walked: ReadonlySet<string>,
  ctx: ScanContext,
): Promise<{ valid: ValidCandidate[]; problems: ScanProblem[] }> {
  const problems: ScanProblem[] = [];
  const derived = await Promise.all(
    [...lists].map(async ([commonDir, entries]) => {
      const unwalked = await unwalkedCheckouts(entries, walked, ctx);
      return Promise.all(
        unwalked.map((item) => validateUnwalked(item, commonDir, ctx, problems)),
      );
    }),
  );
  const valid = derived.flat().filter((item): item is ValidCandidate => item !== null);
  valid.sort((a, b) => compareText(a.path, b.path));
  return { valid, problems };
}

/** One unwalked checkout as a valid candidate of `commonDir`'s repository, or `null`. */
export async function validateUnwalked(
  item: UnwalkedCheckout,
  commonDir: string,
  ctx: ScanContext,
  problems: ScanProblem[],
): Promise<ValidCandidate | null> {
  const identified = await identify(item.path, ctx, problems);
  if (!identified) return null;
  if (identified.commonDir !== commonDir) {
    ctx.log.warn("a listed worktree belongs to another repository", {
      path: item.path,
      commonDir,
    });
    return null;
  }
  return {
    ...identified,
    kind: identified.gitDir === commonDir ? "main" : "linked",
    location: item.location,
    locked: item.locked,
    repo: ctx.repository(commonDir),
  };
}

/** `inside` when `path` is a scan root or lies under one. */
export function locationOf(path: string, scanRoots: readonly string[]): CheckoutLocation {
  return scanRoots.some((root) => isWithin(path, root)) ? "inside" : "outside";
}

/**
 * `worktree list --porcelain -z`, shared through the repository's cache and read again
 * when the repository's `worktrees/` folder changes (`worktreeListStamp`) or live refresh
 * saw a worktree added or removed.
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

/** Real paths of the (non-bare) checkouts in a worktree list; a path that is gone is left out. */
export async function listedPaths(entries: readonly WorktreeEntry[]): Promise<Set<string>> {
  return new Set((await listedEntries(entries)).keys());
}

/** The (non-bare) entries of a worktree list by real path; a path that is gone is left out. */
async function listedEntries(
  entries: readonly WorktreeEntry[],
): Promise<Map<string, WorktreeEntry>> {
  const paths = await Promise.all(
    entries.map((entry) =>
      entry.bare ? Promise.resolve(null) : realpath(entry.path).catch(() => null),
    ),
  );
  const listed = new Map<string, WorktreeEntry>();
  for (const [index, path] of paths.entries()) {
    const entry = entries[index];
    if (path !== null && entry && !listed.has(path)) listed.set(path, entry);
  }
  return listed;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cancelled(): GitError {
  return new GitError("cancelled", "The scan was cancelled.");
}
