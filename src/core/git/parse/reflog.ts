import { GitParseError } from "../errors";
import { toText } from "./text";

/** A reflog entry: the commit HEAD pointed at, and when that was recorded. */
export interface ReflogEntry {
  commit: string;
  /** UTC, ISO 8601 to the second: `2026-11-09T08:54:36Z`. */
  observedAt: string;
}

const WHAT = "reflog show --date=iso-strict --format=%H%x09%gd -z";

/**
 * Reads `git reflog show --date=iso-strict --format=%H%x09%gd -z HEAD`, newest first, and
 * returns the oldest entry, or `null` for an empty reflog (expired, or never written).
 *
 * With `--date`, the `%gd` selector carries the entry's date: `HEAD@{2026-11-09T15:54:36+07:00}`.
 * The date is converted to UTC so starts from different time zones sort as text.
 */
export function oldestReflogEntry(zOutput: string | Uint8Array): ReflogEntry | null {
  const text = toText(zOutput);
  // Entries are NUL-terminated; tolerate a Git that only separates them.
  const fields = (text.endsWith("\0") ? text.slice(0, -1) : text).split("\0");
  const last = fields.at(-1);
  if (last === undefined || last === "") {
    if (text === "") return null;
    throw new GitParseError(WHAT, "an entry is empty");
  }
  return parseEntry(last);
}

function parseEntry(field: string): ReflogEntry {
  const tab = field.indexOf("\t");
  if (tab === -1) throw new GitParseError(WHAT, "an entry has no tab");
  const commit = field.slice(0, tab);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitParseError(WHAT, "an entry has no commit id");
  const selector = field.slice(tab + 1);
  const open = selector.lastIndexOf("@{");
  if (open === -1 || !selector.endsWith("}")) {
    throw new GitParseError(WHAT, `unexpected selector "${selector}"`);
  }
  const date = selector.slice(open + 2, -1);
  const time = Date.parse(date);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(date) || Number.isNaN(time)) {
    throw new GitParseError(WHAT, `the selector has no ISO date: "${selector}"`);
  }
  return { commit, observedAt: new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z") };
}
