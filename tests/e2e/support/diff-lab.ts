/**
 * Helpers for driving the diff lab (`renderer/dev/diff-lab`) in the lab build.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { FileDiff } from "../../../src/shared/domain/diff";

export type Mode = "split" | "unified" | "result";
export const MODES: readonly Mode[] = ["split", "unified", "result"];

/** `window.__diffLab`, as `renderer/dev/diff-lab/DiffLab.tsx` defines it. */
interface DiffLabControl {
  fixtures(): string[];
  select(name: string): Promise<void>;
  setMode(mode: Mode): void;
  rapidSwitch(seed?: number): Promise<{ name: string; mode: Mode }>;
  highlightRequests(): number;
  view(): {
    scrollToHunk(index: number): void;
    getAnchor(): { side: "old" | "new"; line: number; offset: number } | null;
  } | null;
}

declare global {
  interface Window {
    __diffLab?: DiffLabControl;
  }
}

const FIXTURE_DIR = resolve(import.meta.dirname, "../../fixtures/diffs");

/** The committed small fixtures, by name. */
export function smallFixtures(): Map<string, FileDiff> {
  const out = new Map<string, FileDiff>();
  for (const file of readdirSync(FIXTURE_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    out.set(file.slice(0, -5), JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")));
  }
  return out;
}

export async function openLab(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = "#diff-lab";
  });
  await page.waitForFunction(() => window.__diffLab !== undefined, undefined, { timeout: 15_000 });
}

export async function show(page: Page, name: string, mode: Mode): Promise<void> {
  await page.evaluate(
    async ([fixture, viewMode]) => {
      const lab = window.__diffLab;
      if (lab === undefined) throw new Error("The diff lab is not open");
      await lab.select(fixture);
      lab.setMode(viewMode);
    },
    [name, mode] as const,
  );
}

/** What the viewer shows right now. */
export interface Rendered {
  /** Diff views and notices on the page (exactly one when settled). */
  views: number;
  /** Library hosts on the page (one for a diff view, none for a notice). */
  hosts: number;
  path: string | null;
  mode: string | null;
  notice: string | null;
  /** Text of every rendered line (both columns in split mode). */
  lines: string[];
}

export function rendered(page: Page): Promise<Rendered> {
  return page.evaluate(() => {
    const scroll = document.querySelectorAll<HTMLElement>('[data-testid="diff-view-scroll"]');
    const notices = document.querySelectorAll<HTMLElement>('[data-testid="diff-view-notice"]');
    const view = scroll[0] ?? notices[0] ?? null;
    const hosts = document.querySelectorAll("diffs-container");
    const lines = [...(hosts[0]?.shadowRoot?.querySelectorAll("[data-line]") ?? [])].map(
      (row) => row.textContent ?? "",
    );
    return {
      views: scroll.length + notices.length,
      hosts: hosts.length,
      path: view?.dataset.diffPath ?? null,
      mode: view?.dataset.diffMode ?? null,
      notice: notices[0]?.textContent ?? null,
      lines,
    };
  });
}

/** Line text as compared: no line ending, no CR. */
export function normalize(text: string): string {
  return text.replace(/\n$/, "").replaceAll("\r", "");
}

function textLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  return text.replace(/\n$/, "").split("\n").map(normalize);
}

/** True when the fixture is shown as a notice in this mode, not as lines. */
export function expectsNotice(diff: FileDiff, mode: Mode): boolean {
  if (diff.binary || diff.hunks.length === 0) return true;
  return mode === "result" && (diff.status === "deleted" || diff.right === null);
}

/**
 * Asserts the viewer shows `diff` in `mode` and nothing else: every line git's hunks name
 * is on screen, and every line on screen belongs to this file (so nothing from an earlier
 * file survived a switch).
 */
export function expectShows(view: Rendered, diff: FileDiff, mode: Mode): void {
  expect(view.views, "exactly one diff view").toBe(1);
  expect(view.hosts, "library hosts").toBe(expectsNotice(diff, mode) ? 0 : 1);
  expect(view.path).toBe(diff.path);
  expect(view.mode).toBe(mode);
  if (expectsNotice(diff, mode)) {
    expect(view.notice).not.toBeNull();
    expect(view.lines).toEqual([]);
    return;
  }
  expect(view.notice).toBeNull();
  const shown = new Set(view.lines.map(normalize));
  const own =
    mode === "result"
      ? new Set(textLines(diff.right))
      : new Set([...textLines(diff.left), ...textLines(diff.right)]);
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "noNewline") continue;
      if (mode === "result" && line.kind === "remove") continue;
      const text = normalize(line.text);
      expect(shown.has(text), `line ${JSON.stringify(text)} is shown`).toBe(true);
      own.add(text);
    }
  }
  for (const text of shown) {
    expect(own.has(text), `line ${JSON.stringify(text)} belongs to ${diff.path}`).toBe(true);
  }
}

/**
 * Waits until the viewer has rows of `diff` in `mode` on screen. For large files, where
 * only the visible rows exist, this is as far as a content check can go.
 */
export async function expectShowing(page: Page, diff: FileDiff, mode: Mode): Promise<void> {
  await expect
    .poll(
      async () => {
        const view = await rendered(page);
        return view.path === diff.path && view.mode === mode && view.lines.length > 0;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Waits until the viewer shows `diff` in `mode`, then checks it stays that way. */
export async function expectSettledOn(page: Page, diff: FileDiff, mode: Mode): Promise<void> {
  await expect
    .poll(
      async () => {
        const view = await rendered(page);
        const ready =
          view.path === diff.path &&
          view.mode === mode &&
          (expectsNotice(diff, mode) ? view.notice !== null : view.lines.length > 0);
        return ready;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  // Late highlight results are what break viewers on fast switches; give them time to land.
  await page.waitForTimeout(800);
  expectShows(await rendered(page), diff, mode);
}
