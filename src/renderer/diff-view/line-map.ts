/**
 * Line-number translation between a diff's left and right sides, from git's hunks. Anchors
 * use right-side numbers where a line has one, so they survive a change of mode.
 */

import type { FileDiff, Hunk } from "../../shared/domain/diff";

/**
 * The right-side number of left-side line `oldLine`, or `null` when git removed it. Lines
 * outside every hunk are unchanged and shift by the hunks before them.
 */
export function oldLineToNew(diff: FileDiff, oldLine: number): number | null {
  let shift = 0;
  for (const hunk of diff.hunks) {
    const oldFirst = firstLine(hunk.oldStart, hunk.oldLines);
    if (oldLine < oldFirst) break;
    if (oldLine < oldFirst + hunk.oldLines) {
      const line = hunk.lines.find((entry) => entry.oldNo === oldLine);
      return line?.kind === "context" ? line.newNo : null;
    }
    shift = firstLine(hunk.newStart, hunk.newLines) + hunk.newLines - (oldFirst + hunk.oldLines);
  }
  return oldLine + shift;
}

/**
 * The resulting-file model's left side is the right side without its added lines; this
 * maps a line of that left side back to its right-side number.
 */
export function resultLineToNew(diff: FileDiff, keptLine: number): number {
  const added: number[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines)
      if (line.kind === "add" && line.newNo !== null) added.push(line.newNo);
  }
  added.sort((a, b) => a - b);
  let line = keptLine;
  for (const number of added) {
    if (number <= line) line += 1;
    else break;
  }
  return line;
}

/** Git writes an empty side's start as the line before the change. */
function firstLine(start: number, count: Hunk["oldLines"]): number {
  return count === 0 ? start + 1 : start;
}
