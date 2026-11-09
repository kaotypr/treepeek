import { GitParseError } from "../errors";
import { nulFields, toText } from "./text";

/**
 * Reads a NUL-separated list of paths, such as `ls-files -z` or `diff --name-only -z`.
 * Paths come back exactly as Git wrote them: `-z` output is never quoted.
 */
export function parseNulList(zOutput: string | Uint8Array): string[] {
  const fields = nulFields(toText(zOutput));
  if (fields === null) throw new GitParseError("a NUL-separated list", "it is not NUL-terminated");
  if (fields.includes("")) throw new GitParseError("a NUL-separated list", "it has an empty path");
  return fields;
}
