import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUiStore,
  DEFAULT_COMPARISON,
  persistedUi,
  persistUi,
} from "../../../src/renderer/state/ui-store";
import { DEFAULT_WINDOW_UI_STATE } from "../../../src/shared/settings";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the UI store", () => {
  it("starts a newly selected checkout on the default comparison with no file", () => {
    const store = createUiStore();
    const ui = store.getState();
    ui.selectCheckout("/w/a");
    ui.setComparison({ kind: "base", ref: "main" });
    ui.selectFile({ path: "x.ts" });
    ui.setFileFilter("x");
    ui.setComparisonOpen(true);
    ui.selectCheckout("/w/b");
    expect(store.getState()).toMatchObject({
      selectedCheckout: "/w/b",
      selectedFile: null,
      comparisonKind: DEFAULT_COMPARISON,
      comparisonRef: null,
      comparisonStartOverride: null,
      comparisonOpen: false,
      fileFilter: "",
    });
    expect(DEFAULT_COMPARISON).toBe("review");
  });

  it("keeps the comparison when the same checkout is selected again, and counts reveals", () => {
    const store = createUiStore();
    store.getState().selectCheckout("/w/a");
    store.getState().setComparison({ kind: "working" });
    store.getState().selectCheckout("/w/a", { reveal: true });
    expect(store.getState().comparisonKind).toBe("working");
    expect(store.getState().revealRequest).toBe(1);
  });

  it("clears the file when the comparison changes, keeping a ref unless told", () => {
    const store = createUiStore();
    store.getState().setComparison({ kind: "base", ref: "main" });
    store.getState().selectFile({ path: "a" });
    store.getState().setComparison({ kind: "base" });
    expect(store.getState()).toMatchObject({ comparisonRef: "main", selectedFile: null });
  });

  it("applies a saved layout", () => {
    const store = createUiStore();
    const saved = {
      ...DEFAULT_WINDOW_UI_STATE,
      timelineOpen: true,
      navigatorMode: "tree" as const,
      timelineOrder: "newest" as const,
      navigatorWidth: 410,
      selectedCheckout: "/w/a",
    };
    store.getState().hydrate(saved);
    expect(persistedUi(store.getState())).toEqual(saved);
  });
});

describe("persistUi", () => {
  it("saves the layout once changes settle, and ignores what is not saved", () => {
    const store = createUiStore();
    const save = vi.fn();
    const stop = persistUi(store, save, 400);
    store.getState().setTimelineOpen(true);
    store.getState().setPreviewMode("unified");
    store.getState().setFileFilter("abc");
    vi.advanceTimersByTime(399);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ timelineOpen: true, previewMode: "unified" });

    store.getState().setFileFilter("abcd");
    vi.advanceTimersByTime(1_000);
    expect(save).toHaveBeenCalledOnce();
    stop();
  });

  it("flushes a pending save when it stops", () => {
    const store = createUiStore();
    const save = vi.fn();
    const stop = persistUi(store, save, 400);
    store.getState().setNavigatorMode("tree");
    stop();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ navigatorMode: "tree" }));
  });
});
