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
import type { DiffAnchor, DiffViewMode, DiffViewProps, DiffViewTheme } from "../types";
import { applyStylesUnderCsp } from "./csp-styles";
import "./pierre.css";
import { toPierreDiff } from "./to-pierre";

interface Live {
  instance: VirtualizedFileDiff;
  virtualizer: Virtualizer;
  host: HTMLElement;
}

export function PierreDiffView({ diff, mode, theme, ref }: DiffViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
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
    const instance = new VirtualizedFileDiff<undefined, undefined>(
      viewOptions(mode, themeRef.current),
      virtualizer,
      undefined,
      highlightPool(),
    );
    instance.render({ fileDiff: model, fileContainer: host, forceRender: true });
    liveRef.current = { instance, virtualizer, host };
    return () => {
      liveRef.current = null;
      instance.cleanUp();
      virtualizer.cleanUp();
      releaseStyles();
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
        const live = liveRef.current;
        const target = hunkStart(diff, index);
        if (live === null || target === null) return;
        const position = live.instance.getLinePosition(target.line, pierreSide(target.side));
        if (position === undefined) return;
        live.virtualizer.scrollTo({ top: fileTop(live) + position.top });
      },
      getAnchor: () => {
        const live = liveRef.current;
        if (live === null) return null;
        const viewportTop = live.virtualizer.getScrollTop() - fileTop(live);
        const anchor = live.instance.getNumericScrollAnchor(Math.max(0, viewportTop));
        if (anchor === undefined) return null;
        const side = anchor.side === "deletions" ? "old" : "new";
        return { side, line: anchor.lineNumber, offset: anchor.top - viewportTop };
      },
      restoreAnchor: (anchor: DiffAnchor) => {
        const live = liveRef.current;
        if (live === null) return;
        const side = mode === "result" ? "new" : anchor.side;
        const position =
          live.instance.getLinePosition(anchor.line, pierreSide(side)) ??
          live.instance.getLinePosition(anchor.line, pierreSide(side === "new" ? "old" : "new"));
        if (position === undefined) return;
        live.virtualizer.scrollTo({ top: fileTop(live) + position.top - anchor.offset });
      },
    }),
    [diff, mode],
  );

  return (
    <div
      ref={scrollRef}
      className="diff-view-scroll h-full overflow-auto"
      data-testid="diff-view-scroll"
      data-diff-path={diff.path}
      data-diff-mode={mode}
    >
      <div ref={contentRef} />
    </div>
  );
}

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
