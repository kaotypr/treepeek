/**
 * Background review status (review marks plan, task 3): after a scan of 30 checkouts, every
 * timeline row shows its progress ring within 5 s of `scan.done`, and selecting a checkout
 * while that work runs still shows its file list promptly. Timing on shared runners is
 * noise, so this runs only when asked: `TREEPEEK_PERF=1 bun run test:e2e
 * tests/e2e/review-status.perf.spec.ts`, on a local machine, after `bun run build`. The
 * result is written to `test-results/review-status-perf.json`.
 *
 * The fixture is the scan benchmark's (`scripts/bench-scan.ts`): three repositories, each a
 * main checkout and nine linked worktrees with two commits of their own and staged,
 * unstaged and untracked changes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Fixture, type FixtureRepo, fixture } from "../support/git-fixture";
import { type App, launchWithFolder, target } from "./support/app";
import { selectCheckout, waitForScan } from "./support/review";

const OUT = resolve(import.meta.dirname, "../../test-results/review-status-perf.json");
const CHECKOUTS = 30;
const LIMIT_MS = 5_000;

function baseFiles(commit: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i += 1) {
    const version = i % 10 === commit % 10 ? commit : 0;
    files[`src/m${i % 20}/file-${i}.ts`] = `export const value${i} = ${version};\n`.repeat(20);
  }
  return files;
}

function buildFixture(): Fixture {
  const fx = fixture();
  for (const name of ["alpha", "beta", "gamma"]) {
    const repo: FixtureRepo = fx.repo(name);
    for (let commit = 1; commit <= 10; commit += 1) repo.commit(baseFiles(commit));
    for (let n = 1; n <= 9; n += 1) {
      const worktree = repo.worktree(`worktrees/${name}-${n}`, {
        from: repo.rev(n % 3 === 0 ? "HEAD~3" : "main"),
        branch: `${name}-${n}`,
      });
      worktree.commit({ [`src/m${n}/file-${n}.ts`]: `export const changed = ${n};\n` });
      worktree.commit({ [`feature-${n}/new.ts`]: `export const added = ${n};\n` });
      worktree.write({ [`src/m${n + 1}/file-${n + 1}.ts`]: "staged\n" });
      worktree.stage([`src/m${n + 1}/file-${n + 1}.ts`]);
      worktree.write({
        [`src/m${n + 2}/file-${n + 2}.ts`]: "unstaged\n",
        [`notes-${n}.md`]: "untracked\n",
        [`scratch/${n}/a.txt`]: "a\n",
        [`scratch/${n}/b.txt`]: "b\n",
      });
    }
  }
  return fx;
}

/** `durationMs` of every "review status computed" line the core service logged. */
function backgroundTimes(app: App): number[] {
  return [...app.log("core").matchAll(/review status computed \{[^}]*"durationMs":(\d+)/g)].map(
    (match) => Number(match[1]),
  );
}

/** Rings showing a known status in the timeline. */
function ringsShown(page: Page): Promise<number> {
  return page
    .getByTestId("timeline-list")
    .locator('[data-testid="progress-ring"]:not([data-state="unknown"])')
    .count();
}

/** Starts recording, in the page, when `scan.done` and each `review.changed` arrive. */
function recordEvents(page: Page): Promise<void> {
  return page.evaluate(() => {
    const state = window as unknown as { __done: number | null; __statuses: number[] };
    state.__done = null;
    state.__statuses = [];
    window.treepeek.on("scan.done", () => {
      state.__done = performance.now();
    });
    window.treepeek.on("review.changed", () => {
      if (state.__done !== null) state.__statuses.push(performance.now());
    });
  });
}

function recorded(page: Page): Promise<{ done: number | null; statuses: number[] }> {
  return page.evaluate(() => {
    const state = window as unknown as { __done: number | null; __statuses: number[] };
    return { done: state.__done, statuses: [...state.__statuses] };
  });
}

/** Selects a checkout and answers how long until its file list shows its count. */
async function timeSelection(page: Page, path: string): Promise<number> {
  const started = Date.now();
  await selectCheckout(page, path);
  await expect(page.getByTestId("file-count")).toHaveText(/^\d+ files?$/, { timeout: 30_000 });
  return Date.now() - started;
}

test.describe(`review status performance (${target})`, () => {
  test.skip(process.env.TREEPEEK_PERF !== "1", "set TREEPEEK_PERF=1 to measure");
  test.describe.configure({ timeout: 180_000 });

  test(`every row of ${CHECKOUTS} shows its ring within ${LIMIT_MS / 1000} s of scan.done`, async () => {
    const fx = buildFixture();
    const app = await launchWithFolder(fx.root, { settings: { version: 1, appearance: "light" } });
    try {
      const { page } = app;
      await waitForScan(page, CHECKOUTS);
      await page.keyboard.press("Meta+T");
      // Cold: the first scan, with no comparison or hash caches.
      await expect.poll(() => ringsShown(page), { timeout: 30_000 }).toBe(CHECKOUTS);
      await expect.poll(() => backgroundTimes(app).length, { timeout: 30_000 }).toBe(1);
      const cold = backgroundTimes(app)[0] ?? Number.NaN;

      // Warm: ⌘R, measured in the page from scan.done to the last status.
      const paths = await page
        .getByTestId("timeline-list")
        .locator("[data-checkout-path]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-checkout-path") ?? ""));
      const idleSelection = await timeSelection(page, paths[0] ?? "");
      await recordEvents(page);
      await page.keyboard.press("Meta+R");
      await expect
        .poll(async () => (await recorded(page)).done, { timeout: 30_000 })
        .not.toBeNull();
      // The last checkout in timeline order is the last the background reaches.
      const busySelection = await timeSelection(page, paths[paths.length - 1] ?? "");
      await expect
        .poll(async () => (await recorded(page)).statuses.length, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(CHECKOUTS);
      const events = await recorded(page);
      const warmPage = Math.round((events.statuses.at(-1) ?? Number.NaN) - (events.done ?? 0));
      await expect.poll(() => backgroundTimes(app).length, { timeout: 30_000 }).toBe(2);
      const warm = backgroundTimes(app)[1] ?? Number.NaN;

      const git = await page.evaluate(
        () =>
          new Promise<unknown>((resolveGit) => {
            const off = window.treepeek.on("git.state", (state) => {
              off();
              resolveGit(state);
            });
          }),
      );
      const result = {
        target,
        git,
        machine: {
          cpu: cpus()[0]?.model ?? "unknown",
          cores: cpus().length,
          memoryGb: Math.round(totalmem() / 1024 ** 3),
          darwin: release(),
        },
        checkouts: CHECKOUTS,
        backgroundStatusMs: { cold, warm, warmInPage: warmPage },
        fileListShownMs: { idle: idleSelection, duringBackgroundStatus: busySelection },
      };
      mkdirSync(resolve(OUT, ".."), { recursive: true });
      writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result));
      expect(cold).toBeLessThan(LIMIT_MS);
      expect(warm).toBeLessThan(LIMIT_MS);
      expect(warmPage).toBeLessThan(LIMIT_MS);
    } finally {
      await app.close();
      fx.cleanup();
    }
  });
});
