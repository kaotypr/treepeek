import type { FileDiff } from "../../shared/domain/diff";

/**
 * The line an editor should open a file at: the first added line on the new side, or,
 * when a hunk only removes lines, the line where they were. `undefined` with no hunks (a
 * binary file, a mode change) or for a deleted file, which has no new side.
 */
export function firstChangedLine(diff: Pick<FileDiff, "hunks" | "status">): number | undefined {
  if (diff.status === "deleted") return undefined;
  for (const hunk of diff.hunks) {
    const added = hunk.lines.find((line) => line.kind === "add" && line.newNo !== null);
    if (added?.newNo) return added.newNo;
    if (hunk.lines.some((line) => line.kind === "remove")) {
      // A pure removal: `newStart` is the line before the gap (0 at the top of the file).
      return Math.max(1, hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart);
    }
  }
  return undefined;
}
