/**
 * Viewer performance on the large fixtures (diff viewer trial, criterion 2). Timing on
 * shared CI runners is noise, so this runs only when asked: `TREEPEEK_PERF=1 bun run
 * test:e2e tests/e2e/diff-lab.perf.spec.ts`, on a local machine, after `bun run build:lab`.
 * Results go to `test-results/diff-viewer-perf.json`.
 *
 * Per case: time from selecting the fixture to its first rows on screen, and to the first
 * highlighted token; then a 5-second wheel scroll, measured two ways:
 * - frame intervals from `requestAnimationFrame` (what the screen shows; on a 60 Hz
 *   display one refresh is 16.7 ms, so a median of 16.7 means no dropped frames);
 * - main-thread work per frame from a Chromium trace (time in `RunTask` between
 *   consecutive `BeginMainThreadFrame` events).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { writeLargeFixtures } from "../../scripts/make-diff-fixtures";
import { type App, LAB_OUT_DIR, launchApp, target } from "./support/app";
import { type Mode, openLab } from "./support/diff-lab";

const CASES: ReadonlyArray<{ fixture: "big-20k" | "patch-50k"; mode: Mode }> = [
  { fixture: "big-20k", mode: "split" },
  { fixture: "big-20k", mode: "unified" },
  { fixture: "big-20k", mode: "result" },
  { fixture: "patch-50k", mode: "split" },
  { fixture: "patch-50k", mode: "unified" },
];

const SCROLL_MS = 5_000;
const OUT = resolve(import.meta.dirname, "../../test-results/diff-viewer-perf.json");

interface Stats {
  median: number;
  p95: number;
  max: number;
  count: number;
}

interface Result {
  fixture: string;
  mode: Mode;
  firstPaintMs: number;
  highlightedMs: number | null;
  scrolledPx: number;
  frameIntervalMs: Stats;
  mainThreadPerFrameMs: Stats;
}

test.describe("diff viewer performance", () => {
  test.skip(process.env.TREEPEEK_PERF !== "1", "set TREEPEEK_PERF=1 to measure");
  test.skip(target === "packaged", "the lab is never packaged");
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let app: App;
  const results: Result[] = [];

  test.beforeAll(async () => {
    writeLargeFixtures(join(LAB_OUT_DIR, "renderer/lab-fixtures"));
    app = await launchApp({ build: "lab", settings: { appearance: "light" } });
    await openLab(app.page);
    await app.page.waitForFunction(() => window.__diffLab?.fixtures().includes("patch-50k"));
  });

  test.afterAll(async () => {
    await app?.close();
    mkdirSync(resolve(OUT, ".."), { recursive: true });
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          machine: {
            cpu: cpus()[0]?.model ?? "unknown",
            cores: cpus().length,
            memoryGB: Math.round(totalmem() / 1024 ** 3),
            darwin: release(),
          },
          results,
        },
        null,
        2,
      )}\n`,
    );
  });

  for (const { fixture, mode } of CASES) {
    test(`${fixture} in ${mode} mode`, async () => {
      const page = app.page;
      const paint = await measurePaint(page, fixture, mode);
      const scroll = await measureScroll(app, page);
      const result: Result = { fixture, mode, ...paint, ...scroll };
      results.push(result);
      console.log(JSON.stringify(result));
      // Both measurements must have seen the scroll; empty stats would pass every check.
      expect(result.frameIntervalMs.count).toBeGreaterThan(200);
      expect(result.mainThreadPerFrameMs.count).toBeGreaterThan(200);

      if (fixture === "big-20k") {
        // Criterion 2, highlighting on.
        expect(result.highlightedMs).not.toBeNull();
        expect(result.firstPaintMs).toBeLessThanOrEqual(300);
        expect(result.mainThreadPerFrameMs.median).toBeLessThanOrEqual(16);
        expect(result.mainThreadPerFrameMs.max).toBeLessThanOrEqual(50);
        expect(result.frameIntervalMs.max).toBeLessThanOrEqual(50);
      } else {
        // Criterion 2, highlighting off.
        expect(result.highlightedMs).toBeNull();
        expect(result.firstPaintMs).toBeLessThanOrEqual(1_000);
      }
    });
  }
});

async function measurePaint(
  page: Page,
  fixture: string,
  mode: Mode,
): Promise<{ firstPaintMs: number; highlightedMs: number | null }> {
  // Start from a different file, so the measured one mounts from scratch.
  await page.evaluate(async () => {
    await window.__diffLab?.select("small-edit");
  });
  await page.waitForTimeout(300);
  return page.evaluate(
    async ([name, viewMode]) => {
      const lab = window.__diffLab;
      if (lab === undefined) throw new Error("The diff lab is not open");
      lab.setMode(viewMode);
      await new Promise((done) => setTimeout(done, 300));
      const shadow = () => document.querySelector("diffs-container")?.shadowRoot ?? null;
      const started = performance.now();
      await lab.select(name);
      let first: number | null = null;
      let highlighted: number | null = null;
      while (performance.now() - started < 10_000) {
        await new Promise((done) => requestAnimationFrame(done));
        const scroll = document.querySelector<HTMLElement>('[data-testid="diff-view-scroll"]');
        const rows = shadow()?.querySelectorAll("[data-line]").length ?? 0;
        if (first === null && rows > 0 && scroll?.dataset.diffPath !== "src/checksum.ts") {
          first = performance.now() - started;
        }
        const token = shadow()?.querySelector<HTMLElement>("[data-line] span");
        if (first !== null && token?.style.getPropertyValue("--diffs-token-light")) {
          highlighted = performance.now() - started;
          break;
        }
        // Plain-text files never highlight; stop once they have painted.
        if (first !== null && performance.now() - started > first + 2_000) break;
      }
      if (first === null) throw new Error(`${name} never painted`);
      return { firstPaintMs: first, highlightedMs: highlighted };
    },
    [fixture, mode] as const,
  );
}

async function measureScroll(
  app: App,
  page: Page,
): Promise<{ scrolledPx: number; frameIntervalMs: Stats; mainThreadPerFrameMs: Stats }> {
  await page.waitForTimeout(500);
  const box = await page.getByTestId("diff-view-scroll").boundingBox();
  if (box === null) throw new Error("No diff view on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const state = window as unknown as { __frames: number[]; __stopFrames: boolean };
    state.__frames = [];
    state.__stopFrames = false;
    let last = performance.now();
    const tick = (now: number) => {
      state.__frames.push(now - last);
      last = now;
      if (!state.__stopFrames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await app.browser.startTracing(page, {
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
    ],
  });
  const end = Date.now() + SCROLL_MS;
  while (Date.now() < end) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(16);
  }
  const trace = JSON.parse((await app.browser.stopTracing()).toString("utf8")) as unknown;
  const { frames, scrolledPx } = await page.evaluate(() => {
    const state = window as unknown as { __frames: number[]; __stopFrames: boolean };
    state.__stopFrames = true;
    const scroll = document.querySelector<HTMLElement>('[data-testid="diff-view-scroll"]');
    // The first two intervals span the setup, not scrolling.
    return { frames: state.__frames.slice(2), scrolledPx: scroll?.scrollTop ?? 0 };
  });
  return {
    scrolledPx,
    frameIntervalMs: stats(frames),
    mainThreadPerFrameMs: stats(mainThreadPerFrame(trace)),
  };
}

interface TraceEvent {
  name: string;
  ph?: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string };
}

/** Main-thread busy time in each frame of the renderer that drew frames. */
function mainThreadPerFrame(trace: unknown): number[] {
  const events: TraceEvent[] = Array.isArray(trace)
    ? trace
    : ((trace as { traceEvents?: TraceEvent[] }).traceEvents ?? []);
  const framePids = new Set(
    events.filter((e) => e.name === "BeginMainThreadFrame").map((e) => e.pid),
  );
  const main = events.find(
    (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain" && framePids.has(e.pid),
  );
  if (main === undefined) return [];
  const begins = events
    .filter((e) => e.pid === main.pid && e.name === "BeginMainThreadFrame")
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const tasks = events.filter(
    (e) => e.pid === main.pid && e.tid === main.tid && e.name === "RunTask" && e.ph === "X",
  );
  const busy: number[] = [];
  for (let i = 0; i + 1 < begins.length; i += 1) {
    const from = begins[i] ?? 0;
    const to = begins[i + 1] ?? 0;
    let sum = 0;
    for (const task of tasks) {
      const start = Math.max(from, task.ts);
      const stop = Math.min(to, task.ts + (task.dur ?? 0));
      if (stop > start) sum += stop - start;
    }
    busy.push(sum / 1_000);
  }
  return busy;
}

function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
    count: sorted.length,
  };
}
