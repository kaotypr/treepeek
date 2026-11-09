import { GitParseError } from "../errors";
import { nulFields, toText } from "./text";

/** One entry of Git's own list of a repository's checkouts. */
export interface WorktreeEntry {
  /** The checkout's path as Git recorded it (for a bare repository, the repository itself). */
  path: string;
  /** HEAD's commit id; `null` for a bare repository or an unborn branch. */
  head: string | null;
  /** The checked-out branch as a full ref (`refs/heads/main`); absent when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** Git would remove this entry on `worktree prune` (its folder is gone). */
  prunable: boolean;
}

const WHAT = "worktree list --porcelain -z";
const ALL_ZEROS = /^0+$/;

/**
 * Reads `git worktree list --porcelain -z`: attribute fields, each NUL-terminated, with an
 * empty field ending each entry. Attributes this parser does not know are skipped, so a
 * newer Git adding one does not break it.
 */
export function parseWorktreeList(zOutput: string | Uint8Array): WorktreeEntry[] {
  const fields = nulFields(toText(zOutput));
  if (fields === null) throw new GitParseError(WHAT, "it is not NUL-terminated");
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of fields) {
    if (field === "") {
      if (current === null) throw new GitParseError(WHAT, "an entry is empty");
      entries.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const name = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (name === "worktree") {
      if (current !== null) throw new GitParseError(WHAT, "an entry is not terminated");
      if (!value) throw new GitParseError(WHAT, "a worktree has no path");
      current = {
        path: value,
        head: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) throw new GitParseError(WHAT, `${name} appears before any worktree`);
    switch (name) {
      case "HEAD":
        current.head = ALL_ZEROS.test(value) ? null : value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      case "locked":
        current.locked = true;
        break;
      case "prunable":
        current.prunable = true;
        break;
    }
  }
  if (current !== null) throw new GitParseError(WHAT, "the last entry is not terminated");
  return entries;
}
