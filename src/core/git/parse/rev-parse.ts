import { GitParseError } from "../errors";
import { toText } from "./text";

/** Where a checkout's repository lives, from one `rev-parse` call. */
export interface GitIdentity {
  /** The checkout's top level. */
  topLevel: string;
  /** The checkout's own git dir: the common dir for a main checkout, `worktrees/<id>` inside it for a linked one. */
  gitDir: string;
  /** The repository's common dir; the identity of the repository. */
  commonDir: string;
}

const WHAT = "rev-parse --show-toplevel --git-dir --git-common-dir";

/**
 * Reads `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`.
 *
 * The three paths come one per line, unquoted, so a path containing a newline makes the
 * output ambiguous. Then `expectedTopLevel` (the folder the scan asked about) settles it:
 * the top level must be that folder, and the git dir must equal the common dir or lie in
 * its `worktrees/` folder. Output that still cannot be split one way is an error.
 */
export function parseIdentity(stdout: string | Uint8Array, expectedTopLevel?: string): GitIdentity {
  const text = toText(stdout);
  if (!text.endsWith("\n")) throw new GitParseError(WHAT, "it does not end with a newline");
  const body = text.slice(0, -1);
  const lines = body.split("\n");
  if (lines.length < 3) throw new GitParseError(WHAT, `expected 3 lines, got ${lines.length}`);
  if (lines.length === 3) {
    const [topLevel = "", gitDir = "", commonDir = ""] = lines;
    if (!topLevel || !gitDir || !commonDir) throw new GitParseError(WHAT, "a path is empty");
    return { topLevel, gitDir, commonDir };
  }

  // A path contains a newline.
  if (expectedTopLevel === undefined || !body.startsWith(`${expectedTopLevel}\n`)) {
    throw new GitParseError(WHAT, "a path contains a newline and the top level is not known");
  }
  const rest = body.slice(expectedTopLevel.length + 1);
  const splits: GitIdentity[] = [];
  for (let index = rest.indexOf("\n"); index !== -1; index = rest.indexOf("\n", index + 1)) {
    const gitDir = rest.slice(0, index);
    const commonDir = rest.slice(index + 1);
    if (gitDir === commonDir || gitDir.startsWith(`${commonDir}/worktrees/`)) {
      splits.push({ topLevel: expectedTopLevel, gitDir, commonDir });
    }
  }
  const [only] = splits;
  if (splits.length !== 1 || only === undefined) {
    throw new GitParseError(WHAT, "the git dir and common dir cannot be told apart");
  }
  return only;
}
