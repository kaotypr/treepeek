import { GitParseError } from "../errors";
import { nulFields, toText } from "./text";

/**
 * Git's raw status letters: Added, Copied, Deleted, Modified, Renamed, Type changed,
 * Unmerged, unknown (X).
 */
export type RawStatus = "A" | "C" | "D" | "M" | "R" | "T" | "U" | "X";

/** One entry of `diff --raw`: both modes and both blob ids in one pass. */
export interface RawEntry {
  status: RawStatus;
  /** Similarity percentage for a rename or copy (`R086` → 86); for `M`, dissimilarity when Git reports one. */
  score?: number;
  /** Mode on the left, `000000` when the path is absent there. */
  oldMode: string;
  /** Mode on the right, `000000` when the path is absent there. */
  newMode: string;
  /** Blob id on the left; all zeros when absent. */
  oldOid: string;
  /** Blob id on the right; all zeros when absent, or for a working-tree side Git did not hash. */
  newOid: string;
  /** The left path, for a rename or copy only. */
  oldPath?: string;
  /** The path (the right-side path for a rename or copy). */
  path: string;
}

const WHAT = "diff --raw -z";
const HEADER = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRTUX])(\d{0,3})$/;

/**
 * Reads `git diff --raw -z` (with full ids from `--abbrev=40` or `--no-abbrev`). Each
 * entry is a header field then its path, or two paths (left, right) for a rename or copy.
 */
export function parseRawDiff(zOutput: string | Uint8Array): RawEntry[] {
  const fields = nulFields(toText(zOutput));
  if (fields === null) throw new GitParseError(WHAT, "it is not NUL-terminated");
  const entries: RawEntry[] = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index] ?? "";
    const match = HEADER.exec(header);
    if (!match) throw new GitParseError(WHAT, `unexpected entry header "${header}"`);
    const [, oldMode = "", newMode = "", oldOid = "", newOid = "", letter = "", score = ""] = match;
    const status = letter as RawStatus;
    const twoPaths = status === "R" || status === "C";
    const first = fields[index + 1];
    const second = twoPaths ? fields[index + 2] : undefined;
    if (!first || (twoPaths && !second)) throw new GitParseError(WHAT, "an entry has no path");
    const entry: RawEntry = { status, oldMode, newMode, oldOid, newOid, path: first };
    if (twoPaths && second) {
      entry.oldPath = first;
      entry.path = second;
    }
    if (score !== "") entry.score = Number(score);
    entries.push(entry);
    index += twoPaths ? 3 : 2;
  }
  return entries;
}
