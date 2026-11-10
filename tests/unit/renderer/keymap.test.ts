import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandForKey,
  installKeymap,
  KEYMAP,
  shortcutLabel,
} from "../../../src/renderer/commands/keymap";
import { checkedCommands, startCommandReport } from "../../../src/renderer/commands/menu-state";
import {
  type CommandId,
  clearCommands,
  isCommandEnabled,
  registerCommand,
  runCommand,
} from "../../../src/renderer/commands/registry";
import { firstChangedLine } from "../../../src/renderer/data/first-changed-line";
import { uiStore } from "../../../src/renderer/state/ui-store";
import type { HunkLineKind } from "../../../src/shared/domain/diff";

const key = (
  k: string,
  mods: Partial<Record<"meta" | "shift" | "alt" | "ctrl", boolean>> = {},
) => ({
  key: k,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  ctrlKey: !!mods.ctrl,
});

afterEach(() => clearCommands());

describe("commandForKey", () => {
  it.each<[string, ReturnType<typeof key>, CommandId]>([
    ["⌘R", key("r", { meta: true }), "scan.refresh"],
    ["⌘T", key("t", { meta: true }), "view.timeline"],
    ["⌘⇧T", key("T", { meta: true, shift: true }), "view.tree"],
    ["⌘[", key("[", { meta: true }), "checkout.previous"],
    ["⌘]", key("]", { meta: true }), "checkout.next"],
    ["⌥↑", key("ArrowUp", { alt: true }), "file.previous"],
    ["⌥↓", key("ArrowDown", { alt: true }), "file.next"],
    ["⌘1", key("1", { meta: true }), "preview.split"],
    ["⌘2", key("2", { meta: true }), "preview.unified"],
    ["⌘3", key("3", { meta: true }), "preview.result"],
    ["⌘⇧F", key("F", { meta: true, shift: true }), "preview.focus"],
    ["⌘F", key("f", { meta: true }), "files.filter"],
    ["⌘K", key("k", { meta: true }), "comparison.settings"],
    ["⌘E", key("e", { meta: true }), "checkout.openInEditor"],
    ["⌘⇧E", key("E", { meta: true, shift: true }), "checkout.openInTerminal"],
    ["⌘⇧R", key("R", { meta: true, shift: true }), "checkout.revealInFinder"],
    ["⌘,", key(",", { meta: true }), "app.settings"],
  ])("%s runs its command", (_label, event, command) => {
    expect(commandForKey(event, false)).toBe(command);
  });

  it("needs the exact modifiers", () => {
    expect(commandForKey(key("t"), false)).toBeNull();
    expect(commandForKey(key("t", { meta: true, alt: true }), false)).toBeNull();
    expect(commandForKey(key("r", { ctrl: true }), false)).toBeNull();
    expect(commandForKey(key("ArrowDown"), false)).toBeNull();
  });

  it("leaves typing and ⌥-arrows to a text field, but not ⌘ shortcuts", () => {
    expect(commandForKey(key("ArrowDown", { alt: true }), true)).toBeNull();
    expect(commandForKey(key("k", { meta: true }), true)).toBe("comparison.settings");
  });

  it("binds every shortcut once", () => {
    const combos = KEYMAP.map((b) => `${b.meta}-${b.shift}-${b.alt}-${b.key.toLowerCase()}`);
    expect(new Set(combos).size).toBe(combos.length);
    expect(shortcutLabel("view.tree")).toBe("⇧⌘T");
    expect(shortcutLabel("file.next")).toBe("⌥↓");
  });
});

describe("commands", () => {
  it("run only while registered and enabled", () => {
    const run = vi.fn();
    let enabled = true;
    const unregister = registerCommand("scan.refresh", run, () => enabled);
    expect(runCommand("scan.refresh")).toBe(true);
    enabled = false;
    expect(isCommandEnabled("scan.refresh")).toBe(false);
    expect(runCommand("scan.refresh")).toBe(false);
    unregister();
    enabled = true;
    expect(runCommand("scan.refresh")).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a stale unregister does not remove a newer registration", () => {
    const first = registerCommand("view.timeline", () => {});
    const second = vi.fn();
    registerCommand("view.timeline", second);
    first();
    expect(runCommand("view.timeline")).toBe(true);
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("installKeymap", () => {
  it("runs the command for a shortcut and takes the key press", () => {
    const refresh = vi.fn();
    registerCommand("scan.refresh", refresh);
    const uninstall = installKeymap(window);
    const event = new KeyboardEvent("keydown", { key: "r", metaKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(refresh).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    uninstall();
  });

  it("lets a shortcut with no enabled command through", () => {
    const uninstall = installKeymap(window);
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });

  it("ignores ⌥↓ typed into a text field", () => {
    const next = vi.fn();
    registerCommand("file.next", next);
    const uninstall = installKeymap(window);
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(next).not.toHaveBeenCalled();
    input.remove();
    uninstall();
  });
});

describe("the command report for the menu", () => {
  it("names the checked items from the layout", () => {
    const ui = uiStore.getState();
    expect(
      checkedCommands({
        ...ui,
        timelineOpen: true,
        navigatorMode: "tree",
        previewMode: "unified",
        focusPreview: true,
      }),
    ).toEqual(["view.timeline", "view.tree", "preview.unified", "preview.focus"]);
    expect(
      checkedCommands({
        ...ui,
        timelineOpen: false,
        navigatorMode: "picker",
        previewMode: "result",
        focusPreview: false,
      }),
    ).toEqual(["preview.result"]);
  });

  it("sends what is enabled once per change, and nothing when nothing changed", async () => {
    const sent: { enabled: string[]; checked: string[] }[] = [];
    let enabled = true;
    registerCommand(
      "scan.refresh",
      () => {},
      () => enabled,
    );
    const stop = startCommandReport({ send: (state) => sent.push(state), checked: () => [] });
    await Promise.resolve();
    expect(sent).toEqual([{ enabled: ["scan.refresh"], checked: [] }]);

    registerCommand("checkout.copyPath", () => {});
    registerCommand("checkout.copyBranch", () => {});
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.enabled).toEqual(["scan.refresh", "checkout.copyPath", "checkout.copyBranch"]);

    enabled = false;
    clearCommands();
    registerCommand(
      "scan.refresh",
      () => {},
      () => enabled,
    );
    await Promise.resolve();
    expect(sent.at(-1)).toEqual({ enabled: [], checked: [] });
    const before = sent.length;
    registerCommand(
      "scan.refresh",
      () => {},
      () => enabled,
    );
    await Promise.resolve();
    expect(sent).toHaveLength(before);
    stop();
  });
});

describe("firstChangedLine", () => {
  const hunk = (
    newStart: number,
    newLines: number,
    lines: { kind: HunkLineKind; newNo: number | null }[],
  ) => ({
    oldStart: 1,
    oldLines: 1,
    newStart,
    newLines,
    header: "@@",
    lines: lines.map((line) => ({ ...line, text: "", oldNo: null })),
  });

  it("is the first added line, or where lines were removed", () => {
    expect(
      firstChangedLine({
        status: "modified",
        hunks: [
          hunk(10, 3, [
            { kind: "context", newNo: 10 },
            { kind: "add", newNo: 11 },
          ]),
        ],
      }),
    ).toBe(11);
    expect(
      firstChangedLine({
        status: "modified",
        hunks: [hunk(4, 0, [{ kind: "remove", newNo: null }])],
      }),
    ).toBe(5);
    expect(
      firstChangedLine({
        status: "modified",
        hunks: [hunk(0, 0, [{ kind: "remove", newNo: null }])],
      }),
    ).toBe(1);
  });

  it("is unknown for a file without hunks or a deleted file", () => {
    expect(firstChangedLine({ status: "modified", hunks: [] })).toBeUndefined();
    expect(
      firstChangedLine({
        status: "deleted",
        hunks: [hunk(0, 0, [{ kind: "remove", newNo: null }])],
      }),
    ).toBeUndefined();
  });
});
