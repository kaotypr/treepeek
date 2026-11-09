import { GitError } from "./errors";
import { runGit } from "./run";

/** Longest ref Treepeek accepts from a person (a base ref or a start override). */
export const MAX_USER_REF_LENGTH = 200;

/**
 * Throws `invalidRequest` unless `ref` is safe to hand to git: not empty, at most
 * `MAX_USER_REF_LENGTH` characters, not starting with `-` (so it can never be read as an
 * option), and without control characters.
 */
export function checkUserRef(ref: string): void {
  if (ref.length === 0) throw invalid("The ref is empty.");
  if (ref.length > MAX_USER_REF_LENGTH) {
    throw invalid(`The ref is longer than ${MAX_USER_REF_LENGTH} characters.`);
  }
  if (ref.startsWith("-")) throw invalid("A ref cannot start with '-'.");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (/[\u0000-\u001f\u007f]/.test(ref)) throw invalid("The ref contains control characters.");
}

/**
 * Resolves a ref a person typed to a full commit id. The checks run first, then
 * `rev-parse --verify --quiet --end-of-options <ref>^{commit}`; a ref that names nothing,
 * or something that is not a commit, fails with `refNotFound`.
 */
export async function resolveUserRef(
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<string> {
  checkUserRef(ref);
  const output = await runGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { signal, okExitCodes: [0, 1] },
  );
  const oid = output.stdout.toString("utf8").trim();
  if (output.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new GitError("refNotFound", `No commit named ${ref} was found.`, {
      exitCode: output.code,
      stderr: output.stderr,
    });
  }
  return oid;
}

function invalid(message: string): GitError {
  return new GitError("invalidRequest", message);
}
