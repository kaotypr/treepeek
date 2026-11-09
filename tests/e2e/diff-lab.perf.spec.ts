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
import { measureWheelScroll, type Stats } from "./support/perf";

const CASES: ReadonlyArray<{ fixture: "big-20k" | "patch-50k"; mode: Mode }> = [
  { fixture: "big-20k", mode: "split" },
  { fixture: "big-20k", mode: "unified" },
  { fixture: "big-20k", mode: "result" },
  { fixture: "patch-50k", mode: "split" },
  { fixture: "patch-50k", mode: "unified" },
];

const SCROLL_MS = 5_000;
const OUT = resolve(import.meta.dirname, "../../test-results/diff-viewer-perf.json");

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
      const scroll = await measureWheelScroll(app, page, "diff-view-scroll", SCROLL_MS);
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
