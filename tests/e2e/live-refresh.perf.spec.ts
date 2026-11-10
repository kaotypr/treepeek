/**
 * Live refresh measurements (live refresh plan, task 9): after a commit in a watched
 * worktree, the timeline and the counts update within 1.5 s for a scan of 30 worktrees;
 * and how many watcher streams, and how much memory, live refresh costs with 30 and with
 * 100 worktrees. Timing on shared runners is noise, so this runs only when asked:
 * `TREEPEEK_PERF=1 bun run test:e2e tests/e2e/live-refresh.perf.spec.ts`, on a local
 * machine, after `bun run build`. Results go to `test-results/live-refresh-perf.json`.
 *
 * The 30-worktree fixture is the scan benchmark's (`scripts/bench-scan.ts`); the stream
 * and memory fixtures are lighter (fewer files) so that 100 worktrees build quickly.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../support/git-fixture";
import { type App, launchWithFolder, target } from "./support/app";
import { selectCheckout, waitForScan } from "./support/review";

const OUT = resolve(import.meta.dirname, "../../test-results/live-refresh-perf.json");
const BUDGET_MS = 1_500;
const COMMITS = 5;

function baseFiles(commit: number, count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    const version = i % 10 === commit % 10 ? commit : 0;
    files[`src/m${i % 20}/file-${i}.ts`] = `export const value${i} = ${version};\n`.repeat(20);
  }
  return files;
}

/**
 * `repositories` repositories, each a main checkout and nine linked worktrees with two
 * commits of their own and staged, unstaged and untracked changes.
 */
function buildFixture(
  repositories: number,
  files: number,
  commits: number,
): { fx: Fixture; worktrees: FixtureCheckout[] } {
  const fx = fixture();
  const worktrees: FixtureCheckout[] = [];
  for (let r = 0; r < repositories; r += 1) {
    const name = `repo-${String(r).padStart(2, "0")}`;
    const repo: FixtureRepo = fx.repo(name);
    for (let commit = 1; commit <= commits; commit += 1) repo.commit(baseFiles(commit, files));
    for (let n = 1; n <= 9; n += 1) {
      const worktree = repo.worktree(`worktrees/${name}-${n}`, {
        from: repo.rev(n % 3 === 0 ? `HEAD~${Math.min(3, commits - 1)}` : "main"),
        branch: `${name}-${n}`,
      });
      worktree.commit({ [`src/m${n}/file-${n}.ts`]: `export const changed = ${n};\n` });
      worktree.commit({ [`feature-${n}/new.ts`]: `export const added = ${n};\n` });
      worktree.write({ [`src/m${n + 1}/file-${n + 1}.ts`]: "staged\n" });
      worktree.stage([`src/m${n + 1}/file-${n + 1}.ts`]);
      worktree.write({
        [`src/m${n + 2}/file-${n + 2}.ts`]: "unstaged\n",
        [`notes-${n}.md`]: "untracked\n",
      });
      worktrees.push(worktree);
    }
  }
  return { fx, worktrees };
}

async function liveInfo(page: Page) {
  const result = await page.evaluate(() => window.treepeek.core.test.liveRefresh({}));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/**
 * Records, in the page, the wall-clock time at which both the checkout details and the
 * checkout's timeline row first show `commits` commits.
 */
function watchForCommits(page: Page, path: string, commits: number): Promise<void> {
  return page.evaluate(
    ({ path, text }) => {
      const state = window as unknown as { __shownAt: number | null };
      state.__shownAt = null;
      const check = () => {
        const details = document.querySelector('[data-testid="checkout-counts"]')?.textContent;
        const row = document.querySelector(
          `[data-checkout-path="${CSS.escape(path)}"]`,
        )?.textContent;
        if (details?.includes(text) && row?.includes(text)) {
          state.__shownAt = Date.now();
          return;
        }
        requestAnimationFrame(check);
      };
      // Background windows may get no frames; a timer keeps checking.
      const timer = setInterval(() => {
        if (state.__shownAt !== null) clearInterval(timer);
        else check();
      }, 5);
      requestAnimationFrame(check);
    },
    { path, text: `${commits} commits` },
  );
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { median: at(0.5), max: sorted.at(-1) ?? 0, values };
}

/** Megabytes, one decimal. */
function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

/** Open file descriptors of a process (`lsof`), or `null` when it cannot be counted. */
function openFiles(pid: number): number | null {
  try {
    return (
      execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8" })
        .trim()
        .split("\n").length - 1
    );
  } catch {
    return null;
  }
}

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  target,
  machine: { cpu: cpus()[0]?.model ?? "unknown", memoryGb: totalmem() / 1024 ** 3, os: release() },
};

function save(): void {
  mkdirSync(resolve(OUT, ".."), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
}

test.describe(`live refresh performance (${target})`, () => {
  test.skip(process.env.TREEPEEK_PERF !== "1", "set TREEPEEK_PERF=1 to measure");
  test.describe.configure({ timeout: 300_000 });

  test(`a commit shows in the timeline and the counts within ${BUDGET_MS} ms with 30 worktrees`, async () => {
    const { fx, worktrees } = buildFixture(3, 200, 10);
    let app: App | undefined;
    try {
      app = await launchWithFolder(fx.root, { settings: { version: 1, appearance: "light" } });
      const { page } = app;
      await waitForScan(page, 30);
      // The root, three common dirs and thirty working trees.
      await expect.poll(async () => (await liveInfo(page)).subscriptions.length).toBe(34);
      await page.keyboard.press("Meta+T");
      const worktree = worktrees[4];
      if (!worktree) throw new Error("no worktree");
      await selectCheckout(page, worktree.path);
      const before = await page.getByTestId("checkout-counts").textContent();
      let commits = Number(/(\d+) commits?/.exec(before ?? "")?.[1] ?? Number.NaN);
      const times: number[] = [];
      for (let round = 0; round < COMMITS; round += 1) {
        commits += 1;
        await watchForCommits(page, worktree.path, commits);
        worktree.commit({ [`perf/round-${round}.txt`]: `${round}\n` });
        const committedAt = Date.now();
        await expect
          .poll(
            () =>
              page.evaluate(() => (window as unknown as { __shownAt: number | null }).__shownAt),
            { timeout: 10_000 },
          )
          .not.toBeNull();
        const shownAt = await page.evaluate(
          () => (window as unknown as { __shownAt: number }).__shownAt,
        );
        times.push(shownAt - committedAt);
        // Let the refresh settle before the next commit.
        await page.waitForTimeout(1_000);
      }
      const measured = stats(times);
      results.commitToScreen = { checkouts: 30, budgetMs: BUDGET_MS, ...measured };
      console.log(
        `[${target}] commit to timeline and counts, 30 worktrees: median ${measured.median} ms, max ${measured.max} ms (${times.join(", ")})`,
      );
      save();
      expect(measured.max).toBeLessThan(BUDGET_MS);
    } finally {
      await app?.close();
      fx.cleanup();
    }
  });

  for (const repositories of [3, 10]) {
    const checkouts = repositories * 10;
    test(`streams and memory with ${checkouts} worktrees`, async () => {
      const { fx } = buildFixture(repositories, 40, 4);
      const expected = 1 + repositories + checkouts;
      /** The core service after a scan of the fixture, settled. */
      const measure = async (env: Record<string, string>) => {
        const app = await launchWithFolder(fx.root, {
          settings: { version: 1, appearance: "light" },
          env,
        });
        try {
          const { page } = app;
          await waitForScan(page, checkouts);
          await expect
            .poll(async () => (await liveInfo(page)).subscriptions.length, { timeout: 30_000 })
            .toBe(expected);
          // Let the background review status and the first events settle.
          await page.waitForTimeout(3_000);
          const info = await liveInfo(page);
          const pid = await page.evaluate(async () => {
            const result = await window.treepeek.core.app.info();
            return result.ok ? result.value.pid : null;
          });
          return { info, openFiles: pid === null ? null : openFiles(pid) };
        } finally {
          await app.close();
        }
      };
      try {
        const watched = await measure({});
        // The same scan with no watcher at all: every backend refuses (test-only fault).
        const unwatched = await measure({ TREEPEEK_E2E_WATCHER_FAULT: "fsevents,fs.watch" });
        const streams = watched.info.subscriptions.filter(
          (item) => item.backend === "fsevents",
        ).length;
        const measured = {
          checkouts,
          repositories,
          streams,
          byKind: Object.fromEntries(
            ["root", "common", "gitDir", "workingTree"].map((kind) => [
              kind,
              watched.info.subscriptions.filter((item) => item.kind === kind).length,
            ]),
          ),
          coreRssMb: mb(watched.info.rssBytes),
          coreRssUnwatchedMb: mb(unwatched.info.rssBytes),
          coreOpenFiles: watched.openFiles,
          coreOpenFilesUnwatched: unwatched.openFiles,
        };
        results[`watch${checkouts}`] = measured;
        console.log(`[${target}] ${checkouts} worktrees: ${JSON.stringify(measured)}`);
        save();
        expect(watched.info.backend).toBe("fsevents");
        expect(streams).toBe(expected);
        expect(watched.info.unavailable).toEqual([]);
        expect(unwatched.info.unavailable).toHaveLength(expected);
      } finally {
        fx.cleanup();
      }
    });
  }
});
