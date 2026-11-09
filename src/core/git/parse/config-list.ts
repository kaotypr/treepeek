import { GitParseError } from "../errors";

/** One entry of `git config --show-scope --show-origin --list -z`. */
export interface ConfigEntry {
  /** Where the entry's file sits: `system`, `global`, `local`, `worktree`, `command`, … */
  scope: string;
  /**
   * Where Git read it: `file:<path>` (a relative path is relative to the folder git ran
   * in), `command line:`, `blob:<oid>` or `standard input:`.
   */
  origin: string;
  /** The canonical key: section and name lowercased, the subsection exactly as written. */
  key: string;
  /** The value; `null` for a key written without `=`, which Git reads as boolean true. */
  value: string | null;
  /**
   * Some field of the entry is not valid UTF-8, so `key` and `value` hold replacement
   * characters. Such a name cannot be passed back to git exactly (Node encodes arguments
   * and the environment as UTF-8), so callers that need it must refuse instead.
   */
  invalidUtf8: boolean;
}

const WHAT = "config --show-scope --show-origin --list -z";
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossy = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Reads `git config --show-scope --show-origin --list -z`. Each entry is three
 * NUL-terminated fields: the scope, the origin, and the key, followed by a newline and the
 * value unless the key has none. Fields are decoded one by one, so a name that is not valid
 * UTF-8 is flagged on its own entry rather than silently altered.
 */
export function parseConfigList(zOutput: Uint8Array): ConfigEntry[] {
  if (zOutput.length === 0) return [];
  if (zOutput[zOutput.length - 1] !== 0) throw new GitParseError(WHAT, "it is not NUL-terminated");
  const fields: { text: string; valid: boolean }[] = [];
  let start = 0;
  for (let index = 0; index < zOutput.length; index += 1) {
    if (zOutput[index] !== 0) continue;
    fields.push(decode(zOutput.subarray(start, index)));
    start = index + 1;
  }
  if (fields.length % 3 !== 0) throw new GitParseError(WHAT, "an entry is incomplete");

  const entries: ConfigEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
    const item = fields[index + 2];
    if (!scope || !origin || !item) throw new GitParseError(WHAT, "an entry is incomplete");
    if (!/^[a-z-]+$/.test(scope.text)) {
      throw new GitParseError(WHAT, `unexpected scope "${scope.text.slice(0, 40)}"`);
    }
    const newline = item.text.indexOf("\n");
    const key = newline === -1 ? item.text : item.text.slice(0, newline);
    if (key === "") throw new GitParseError(WHAT, "an entry has no key");
    entries.push({
      scope: scope.text,
      origin: origin.text,
      key,
      value: newline === -1 ? null : item.text.slice(newline + 1),
      invalidUtf8: !(scope.valid && origin.valid && item.valid),
    });
  }
  return entries;
}

function decode(bytes: Uint8Array): { text: string; valid: boolean } {
  try {
    return { text: strict.decode(bytes), valid: true };
  } catch {
    return { text: lossy.decode(bytes), valid: false };
  }
}
