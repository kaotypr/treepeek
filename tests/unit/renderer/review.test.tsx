import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, Providers } from "../../../src/renderer/app/providers";
import { commandForKey, installKeymap, shortcutLabel } from "../../../src/renderer/commands/keymap";
import { startCommandReport } from "../../../src/renderer/commands/menu-state";
import { clearCommands, registerCommand } from "../../../src/renderer/commands/registry";
import { progressLabel } from "../../../src/renderer/components/ProgressRing";
import {
  useCachedReviewStatus,
  useMarkAll,
  useMarkFiles,
  useReviewStatus,
} from "../../../src/renderer/data/hooks/useReviewStatus";
import { hideViewedFiles } from "../../../src/renderer/data/hooks/useSelection";
import { keys } from "../../../src/renderer/data/keys";
import {
  reviewFileOf,
  undoRequests,
  withAllMarks,
  withMarks,
} from "../../../src/renderer/data/review-model";
import { progressText } from "../../../src/renderer/panels/navigator/FolderPicker";
import { formatBytes } from "../../../src/renderer/screens/settings/AdvancedSection";
import { createUiStore, uiStore } from "../../../src/renderer/state/ui-store";
import { createUndoStore, UNDO_LIMIT, undoStore } from "../../../src/renderer/state/undo";
import type { FileChange } from "../../../src/shared/domain/compare";
import type { ReviewStatus } from "../../../src/shared/domain/review";

const status = (files: ReviewStatus["files"]): ReviewStatus => ({
  checkoutPath: "/w/a",
  worktreeId: "w",
  total: files.length,
  viewed: files.filter((file) => file.state === "viewed").length,
  changedSinceViewed: files.filter((file) => file.state === "changedSinceViewed").length,
  partialScope: false,
  files,
});

const SAMPLE = status([
  { path: "a.txt", state: "viewed" },
  {
    path: "b.txt",
    state: "changedSinceViewed",
    viewedHash: "1".repeat(40),
    earlierAvailable: true,
  },
  { path: "c/d.txt", state: "unviewed" },
]);

const change = (path: string): FileChange => ({
  path,
  status: "modified",
  left: { kind: "commit", oid: "0".repeat(40) },
  right: { kind: "workingTree" },
  resultHash: "2".repeat(40),
  binary: false,
});

afterEach(() => clearCommands());

describe("the review model", () => {
  it("finds a file by path in the sorted list", () => {
    expect(reviewFileOf(SAMPLE, "b.txt")?.state).toBe("changedSinceViewed");
    expect(reviewFileOf(SAMPLE, "c/d.txt")?.state).toBe("unviewed");
    expect(reviewFileOf(SAMPLE, "zzz")).toBeUndefined();
    expect(reviewFileOf(undefined, "a.txt")).toBeUndefined();
  });

  it("marks and unmarks files as the core service will, recounting", () => {
    const marked = withMarks(SAMPLE, new Set(["b.txt", "c/d.txt"]), true);
    expect(marked).toMatchObject({ total: 3, viewed: 3, changedSinceViewed: 0 });
    expect(marked.files[1]).toEqual({ path: "b.txt", state: "viewed" });
    expect(withAllMarks(SAMPLE, false)).toMatchObject({ viewed: 0, changedSinceViewed: 0 });
    // Paths outside the scope change nothing.
    expect(withMarks(SAMPLE, new Set(["nope"]), true)).toEqual(SAMPLE);
  });

  it("splits an undo into the versions to restore and the marks to drop", () => {
    expect(
      undoRequests([
        { path: "a.txt", resultHash: "1".repeat(40) },
        { path: "b.txt", resultHash: null },
        { path: "c.txt", resultHash: `deleted:${"2".repeat(40)}` },
      ]),
    ).toEqual({
      restore: {
        paths: ["a.txt", "c.txt"],
        resultHashes: ["1".repeat(40), `deleted:${"2".repeat(40)}`],
      },
      clear: ["b.txt"],
    });
  });

  it("hides viewed files but keeps the selected one", () => {
    const files = ["a.txt", "b.txt", "c/d.txt", "outside.txt"].map(change);
    expect(hideViewedFiles(files, SAMPLE, null).map((file) => file.path)).toEqual([
      "b.txt",
      "c/d.txt",
      "outside.txt",
    ]);
    expect(hideViewedFiles(files, SAMPLE, { path: "a.txt" }).map((file) => file.path)).toContain(
      "a.txt",
    );
    expect(hideViewedFiles(files, undefined, null)).toHaveLength(4);
  });

  it("describes progress for rings, the picker and VoiceOver", () => {
    expect(progressLabel(SAMPLE)).toBe("1 of 3 files reviewed, 33%, 1 changed since viewed");
    expect(progressLabel(status([]))).toBe("No changes");
    expect(progressLabel(undefined)).toBe("Review progress not known yet");
    expect(progressLabel(withAllMarks(SAMPLE, true))).toBe("Reviewed, all 3 files");
    expect(progressText(SAMPLE)).toBe("  33% •");
    expect(progressText(withAllMarks(SAMPLE, true))).toBe("  ✓");
    expect(progressText(status([]))).toBe("");
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(500 * 1024 * 1024)).toBe("500 MB");
  });
});

describe("the UI and undo stores", () => {
  it("forgets Since you viewed when another file, checkout or comparison is chosen", () => {
    const store = createUiStore();
    const ui = store.getState();
    ui.selectCheckout("/w/a");
    ui.selectFile({ path: "a.txt" });
    ui.setSinceViewed(true);
    ui.selectFile({ path: "a.txt" });
    expect(store.getState().sinceViewed).toBe(true);
    ui.selectFile({ path: "b.txt" });
    expect(store.getState().sinceViewed).toBe(false);
    ui.setSinceViewed(true);
    ui.setComparison({ kind: "working" });
    expect(store.getState().sinceViewed).toBe(false);
  });

  it("keeps the last undo steps, newest on top", () => {
    const store = createUndoStore();
    for (let index = 0; index < UNDO_LIMIT + 3; index += 1) {
      store.getState().push({ checkoutPath: `/w/${index}`, action: "markAll", previous: [] });
    }
    expect(store.getState().entries).toHaveLength(UNDO_LIMIT);
    expect(store.getState().pop()?.checkoutPath).toBe(`/w/${UNDO_LIMIT + 2}`);
    store.getState().clear();
    expect(store.getState().pop()).toBeUndefined();
  });
});

const key = (k: string, mods: Partial<Record<"meta" | "shift" | "alt", boolean>> = {}) => ({
  key: k,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  ctrlKey: false,
});

describe("the review shortcuts", () => {
  it("binds V, ⌘↩ and ⌘Z", () => {
    expect(commandForKey(key("v"), false)).toBe("file.toggleViewed");
    expect(commandForKey(key("V"), false)).toBe("file.toggleViewed");
    expect(commandForKey(key("Enter", { meta: true }), false)).toBe("file.markViewedAndNext");
    expect(commandForKey(key("z", { meta: true }), false)).toBe("review.undo");
    expect(shortcutLabel("file.markViewedAndNext")).toBe("⌘↩");
    expect(shortcutLabel("file.toggleViewed")).toBe("V");
  });

  it("leaves V and ⌘Z to a text field, and V to a select's type-to-find", () => {
    expect(commandForKey(key("v"), true)).toBeNull();
    expect(commandForKey(key("z", { meta: true }), true)).toBeNull();
    expect(commandForKey(key("Enter", { meta: true }), true)).toBe("file.markViewedAndNext");

    const toggled = vi.fn();
    registerCommand("file.toggleViewed", toggled);
    const uninstall = installKeymap(window);
    const select = document.createElement("select");
    document.body.append(select);
    const typed = new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true });
    select.dispatchEvent(typed);
    expect(toggled).not.toHaveBeenCalled();
    const pressed = new KeyboardEvent("keydown", { key: "v", cancelable: true });
    window.dispatchEvent(pressed);
    expect(toggled).toHaveBeenCalledOnce();
    expect(pressed.defaultPrevented).toBe(true);
    select.remove();
    uninstall();
  });

  it("reports the Viewed check mark a command gives for the menu", async () => {
    const sent: { enabled: string[]; checked: string[] }[] = [];
    let viewed = false;
    registerCommand(
      "file.toggleViewed",
      () => {},
      () => true,
      () => viewed,
    );
    const stop = startCommandReport({ send: (state) => sent.push(state), checked: () => [] });
    await Promise.resolve();
    expect(sent.at(-1)?.checked).toEqual([]);
    viewed = true;
    registerCommand("scan.refresh", () => {});
    await Promise.resolve();
    expect(sent.at(-1)?.checked).toEqual(["file.toggleViewed"]);
    stop();
  });
});

function useHooks() {
  return { mark: useMarkFiles(), markAll: useMarkAll() };
}
type Hooks = ReturnType<typeof useHooks>;

/** Hands the marking hooks to the test. */
function Probe({ use }: { use: (api: Hooks) => void }) {
  use(useHooks());
  return null;
}

describe("marking from the renderer", () => {
  let container: HTMLDivElement;
  let root: Root;
  type Answer =
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } };
  let answer: (value: Answer) => void;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pending = () =>
      new Promise<Answer>((resolve) => {
        answer = resolve;
      });
    Object.defineProperty(window, "treepeek", {
      value: { core: { review: { mark: pending, markAll: pending } }, on: () => () => {} },
      configurable: true,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    uiStore.getState().clearNotice();
    undoStore.getState().clear();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(use: (api: Hooks) => void) {
    const client = createQueryClient();
    client.setQueryData(keys.reviewStatus("/w/a"), SAMPLE);
    await act(async () => {
      root.render(
        <Providers client={client}>
          <Probe use={use} />
        </Providers>,
      );
    });
    return client;
  }

  it("shows a mark at once, and rolls it back with an error notice when the core refuses", async () => {
    let api: Hooks | undefined;
    const client = await mount((hooks) => {
      api = hooks;
    });
    await act(async () => {
      api?.mark.mutate({ checkoutPath: "/w/a", paths: ["c/d.txt"], viewed: true });
    });
    expect(client.getQueryData<ReviewStatus>(keys.reviewStatus("/w/a"))).toMatchObject({
      viewed: 2,
    });
    await act(async () => {
      answer({ ok: false, error: { code: "invalidRequest", message: "Not in the scope." } });
    });
    await vi.waitFor(() =>
      expect(client.getQueryData<ReviewStatus>(keys.reviewStatus("/w/a"))).toEqual(SAMPLE),
    );
    expect(uiStore.getState().notice).toMatchObject({
      tone: "error",
      text: "Could not mark as viewed: Not in the scope.",
    });
  });

  it("puts what Mark all replaced on the undo stack once the core has done it", async () => {
    let api: Hooks | undefined;
    const client = await mount((hooks) => {
      api = hooks;
    });
    await act(async () => {
      api?.markAll.mutate({ checkoutPath: "/w/a", viewed: true });
    });
    expect(client.getQueryData<ReviewStatus>(keys.reviewStatus("/w/a"))).toMatchObject({
      viewed: 3,
    });
    expect(undoStore.getState().entries).toEqual([]);
    const done = withAllMarks(SAMPLE, true);
    const previous = [
      { path: "b.txt", resultHash: "1".repeat(40) },
      { path: "c/d.txt", resultHash: null },
    ];
    await act(async () => {
      answer({ ok: true, value: { status: done, previous } });
    });
    await vi.waitFor(() =>
      expect(undoStore.getState().entries).toEqual([
        { checkoutPath: "/w/a", action: "markAll", previous },
      ]),
    );
  });
});

/** The checkout details: the one place that asks the core service for a status. */
function Details({ path }: { path: string }) {
  useReviewStatus(path);
  return null;
}

/** A row, a ring or the file list: reads the cache only. */
function Row({ path }: { path: string }) {
  useCachedReviewStatus(path);
  return null;
}

describe("asking for review status again", () => {
  let container: HTMLDivElement;
  let root: Root;
  let asked: string[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    asked = [];
    const answers = [SAMPLE, withAllMarks(SAMPLE, true)];
    const statusCall = async ({ checkoutPaths }: { checkoutPaths: string[] }) => {
      asked.push(...checkoutPaths);
      return { ok: true, value: [answers[Math.min(asked.length, answers.length) - 1]] };
    };
    Object.defineProperty(window, "treepeek", {
      value: { core: { review: { status: statusCall } }, on: () => () => {} },
      configurable: true,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("refetches the selected checkout after a scan, even when a cache reader rendered last", async () => {
    const client = createQueryClient();
    await act(async () => {
      root.render(
        <Providers client={client}>
          <Details path="/w/a" />
          <Row path="/w/a" />
          <Row path="/w/b" />
        </Providers>,
      );
    });
    await vi.waitFor(() => expect(asked).toEqual(["/w/a"]));

    // What ScanWindow does once a scan is done.
    await act(async () => {
      await client.invalidateQueries({ queryKey: keys.reviewStatuses() });
    });

    const query = client.getQueryCache().find({ queryKey: keys.reviewStatus("/w/a") });
    expect(query?.state.error ?? null).toBeNull();
    expect(asked).toEqual(["/w/a", "/w/a"]);
    expect(client.getQueryData<ReviewStatus>(keys.reviewStatus("/w/a"))).toMatchObject({
      viewed: 3,
    });
    // A checkout only rows show is left to the core service's `review.changed`.
    expect(
      client.getQueryCache().find({ queryKey: keys.reviewStatus("/w/b") })?.state.error ?? null,
    ).toBeNull();
  });
});
