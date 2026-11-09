/**
 * One file's diff, as the diff pipeline returns it: hunks parsed from Git's unified patch,
 * plus the full texts within the size limits.
 */

import type { FileStatus } from "./compare";

export type HunkLineKind = "context" | "add" | "remove" | "noNewline";

/** One line of a hunk. */
export interface HunkLine {
  kind: HunkLineKind;
  /**
   * The line's content without its `+`, `-` or space marker and without the trailing LF.
   * The CR of a CRLF line stays, so line-ending changes remain visible. For `noNewline`, the
   * marker's text after `\ ` (`No newline at end of file`).
   */
  text: string;
  /** Line number on the left side; `null` for `add` and `noNewline` lines. */
  oldNo: number | null;
  /** Line number on the right side; `null` for `remove` and `noNewline` lines. */
  newNo: number | null;
}

/**
 * One contiguous change region within a file, identified by its position in the file's
 * patch. A `noNewline` line applies to the line just before it.
 */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The `@@ -a,b +c,d @@ section` line exactly as Git wrote it. */
  header: string;
  lines: HunkLine[];
}

/** Lines added and removed. */
export interface DiffStats {
  added: number;
  removed: number;
}

/** Which size limits a `FileDiff` hit. */
export interface DiffLimits {
  /** The patch was cut at a hunk boundary. */
  patchTruncated: boolean;
  /** `left` and `right` were left out. */
  contentOmitted: boolean;
  /** Syntax highlighting is off for this file. */
  highlightOff: boolean;
}

/** The payload of `diff.file`. */
export interface FileDiff {
  /** From the `FileChange`. */
  path: string;
  /** From the `FileChange`. */
  oldPath?: string;
  /** From the `FileChange`. */
  status: FileStatus;
  /** No text views; a notice instead. */
  binary: boolean;
  /** Parsed hunks; empty for binary files. */
  hunks: Hunk[];
  /** Full left text, or `null` when over the content limit or binary. */
  left: string | null;
  /** Full right text, or `null` when over the content limit or binary. */
  right: string | null;
  stats: DiffStats;
  limits: DiffLimits;
  /** Echo of the right side's identity, for review marks. */
  resultHash: string;
}
