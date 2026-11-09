import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockingNotice, DiffView, limitNotes } from "../../../src/renderer/diff-view/DiffView";
import { oldLineToNew, resultLineToNew } from "../../../src/renderer/diff-view/line-map";
import { toPatchText, toPierreDiff } from "../../../src/renderer/diff-view/pierre/to-pierre";
import type { DiffViewMode } from "../../../src/renderer/diff-view/types";
import { parsePatch } from "../../../src/shared/diff/parse-patch";
import type { FileDiff } from "../../../src/shared/domain/diff";

// No workers in happy-dom: the adapter highlights on the main thread instead.
vi.mock("../../../src/renderer/diff-view/highlight/pool", () => ({
  DIFF_THEMES: { light: "pierre-light", dark: "pierre-dark" },
  highlightPool: () => undefined,
  highlightRequestCount: () => 0,
}));

const FIXTURE_DIR = resolve(import.meta.dirname, "../../fixtures/diffs");
const FIXTURES: ReadonlyMap<string, FileDiff> = new Map(
  readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => [file.slice(0, -5), JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))]),
);
const MODES: readonly DiffViewMode[] = ["split", "unified", "result"];

function fixture(name: string): FileDiff {
  const diff = FIXTURES.get(name);
  if (diff === undefined) throw new Error(`No fixture named ${name}`);
  return diff;
}

const withText = (diff: FileDiff) => !diff.binary && diff.hunks.length > 0;

describe("toPatchText", () => {
  it.each([...FIXTURES].filter(([, diff]) => withText(diff)))(
    "%s: round-trips through the patch parser unchanged",
    (_name, diff) => {
      const reparsed = parsePatch(toPatchText(diff));
      expect(reparsed.hunks).toEqual(diff.hunks);
      expect(reparsed.stats).toEqual(diff.stats);
    },
  );
});

describe("toPierreDiff", () => {
  it.each([...FIXTURES].filter(([, diff]) => withText(diff)))(
    "%s: keeps git's hunks and both texts",
    (_name, diff) => {
      const model = toPierreDiff(diff, "diff");
      if (model === null) throw new Error("no model");
      expect(model.name).toBe(diff.path);
      expect(model.isPartial).toBe(false);
      expect(model.hunks).toHaveLength(diff.hunks.length);
      model.hunks.forEach((hunk, index) => {
        const git = diff.hunks[index];
        if (git === undefined) throw new Error("hunk count");
        expect([hunk.deletionStart, hunk.deletionCount]).toEqual([git.oldStart, git.oldLines]);
        expect([hunk.additionStart, hunk.additionCount]).toEqual([git.newStart, git.newLines]);
        // The library may pair lines differently for display, never change which ones changed.
        const removed: string[] = [];
        const added: string[] = [];
        for (const part of hunk.hunkContent) {
          if (part.type !== "change") continue;
          for (let i = 0; i < part.deletions; i += 1) {
            removed.push(model.deletionLines[part.deletionLineIndex + i] ?? "");
          }
          for (let i = 0; i < part.additions; i += 1) {
            added.push(model.additionLines[part.additionLineIndex + i] ?? "");
          }
        }
        const strip = (line: string) => line.replace(/\n$/, "");
        expect(removed.map(strip)).toEqual(
          git.lines.filter((line) => line.kind === "remove").map((line) => line.text),
        );
        expect(added.map(strip)).toEqual(
          git.lines.filter((line) => line.kind === "add").map((line) => line.text),
        );
      });
    },
  );

  it("marks renames, additions and deletions from the FileDiff, not from its own guesses", () => {
    const rename = toPierreDiff(fixture("rename-edit"), "diff");
    expect(rename?.type).toBe("rename-changed");
    expect(rename?.prevName).toBe(fixture("rename-edit").oldPath);
    expect(toPierreDiff(fixture("added"), "diff")?.type).toBe("new");
    expect(toPierreDiff(fixture("deleted"), "diff")?.type).toBe("deleted");
  });

  it("has nothing to draw for binary and content-free changes", () => {
    expect(toPierreDiff(fixture("binary"), "diff")).toBeNull();
    expect(toPierreDiff(fixture("mode-only"), "diff")).toBeNull();
  });

  it("turns highlighting off past the limit", () => {
    const diff = fixture("small-edit");
    const plain = toPierreDiff({ ...diff, limits: { ...diff.limits, highlightOff: true } }, "diff");
    expect(plain?.lang).toBe("text");
    expect(toPierreDiff(diff, "diff")?.lang).toBeUndefined();
  });

  it.each([...FIXTURES].filter(([, diff]) => withText(diff) && diff.status !== "deleted"))(
    "%s: the resulting-file model is the right side with only its added lines marked",
    (_name, diff) => {
      const model = toPierreDiff(diff, "result");
      if (model === null || diff.right === null) throw new Error("no model");
      expect(model.additionLines.join("")).toBe(diff.right);
      let added = 0;
      let removed = 0;
      for (const hunk of model.hunks) {
        for (const part of hunk.hunkContent) {
          if (part.type === "change") {
            added += part.additions;
            removed += part.deletions;
          }
        }
      }
      expect(added).toBe(diff.stats.added);
      expect(removed).toBe(0);
    },
  );

  it("has no resulting file for a deleted file", () => {
    expect(toPierreDiff(fixture("deleted"), "result")).toBeNull();
  });
});

describe("line maps", () => {
  it("maps left-side lines to the right side through git's hunks", () => {
    const diff = fixture("small-edit");
    expect(oldLineToNew(diff, 1)).toBe(1);
    expect(oldLineToNew(diff, 12)).toBeNull(); // removed
    expect(oldLineToNew(diff, 13)).toBe(13);
    expect(oldLineToNew(diff, 60)).toBe(60);
  });

  it("shifts lines after an insertion", () => {
    const diff: FileDiff = {
      ...fixture("small-edit"),
      hunks: [
        {
          oldStart: 5,
          oldLines: 0,
          newStart: 6,
          newLines: 2,
          header: "@@ -5,0 +6,2 @@",
          lines: [
            { kind: "add", text: "a", oldNo: null, newNo: 6 },
            { kind: "add", text: "b", oldNo: null, newNo: 7 },
          ],
        },
      ],
    };
    expect(oldLineToNew(diff, 5)).toBe(5);
    expect(oldLineToNew(diff, 6)).toBe(8);
    expect(resultLineToNew(diff, 5)).toBe(5);
    expect(resultLineToNew(diff, 6)).toBe(8);
  });
});

describe("DiffView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(diff: FileDiff, mode: DiffViewMode): void {
    act(() => {
      root.render(<DiffView diff={diff} mode={mode} theme="light" contextLines={3} />);
    });
  }

  it.each([
    ["binary", "split", "Binary file changed"],
    ["mode-only", "unified", "No changes to the file's content"],
    ["deleted", "result", "no resulting file"],
  ] as const)("%s in %s mode shows a notice", (name, mode, text) => {
    render(fixture(name), mode);
    const notice = container.querySelector('[data-testid="diff-view-notice"]');
    expect(notice?.textContent).toContain(text);
    expect(container.querySelector("diffs-container")).toBeNull();
  });

  it.each(
    [...FIXTURES]
      .filter(([, diff]) => withText(diff))
      .flatMap(([name, diff]) => MODES.map((mode) => [name, mode, diff] as const))
      .filter(([, mode, diff]) => blockingNotice(diff, mode) === null),
  )("%s in %s mode mounts one library view for that file", (_name, mode, diff) => {
    render(diff, mode);
    const scroll = container.querySelectorAll<HTMLElement>('[data-testid="diff-view-scroll"]');
    expect(scroll).toHaveLength(1);
    expect(scroll[0]?.dataset.diffPath).toBe(diff.path);
    expect(scroll[0]?.dataset.diffMode).toBe(mode);
    expect(container.querySelectorAll("diffs-container")).toHaveLength(1);
  });

  it("replaces the library view when the file changes", () => {
    render(fixture("small-edit"), "split");
    const first = container.querySelector("diffs-container");
    render(fixture("unicode"), "split");
    const hosts = container.querySelectorAll("diffs-container");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toBe(first);
  });

  it("notes the limits a file hit", () => {
    const diff = fixture("small-edit");
    const limited = {
      ...diff,
      limits: { patchTruncated: true, contentOmitted: true, highlightOff: true },
    };
    expect(limitNotes(limited, "split")).toEqual([
      "The diff is too large and was cut short.",
      "Large file: showing the changes only, without the rest of the file.",
      "Highlighting off for large file.",
    ]);
    expect(blockingNotice({ ...limited, right: null, left: null }, "result")).toBe(
      "The resulting file is too large to show.",
    );
  });
});
