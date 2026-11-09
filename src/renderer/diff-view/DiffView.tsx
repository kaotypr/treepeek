/**
 * The diff viewer the rest of the renderer uses. It decides what can be shown (binary
 * files, content-free changes, omitted contents, truncated patches) and hands everything
 * else to the adapter for the chosen library.
 */

import type { FileDiff } from "../../shared/domain/diff";
import { PierreDiffView } from "./pierre/PierreDiffView";
import type { DiffViewProps } from "./types";

export function DiffView(props: DiffViewProps) {
  const { diff, mode } = props;
  const blocked = blockingNotice(diff, mode);
  const notes = limitNotes(diff, mode);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="diff-view">
      {notes.length > 0 && (
        <ul className="shrink-0 border-border border-b bg-muted px-3 py-1.5 text-muted-foreground text-xs">
          {notes.map((note) => (
            <li key={note} data-testid="diff-view-note">
              {note}
            </li>
          ))}
        </ul>
      )}
      <div className="min-h-0 flex-1">
        {blocked === null ? (
          <PierreDiffView {...props} />
        ) : (
          <p
            className="p-6 text-muted-foreground text-sm"
            data-testid="diff-view-notice"
            data-diff-path={diff.path}
            data-diff-mode={mode}
          >
            {blocked}
          </p>
        )}
      </div>
    </div>
  );
}

/** Why nothing can be drawn for this file in this mode, or `null` when it can. */
export function blockingNotice(diff: FileDiff, mode: DiffViewProps["mode"]): string | null {
  if (diff.binary) return "Binary file changed. There is no text to compare.";
  if (diff.hunks.length === 0) return "No changes to the file's content.";
  if (mode === "result") {
    if (diff.status === "deleted") return "The file was deleted, so there is no resulting file.";
    if (diff.right === null) return "The resulting file is too large to show.";
  }
  return null;
}

/** Limits the file hit, as one-line notes above the view. */
export function limitNotes(diff: FileDiff, mode: DiffViewProps["mode"]): string[] {
  const notes: string[] = [];
  if (diff.limits.patchTruncated) notes.push("The diff is too large and was cut short.");
  if (diff.limits.contentOmitted && mode !== "result") {
    notes.push("Large file: showing the changes only, without the rest of the file.");
  }
  if (diff.limits.highlightOff) notes.push("Highlighting off for large file.");
  return notes;
}
