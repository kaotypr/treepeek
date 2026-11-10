/**
 * The window's UI state (Zustand): what is selected, which comparison and preview mode,
 * which panels show. Core data lives in the query cache; this holds only choices.
 *
 * The layout part (`persistedUi`) is saved per window through `window.state` and comes back
 * when the window is restored.
 */

import { createStore, useStore } from "zustand";
import type { FileCategory, ListableComparisonKind } from "../../shared/domain/compare";
import {
  DEFAULT_WINDOW_UI_STATE,
  type NavigatorMode,
  type PreviewMode,
  type TimelineGrouping,
  type TimelineOrder,
  type WindowUiState,
} from "../../shared/settings";

/** The comparison a newly selected checkout starts on until the setting has arrived. */
export const DEFAULT_COMPARISON: ListableComparisonKind = "review";

/** A short message about an action that just ran ("Copied the commit"), or what went wrong. */
export interface Notice {
  text: string;
  tone: "info" | "error";
  /** Tells two equal messages in a row apart, so each is announced. */
  id: number;
}

export interface FileSelection {
  path: string;
  /** Only in the `working` comparison, where one path can be listed once per category. */
  category?: FileCategory;
}

export interface UiState {
  selectedCheckout: string | null;
  selectedFile: FileSelection | null;
  comparisonKind: ListableComparisonKind;
  /** The base ref for `base`. */
  comparisonRef: string | null;
  /** A start for this comparison only (not stored), for the kinds that use a start. */
  comparisonStartOverride: string | null;
  comparisonOpen: boolean;
  /** The comparison a newly selected checkout starts on (Settings › Review). */
  defaultComparison: ListableComparisonKind;
  /** The "Set start" dialog of the selected checkout is open. */
  startDialogOpen: boolean;
  notice: Notice | null;
  previewMode: PreviewMode;
  focusPreview: boolean;
  timelineOpen: boolean;
  navigatorMode: NavigatorMode;
  timelineGrouping: TimelineGrouping;
  timelineOrder: TimelineOrder;
  fileFilter: string;
  timelineWidth: number | null;
  navigatorWidth: number | null;
  /** Bumped to ask the file filter to take focus (⌘F). */
  filterFocusRequest: number;
  /** Bumped when a selection should be scrolled into view in the navigator. */
  revealRequest: number;
}

export interface UiActions {
  /** Selects a checkout; a new checkout starts on the default comparison with no file. */
  selectCheckout(path: string | null, options?: { reveal?: boolean }): void;
  selectFile(file: FileSelection | null): void;
  setComparison(comparison: {
    kind: ListableComparisonKind;
    ref?: string | null;
    startOverride?: string | null;
  }): void;
  setComparisonOpen(open: boolean): void;
  setDefaultComparison(kind: ListableComparisonKind): void;
  setStartDialogOpen(open: boolean): void;
  showNotice(text: string, tone?: Notice["tone"]): void;
  clearNotice(): void;
  setPreviewMode(mode: PreviewMode): void;
  setFocusPreview(focus: boolean): void;
  setTimelineOpen(open: boolean): void;
  setNavigatorMode(mode: NavigatorMode): void;
  setTimelineGrouping(grouping: TimelineGrouping): void;
  setTimelineOrder(order: TimelineOrder): void;
  setFileFilter(filter: string): void;
  requestFilterFocus(): void;
  setPanelWidths(widths: { timelineWidth?: number | null; navigatorWidth?: number | null }): void;
  /** Applies a saved layout (a restored window). */
  hydrate(ui: WindowUiState): void;
}

export type UiStore = UiState & UiActions;

function initialState(): UiState {
  return {
    selectedCheckout: null,
    selectedFile: null,
    comparisonKind: DEFAULT_COMPARISON,
    comparisonRef: null,
    comparisonStartOverride: null,
    comparisonOpen: false,
    defaultComparison: DEFAULT_COMPARISON,
    startDialogOpen: false,
    notice: null,
    previewMode: DEFAULT_WINDOW_UI_STATE.previewMode,
    focusPreview: false,
    timelineOpen: DEFAULT_WINDOW_UI_STATE.timelineOpen,
    navigatorMode: DEFAULT_WINDOW_UI_STATE.navigatorMode,
    timelineGrouping: DEFAULT_WINDOW_UI_STATE.timelineGrouping,
    timelineOrder: DEFAULT_WINDOW_UI_STATE.timelineOrder,
    fileFilter: "",
    timelineWidth: null,
    navigatorWidth: null,
    filterFocusRequest: 0,
    revealRequest: 0,
  };
}

export function createUiStore() {
  return createStore<UiStore>()((set) => ({
    ...initialState(),
    selectCheckout: (path, options) =>
      set((state) => {
        const reveal = options?.reveal ? state.revealRequest + 1 : state.revealRequest;
        if (path === state.selectedCheckout) return { revealRequest: reveal };
        return {
          selectedCheckout: path,
          selectedFile: null,
          comparisonKind: state.defaultComparison,
          comparisonRef: null,
          comparisonStartOverride: null,
          comparisonOpen: false,
          startDialogOpen: false,
          fileFilter: "",
          revealRequest: reveal,
        };
      }),
    selectFile: (file) => set({ selectedFile: file }),
    setComparison: ({ kind, ref, startOverride }) =>
      set((state) => ({
        comparisonKind: kind,
        comparisonRef: ref === undefined ? state.comparisonRef : ref,
        comparisonStartOverride:
          startOverride === undefined ? state.comparisonStartOverride : startOverride,
        selectedFile: null,
      })),
    setComparisonOpen: (open) => set({ comparisonOpen: open }),
    setDefaultComparison: (kind) => set({ defaultComparison: kind }),
    setStartDialogOpen: (open) => set({ startDialogOpen: open }),
    showNotice: (text, tone = "info") =>
      set((state) => ({ notice: { text, tone, id: (state.notice?.id ?? 0) + 1 } })),
    clearNotice: () => set({ notice: null }),
    setPreviewMode: (mode) => set({ previewMode: mode }),
    setFocusPreview: (focus) => set({ focusPreview: focus }),
    setTimelineOpen: (open) => set({ timelineOpen: open }),
    setNavigatorMode: (mode) => set({ navigatorMode: mode }),
    setTimelineGrouping: (grouping) => set({ timelineGrouping: grouping }),
    setTimelineOrder: (order) => set({ timelineOrder: order }),
    setFileFilter: (filter) => set({ fileFilter: filter }),
    requestFilterFocus: () =>
      set((state) => ({ filterFocusRequest: state.filterFocusRequest + 1 })),
    setPanelWidths: (widths) =>
      set((state) => ({
        timelineWidth:
          widths.timelineWidth === undefined ? state.timelineWidth : widths.timelineWidth,
        navigatorWidth:
          widths.navigatorWidth === undefined ? state.navigatorWidth : widths.navigatorWidth,
      })),
    hydrate: (ui) =>
      set({
        timelineOpen: ui.timelineOpen,
        navigatorMode: ui.navigatorMode,
        timelineGrouping: ui.timelineGrouping,
        timelineOrder: ui.timelineOrder,
        previewMode: ui.previewMode,
        timelineWidth: ui.timelineWidth,
        navigatorWidth: ui.navigatorWidth,
        selectedCheckout: ui.selectedCheckout,
      }),
  }));
}

/** The part of the state a window saves. */
export function persistedUi(state: UiState): WindowUiState {
  return {
    timelineOpen: state.timelineOpen,
    navigatorMode: state.navigatorMode,
    timelineGrouping: state.timelineGrouping,
    timelineOrder: state.timelineOrder,
    previewMode: state.previewMode,
    timelineWidth: state.timelineWidth,
    navigatorWidth: state.navigatorWidth,
    selectedCheckout: state.selectedCheckout,
  };
}

function samePersisted(a: WindowUiState, b: WindowUiState): boolean {
  return (Object.keys(a) as (keyof WindowUiState)[]).every((key) => a[key] === b[key]);
}

/**
 * Saves the layout through `save` whenever it changes, at most once per `delayMs`.
 * Answers the unsubscribe function.
 */
export function persistUi(
  store: ReturnType<typeof createUiStore>,
  save: (ui: WindowUiState) => void,
  delayMs = 400,
): () => void {
  let last = persistedUi(store.getState());
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = store.subscribe((state) => {
    const next = persistedUi(state);
    if (samePersisted(next, last)) return;
    last = next;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save(last);
    }, delayMs);
  });
  return () => {
    unsubscribe();
    if (timer !== null) {
      clearTimeout(timer);
      save(last);
    }
  };
}

/** The one store of this window (a renderer process shows one window). */
export const uiStore = createUiStore();

export function useUi<T>(selector: (state: UiStore) => T): T {
  return useStore(uiStore, selector);
}
