import { basename, dirname } from "node:path";
import type { Repository } from "../../shared/domain/scan";
import type { WorktreeEntry } from "../git/parse/worktree-list";

/** What a repository needs of a checkout. */
export interface RepositoryMember {
  path: string;
  commonDir: string;
}

/**
 * Groups checkouts into repositories by common dir, whichever scan root (or none) each was
 * found from, keeping the given order (the timeline's) for both the repositories (by their
 * first checkout) and the checkouts within each.
 */
export function buildRepositories(
  checkouts: readonly RepositoryMember[],
  worktreeLists: ReadonlyMap<string, readonly WorktreeEntry[]>,
): Repository[] {
  const repositories = new Map<string, Repository>();
  for (const checkout of checkouts) {
    let repository = repositories.get(checkout.commonDir);
    if (!repository) {
      repository = {
        commonDir: checkout.commonDir,
        displayName: displayName(checkout.commonDir, worktreeLists.get(checkout.commonDir) ?? []),
        checkouts: [],
      };
      repositories.set(checkout.commonDir, repository);
    }
    repository.checkouts.push(checkout.path);
  }
  return [...repositories.values()];
}

/**
 * The repository's name (domain model, Repository): the main checkout's folder name, which
 * Git lists first. A bare repository lists itself first; its name drops a `.git` suffix.
 */
export function displayName(commonDir: string, worktrees: readonly WorktreeEntry[]): string {
  const main = worktrees[0];
  if (main && !main.bare) return basename(main.path);
  if (main?.bare || !commonDir.endsWith("/.git")) return withoutGitSuffix(basename(commonDir));
  return basename(dirname(commonDir));
}

function withoutGitSuffix(name: string): string {
  return name.endsWith(".git") && name.length > ".git".length
    ? name.slice(0, -".git".length)
    : name;
}
