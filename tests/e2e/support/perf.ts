import type { Page } from "@playwright/test";
import type { App } from "./app";

/** Performance measurements shared by the `*.perf.spec.ts` files. */

export interface Stats {
  median: number;
  p95: number;
  max: number;
  count: number;
}

/**
 * Scrolls the element with test id `testId` with the mouse wheel for `durationMs`, and
 * measures it two ways:
 * - frame intervals from `requestAnimationFrame` (what the screen shows; on a 60 Hz
 *   display one refresh is 16.7 ms, so a median of 16.7 means no dropped frames);
 * - main-thread work per frame from a Chromium trace (time in `RunTask` between
 *   consecutive `BeginMainThreadFrame` events).
 */
export async function measureWheelScroll(
  app: App,
  page: Page,
  testId: string,
  durationMs: number,
): Promise<{ scrolledPx: number; frameIntervalMs: Stats; mainThreadPerFrameMs: Stats }> {
  await page.waitForTimeout(500);
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`No ${testId} on screen`);
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
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(16);
  }
  const trace = JSON.parse((await app.browser.stopTracing()).toString("utf8")) as unknown;
  const { frames, scrolledPx } = await page.evaluate((id) => {
    const state = window as unknown as { __frames: number[]; __stopFrames: boolean };
    state.__stopFrames = true;
    const scroll = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    // The first two intervals span the setup, not scrolling.
    return { frames: state.__frames.slice(2), scrolledPx: scroll?.scrollTop ?? 0 };
  }, testId);
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
export function mainThreadPerFrame(trace: unknown): number[] {
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

export function stats(values: readonly number[]): Stats {
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
