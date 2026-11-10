/**
 * Turns Treepeek's `FileDiff` into `@pierre/diffs` metadata without letting the library
 * diff anything itself: git's hunks are written back out as a unified patch, which the
 * library parses next to the full texts. Both views therefore show git's diff.
 */

import { type FileDiffMetadata, getFiletypeFromFileName, processFile } from "@pierre/diffs";
import type { FileDiff, Hunk } from "../../../shared/domain/diff";
import { isExcludedGrammar } from "../highlight/excluded-assets";

const MARKER = { context: " ", add: "+", remove: "-", noNewline: "\\ " } as const;

/** The hunks as a single-file unified patch, exactly as git wrote them. */
export function toPatchText(diff: FileDiff): string {
  const oldName = diff.status === "added" ? "/dev/null" : `a/${diff.oldPath ?? diff.path}`;
  const newName = diff.status === "deleted" ? "/dev/null" : `b/${diff.path}`;
  const out = [`--- ${oldName}\n`, `+++ ${newName}\n`];
  for (const hunk of diff.hunks) appendHunk(out, hunk);
  return out.join("");
}

function appendHunk(out: string[], hunk: Hunk): void {
  out.push(`${hunk.header}\n`);
  for (const line of hunk.lines) out.push(`${MARKER[line.kind]}${line.text}\n`);
}

/**
 * The view model for one file. `result` builds the resulting-file model: the right side as
 * a diff with only additions, so the whole new file shows with its changed lines marked
 * and the right side's numbering.
 */
export function toPierreDiff(diff: FileDiff, kind: "diff" | "result"): FileDiffMetadata | null {
  if (diff.binary || diff.hunks.length === 0) return null;
  if (kind === "result") return toResultModel(diff);

  const files =
    diff.left !== null && diff.right !== null
      ? {
          oldFile: { name: diff.oldPath ?? diff.path, contents: diff.left },
          newFile: { name: diff.path, contents: diff.right },
        }
      : {};
  const metadata = processFile(toPatchText(diff), {
    ...files,
    isGitDiff: false,
    cacheKey: `diff:${contentKey(diff)}`,
  });
  if (metadata === undefined) return null;
  return finish(metadata, diff);
}

/**
 * The resulting file as an "all context except the added lines" diff of the right side:
 * removed lines drop out, every hunk keeps its right-side numbers, and the left side is
 * the right side without the added lines.
 */
function toResultModel(diff: FileDiff): FileDiffMetadata | null {
  if (diff.right === null || diff.status === "deleted") return null;
  const added = new Set<number>();
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines)
      if (line.kind === "add" && line.newNo !== null) added.add(line.newNo);
  }
  const rightLines = splitKeepingEnds(diff.right);
  const leftLines = rightLines.filter((_, index) => !added.has(index + 1));
  const patch = [`--- a/${diff.path}\n`, `+++ b/${diff.path}\n`];
  let oldNo = 1;
  let newNo = 1;
  let rightIndex = 0;
  for (const hunk of diff.hunks) {
    const rows = hunk.lines.filter((line) => line.kind === "add" || line.kind === "context");
    if (rows.length === 0) continue;
    const start = rows[0]?.newNo ?? hunk.newStart;
    // Unchanged right-side lines before this hunk advance both numberings.
    while (newNo < start) {
      if (!added.has(newNo)) oldNo += 1;
      newNo += 1;
      rightIndex += 1;
    }
    const oldStart = oldNo;
    let oldCount = 0;
    const body: string[] = [];
    for (const line of rows) {
      body.push(`${line.kind === "add" ? "+" : " "}${line.text}\n`);
      if (line.kind === "context") {
        oldNo += 1;
        oldCount += 1;
      }
      newNo += 1;
      rightIndex += 1;
    }
    const noNewlineAtEnd = rightIndex >= rightLines.length && !diff.right.endsWith("\n");
    if (noNewlineAtEnd) body.push("\\ No newline at end of file\n");
    patch.push(`@@ -${oldStart},${oldCount} +${start},${rows.length} @@\n`, ...body);
  }
  const metadata = processFile(patch.join(""), {
    oldFile: { name: diff.path, contents: leftLines.join("") },
    newFile: { name: diff.path, contents: diff.right },
    isGitDiff: false,
    cacheKey: `result:${contentKey(diff)}`,
    disableLineMatching: true,
  });
  if (metadata === undefined) return null;
  return finish(metadata, diff);
}

function finish(metadata: FileDiffMetadata, diff: FileDiff): FileDiffMetadata {
  metadata.name = diff.path;
  if (diff.oldPath !== undefined && diff.oldPath !== diff.path) metadata.prevName = diff.oldPath;
  else delete metadata.prevName;
  metadata.type =
    diff.status === "added" || diff.status === "untracked"
      ? "new"
      : diff.status === "deleted"
        ? "deleted"
        : diff.oldPath !== undefined && diff.oldPath !== diff.path
          ? "rename-changed"
          : "change";
  // Past the highlighting limit the text stays plain (diff colors only), and so does a
  // language whose grammar the app does not ship: asking the highlighter for it would fail.
  if (diff.limits.highlightOff || needsExcludedGrammar(diff)) metadata.lang = "text";
  return metadata;
}

/** Whether either side's file name maps to a grammar left out of the app. */
function needsExcludedGrammar(diff: FileDiff): boolean {
  return [diff.oldPath ?? diff.path, diff.path].some((path) =>
    isExcludedGrammar(getFiletypeFromFileName(path)),
  );
}

/** Lines with their line endings, as the library splits file contents. */
function splitKeepingEnds(text: string): string[] {
  if (text === "") return [];
  return text.split(/(?<=\n)/);
}

/**
 * Identity of the content pair, for the highlight cache. `resultHash` names the right side;
 * the left side is hashed, since the same right side can be compared with different lefts.
 */
function contentKey(diff: FileDiff): string {
  return `${diff.oldPath ?? diff.path}\0${diff.path}\0${diff.resultHash}\0${fnv1a(diff.left ?? "")}\0${diff.limits.highlightOff ? "plain" : "hl"}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
