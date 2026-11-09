/**
 * Thin proof of the fallback adapter: CodeMirror 6's `MergeView` in split layout, fed both
 * texts and git's hunks (through `diffConfig.override`), so it shows git's diff rather
 * than computing its own. Built only to show the fallback renders; the trial keeps
 * whichever adapter wins.
 *
 * It mounts inside a shadow root: there CodeMirror's style loader uses constructed
 * stylesheets, which the CSP allows; on the document itself it writes `<style>` tags,
 * which `style-src 'self'` blocks.
 */

import { Change, MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useLayoutEffect, useRef } from "react";
import type { FileDiff } from "../../../shared/domain/diff";
import type { DiffViewProps } from "../types";

export function CodeMirrorDiffView({ diff, mode, theme }: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null || diff.left === null || diff.right === null || mode !== "split") return;
    const changes = gitChanges(diff, diff.left, diff.right);
    const extensions = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      EditorView.theme(
        {
          "&": { backgroundColor: "var(--card)", color: "var(--card-foreground)" },
          ".cm-gutters": { backgroundColor: "var(--card)", color: "var(--muted-foreground)" },
          ".cm-changedLine": { backgroundColor: "var(--diff-added)" },
          ".cm-deletedChunk": { backgroundColor: "var(--diff-removed)" },
        },
        { dark: theme === "dark" },
      ),
    ];
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const view = new MergeView({
      a: { doc: diff.left, extensions },
      b: { doc: diff.right, extensions },
      parent: root,
      root,
      gutter: true,
      highlightChanges: false,
      collapseUnchanged: { margin: 3, minSize: 4 },
      diffConfig: { override: () => changes },
    });
    return () => view.destroy();
  }, [diff, mode, theme]);

  return (
    <div
      ref={hostRef}
      className="h-full overflow-auto font-mono text-xs"
      data-testid="diff-view-scroll"
      data-diff-path={diff.path}
      data-diff-mode={mode}
      data-adapter="codemirror"
    />
  );
}

/** Git's hunks as character ranges: each run of removed and/or added lines is one change. */
export function gitChanges(diff: FileDiff, left: string, right: string): Change[] {
  const leftStarts = lineStarts(left);
  const rightStarts = lineStarts(right);
  const at = (starts: number[], text: string, line: number) => starts[line - 1] ?? text.length;
  const changes: Change[] = [];
  for (const hunk of diff.hunks) {
    let oldNext = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    let newNext = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    let run: { oldFrom: number; newFrom: number; oldTo: number; newTo: number } | null = null;
    const flush = () => {
      if (run === null) return;
      changes.push(
        new Change(
          at(leftStarts, left, run.oldFrom),
          at(leftStarts, left, run.oldTo),
          at(rightStarts, right, run.newFrom),
          at(rightStarts, right, run.newTo),
        ),
      );
      run = null;
    };
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        flush();
        oldNext += 1;
        newNext += 1;
      } else if (line.kind === "remove" || line.kind === "add") {
        run ??= { oldFrom: oldNext, newFrom: newNext, oldTo: oldNext, newTo: newNext };
        if (line.kind === "remove") oldNext += 1;
        else newNext += 1;
        run.oldTo = oldNext;
        run.newTo = newNext;
      }
    }
    flush();
  }
  return changes;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}
