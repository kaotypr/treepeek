import { GitParseError } from "../errors";
import { nulFields, toText } from "./text";

/** What `status --porcelain=v2 --branch` says about a checkout, with its changes counted. */
export interface StatusSummary {
  /** HEAD's commit id; `null` on an unborn branch (`(initial)`). */
  head: string | null;
  /** The branch name; absent when HEAD is detached. */
  branch?: string;
  /** The upstream ref, such as `origin/main`; absent when the branch has none. */
  upstream?: string;
  /** Commits on HEAD the upstream lacks; absent without an upstream or when it is gone. */
  ahead?: number;
  /** Commits on the upstream HEAD lacks; absent like `ahead`. */
  behind?: number;
  /** Paths with a staged change (index differs from HEAD). */
  staged: number;
  /** Paths with an unstaged change (working tree differs from the index). */
  unstaged: number;
  /** Untracked paths (one per file with `--untracked-files=all`). */
  untracked: number;
  /** Paths with a merge conflict; counted here only, not as staged or unstaged. */
  unmerged: number;
}

const WHAT = "status --porcelain=v2 -z --branch";
const XY = /^[.MTADRCU?!]{2}$/;

/**
 * Reads `git status --porcelain=v2 -z --branch`. Fields before a path are fixed in number
 * for each entry type, so a path with spaces is read whole; a rename (`2`) carries its
 * original path in the next field.
 */
export function parseStatusV2(zOutput: string | Uint8Array): StatusSummary {
  const fields = nulFields(toText(zOutput));
  if (fields === null) throw new GitParseError(WHAT, "it is not NUL-terminated");
  const summary: StatusSummary = { head: null, staged: 0, unstaged: 0, untracked: 0, unmerged: 0 };
  let sawOid = false;

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    if (field.startsWith("# ")) {
      const header = field.slice(2);
      const space = header.indexOf(" ");
      const key = space === -1 ? header : header.slice(0, space);
      const value = space === -1 ? "" : header.slice(space + 1);
      switch (key) {
        case "branch.oid":
          sawOid = true;
          summary.head = value === "(initial)" ? null : value;
          break;
        case "branch.head":
          if (value !== "(detached)") summary.branch = value;
          break;
        case "branch.upstream":
          summary.upstream = value;
          break;
        case "branch.ab": {
          const match = /^\+(\d+) -(\d+)$/.exec(value);
          if (!match) throw new GitParseError(WHAT, `unexpected branch.ab "${value}"`);
          summary.ahead = Number(match[1]);
          summary.behind = Number(match[2]);
          break;
        }
      }
      continue;
    }

    const type = field.slice(0, 2);
    switch (type) {
      case "1 ":
      case "2 ": {
        const xy = field.slice(2, 4);
        if (!XY.test(xy)) throw new GitParseError(WHAT, `unexpected status "${xy}"`);
        if (xy[0] !== ".") summary.staged += 1;
        if (xy[1] !== ".") summary.unstaged += 1;
        // A rename or copy entry is followed by its original path.
        if (type === "2 ") {
          index += 1;
          if (index >= fields.length)
            throw new GitParseError(WHAT, "a rename has no original path");
        }
        break;
      }
      case "u ":
        summary.unmerged += 1;
        break;
      case "? ":
        summary.untracked += 1;
        break;
      case "! ":
        break;
      default:
        throw new GitParseError(WHAT, `unexpected entry type "${field.slice(0, 1)}"`);
    }
  }
  if (!sawOid)
    throw new GitParseError(WHAT, "there is no branch.oid header (was --branch passed?)");
  return summary;
}
