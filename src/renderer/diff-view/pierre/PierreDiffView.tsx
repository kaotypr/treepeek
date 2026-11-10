/**
 * The `@pierre/diffs` adapter. It drives the library's vanilla classes rather than its
 * React wrappers so it owns each instance's lifetime: one virtualized instance per (file,
 * layout), torn down before the next one exists. Switching files therefore never reuses
 * an instance that still holds the previous file's state.
 */

import {
  DIFFS_TAG_NAME,
  type FileDiffOptions,
  VirtualizedFileDiff,
  Virtualizer,
} from "@pierre/diffs";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { DIFF_LIMITS } from "../../../shared/constants";
import type { FileDiff } from "../../../shared/domain/diff";
import { DIFF_THEMES, highlightPool } from "../highlight/pool";
import { oldLineToNew, resultLineToNew } from "../line-map";
import type { DiffAnchor, DiffViewMode, DiffViewProps, DiffViewTheme } from "../types";
import { labelControls } from "./a11y-labels";
import { applyStylesUnderCsp } from "./csp-styles";
import "./pierre.css";
import { toPierreDiff } from "./to-pierre";

interface Live {
  instance: VirtualizedFileDiff;
  virtualizer: Virtualizer;
  host: HTMLElement;
}

export function PierreDiffView({ diff, mode, theme, ref }: DiffViewProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Live | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const kind = mode === "result" ? "result" : "diff";
  const model = useMemo(() => toPierreDiff(diff, kind), [diff, kind]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (scroll === null || content === null || model === null) return;
    const virtualizer = new Virtualizer();
    virtualizer.setup(scroll, content);
    const host = document.createElement(DIFFS_TAG_NAME);
    content.append(host);
    const releaseStyles =
      host.shadowRoot === null ? () => {} : applyStylesUnderCsp(host.shadowRoot);
    const releaseLabels = host.shadowRoot === null ? () => {} : labelControls(host.shadowRoot);
    const instance = new VirtualizedFileDiff<undefined, undefined>(
      viewOptions(mode, themeRef.current),
      virtualizer,
      VIRTUAL_METRICS,
      highlightPool(),
    );
    instance.render({ fileDiff: model, fileContainer: host, forceRender: true });
    liveRef.current = { instance, virtualizer, host };
    return () => {
      liveRef.current = null;
      instance.cleanUp();
      virtualizer.cleanUp();
      releaseStyles();
      releaseLabels();
      host.remove();
    };
  }, [model, mode]);

  useEffect(() => {
    liveRef.current?.instance.setThemeType(theme);
  }, [theme]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToHunk: (index) => {
        const target = hunkStart(diff, index);
        if (target === null) return;
        settleScroll(liveRef, (live) => {
          const position = live.instance.getLinePosition(target.line, pierreSide(target.side));
          return position === undefined ? null : fileTop(live) + position.top;
        });
      },
      getAnchor: () => {
        const live = liveRef.current;
        if (live === null) return null;
        const viewportTop = live.virtualizer.getScrollTop() - fileTop(live);
        const anchor = live.instance.getNumericScrollAnchor(Math.max(0, viewportTop));
        if (anchor === undefined) return null;
        const offset = anchor.top - viewportTop;
        if (anchor.side !== "deletions") return { side: "new", line: anchor.lineNumber, offset };
        // The library names a context line by its left-side number; anchors prefer the right.
        if (mode === "result") {
          return { side: "new", line: resultLineToNew(diff, anchor.lineNumber), offset };
        }
        const newLine = oldLineToNew(diff, anchor.lineNumber);
        return newLine === null
          ? { side: "old", line: anchor.lineNumber, offset }
          : { side: "new", line: newLine, offset };
      },
      restoreAnchor: (anchor: DiffAnchor) => {
        const side = mode === "result" ? "new" : anchor.side;
        settleScroll(liveRef, (live) => {
          const position =
            live.instance.getLinePosition(anchor.line, pierreSide(side)) ??
            live.instance.getLinePosition(anchor.line, pierreSide(side === "new" ? "old" : "new"));
          return position === undefined ? null : fileTop(live) + position.top - anchor.offset;
        });
      },
    }),
    [diff, mode],
  );

  return (
    // A named region, focusable so the keyboard can scroll the diff (WCAG 2.1.1).
    <section
      ref={scrollRef}
      className="diff-view-scroll h-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      data-testid="diff-view-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus to be scrolled without a mouse
      tabIndex={0}
      aria-label={`Changes in ${diff.path}`}
      data-diff-path={diff.path}
      data-diff-mode={mode}
    >
      <div ref={contentRef} />
    </section>
  );
}

/**
 * Rows rendered per virtualization chunk. The library's default (50) parses enough HTML in
 * one frame to pass 50 ms under the CSP, which reports every inline style it blocks; 20
 * keeps the worst frame well under that (see docs/decisions/diff-viewer.md).
 */
const VIRTUAL_METRICS = Object.freeze({ hunkLineCount: 20 });

function viewOptions(
  mode: DiffViewMode,
  theme: DiffViewTheme,
): FileDiffOptions<undefined, undefined> {
  return {
    theme: { ...DIFF_THEMES },
    themeType: theme,
    diffStyle: mode === "split" ? "split" : "unified",
    disableFileHeader: true,
    hunkSeparators: "line-info",
    overflow: "scroll",
    // The library's own default (100,000 characters) is far below Treepeek's limit.
    tokenizeMaxLength: DIFF_LIMITS.highlightBytes,
    ...(mode === "result"
      ? { expandUnchanged: true, diffIndicators: "bars", lineDiffType: "none" }
      : { diffIndicators: "classic" }),
  };
}

/**
 * Scrolls to `target` and keeps it there while the virtualizer settles: right after a
 * mount its content is not sized yet (the first scroll is clamped), and rows it renders
 * replace estimated heights with measured ones, which moves the target. Stops once the
 * target holds for two frames in a row, or after `MAX_SETTLE_FRAMES`.
 */
function settleScroll(
  liveRef: { readonly current: Live | null },
  target: (live: Live) => number | null,
  frame = 0,
  previous: number | null = null,
): void {
  const live = liveRef.current;
  if (live === null) return;
  const top = target(live);
  if (top === null) return;
  const off = Math.abs(live.virtualizer.getScrollTop() - top) > 1;
  if (off) live.virtualizer.scrollTo({ top });
  if (!off && previous === top) return;
  if (frame >= MAX_SETTLE_FRAMES) return;
  requestAnimationFrame(() => {
    if (liveRef.current === live) settleScroll(liveRef, target, frame + 1, top);
  });
}

const MAX_SETTLE_FRAMES = 30;

function fileTop(live: Live): number {
  return live.virtualizer.getOffsetInScrollContainer(live.host);
}

function pierreSide(side: DiffAnchor["side"]): "additions" | "deletions" {
  return side === "old" ? "deletions" : "additions";
}

/** The first line of hunk `index`, on the side that has one. */
function hunkStart(
  diff: FileDiff,
  index: number,
): { side: DiffAnchor["side"]; line: number } | null {
  const hunk = diff.hunks[index];
  if (hunk === undefined) return null;
  for (const line of hunk.lines) {
    if (line.newNo !== null) return { side: "new", line: line.newNo };
    if (line.oldNo !== null) return { side: "old", line: line.oldNo };
  }
  return null;
}
