/**
 * The renderer's only contract with the diff viewer (diff-pipeline design, "DiffView
 * interface"). Nothing outside `renderer/diff-view/` imports the viewer library.
 */

import type { Ref } from "react";
import type { FileDiff } from "../../shared/domain/diff";

export type DiffViewMode = "split" | "unified" | "result";
export type DiffViewTheme = "light" | "dark";

export interface DiffViewProps {
  diff: FileDiff;
  mode: DiffViewMode;
  /** The app's resolved theme; the viewer follows it, not the OS. */
  theme: DiffViewTheme;
  /**
   * Unchanged lines kept around each change (default 3, as in the prototype). Git applies
   * it when it writes the patch (`-U<n>`), so the hunks already carry it; the viewer only
   * expands beyond it on request.
   */
  contextLines: number;
  /** "Mark viewed and open next" (review-marks design). */
  onRequestNextFile?: () => void;
  ref?: Ref<DiffViewHandle>;
}

/**
 * Where the view is scrolled to, in terms that survive a mode change or a re-render: the
 * first visible line and how far its top sits below the top of the viewport.
 */
export interface DiffAnchor {
  /** Which side's numbering `line` uses. */
  side: "old" | "new";
  /** 1-based line number on that side. */
  line: number;
  /** Pixels from the top of the viewport to the top of that line (≤ 0 when cut off). */
  offset: number;
}

export interface DiffViewHandle {
  /** Brings hunk `index` (0-based, in `diff.hunks` order) to the top of the viewport. */
  scrollToHunk(index: number): void;
  /** The current anchor, or `null` when nothing is rendered yet. */
  getAnchor(): DiffAnchor | null;
  /** Scrolls so the anchor's line sits where it was; the nearest line when it is gone. */
  restoreAnchor(anchor: DiffAnchor): void;
}

export const DEFAULT_CONTEXT_LINES = 3;
