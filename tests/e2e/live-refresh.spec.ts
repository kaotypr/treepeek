import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../support/git-fixture";
import { type App, launchWithFolder, target } from "./support/app";
import { selectCheckout, selectedCheckout, selectFile, waitForScan } from "./support/review";

/**
 * Live refresh (live-refresh design): edits, commits and worktrees added or removed reach
 * the window without ⌘R; the open diff updates in place, says when its file is no longer
 * changed, and when its worktree is gone; marks turn amber on their own; event storms,
 * sleep, watcher failures and a core restart are handled.
 */

/** What the core service's test channel reports about live refresh. */
async function liveInfo(page: Page, suspend?: boolean) {
  const result = await page.evaluate(
    (value) => window.treepeek.core.test.liveRefresh(value === undefined ? {} : { suspend: value }),
    suspend,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** How many calls of `channel` this window made. */
async function calls(page: Page, channel: string): Promise<number> {
  return (await liveInfo(page)).calls[channel] ?? 0;
}

/** Waits until the window's checkouts are watched (each scan announces it). */
async function waitForWatching(page: Page, folders: number): Promise<void> {
  await expect
    .poll(async () => (await liveInfo(page)).subscriptions.length, { timeout: 10_000 })
    .toBe(folders);
}

const row = (page: Page, path: string): Locator =>
  page.getByTestId("file-list").locator(`[role="option"][data-path="${path}"]`);

/** The first diff line whose row is in view, by its `data-line` number. */
function firstVisibleLine(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="diff-view-scroll"]');
    const host = document.querySelector("diffs-container");
    if (!scroll || !host?.shadowRoot) return null;
    const top = scroll.getBoundingClientRect().top;
    let best: number | null = null;
    for (const line of host.shadowRoot.querySelectorAll<HTMLElement>("[data-line]")) {
      const rect = line.getBoundingClientRect();
      if (rect.bottom <= top + 1 || rect.height === 0) continue;
      const number = Number(line.dataset.line);
      if (best === null || number < best) best = number;
      if (rect.top > top + 40) break;
    }
    return best;
  });
}

/**
 * Scrolls the diff so the row for `line` sits at the top. The view is virtualized, so it
 * scrolls down a screen at a time until that row is rendered.
 */
async function scrollToLine(page: Page, line: number): Promise<void> {
  for (let step = 0; step < 50; step += 1) {
    const found = await page.evaluate((target) => {
      const scroll = document.querySelector<HTMLElement>('[data-testid="diff-view-scroll"]');
      const host = document.querySelector("diffs-container");
      if (!scroll) throw new Error("no diff on screen");
      const row = host?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${target}"]`);
      if (!row) {
        scroll.scrollTop += scroll.clientHeight;
        return false;
      }
      scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      return true;
    }, line);
    await page.waitForTimeout(100);
    if (found) {
      await page.waitForTimeout(300);
      return;
    }
  }
  throw new Error(`line ${line} never rendered`);
}

/** 600 numbered lines; `edits` replaces some of them. */
function longFile(edits: Readonly<Record<number, string>> = {}): string {
  return `${Array.from({ length: 600 }, (_, index) => edits[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;
}

/** Lines 10 to 90 and 250 to 330 changed: two tall hunks, so either can be scrolled to the top. */
const TWO_HUNKS: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    [10, 250].flatMap((first) =>
      Array.from({ length: 81 }, (_, index) => [first + index, `line ${first + index}, changed`]),
    ),
  ),
);

test.describe(`live refresh (${target})`, () => {
  let fx: Fixture;
  let repo: FixtureRepo;
  let wtA: FixtureCheckout;
  let wtB: FixtureCheckout;
  let app: App | undefined;

  test.beforeEach(() => {
    fx = fixture();
    repo = fx.repo("app").commit({ "long.txt": longFile(), "a.txt": "a\n", "b.txt": "b\n" });
    wtA = repo
      .worktree("wt-a", { from: "main" })
      .commit({ "one.txt": "1\n" })
      .write({
        "long.txt": longFile(TWO_HUNKS),
        "a.txt": "a, edited\n",
        "b.txt": "b, edited\n",
      });
    wtB = repo.worktree("wt-b", { from: "main" });
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    fx.cleanup();
  });

  test("FSEvents watches every folder of the scan, one stream each", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    const info = await liveInfo(page);
    console.log(`[${target}] live refresh backend: ${info.backend}`);
    expect(info.backend).toBe("fsevents");
    expect(info.subscriptions.every((item) => item.backend === "fsevents")).toBe(true);
    expect(info.subscriptions.map((item) => item.kind).sort()).toEqual([
      "common",
      "root",
      "workingTree",
      "workingTree",
      "workingTree",
    ]);
    expect(info.unavailable).toEqual([]);
  });

  test("an edit to a file that is not open refreshes the list and review status, not the open diff", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtA.path);
    await selectFile(page, "a.txt");
    await expect(page.getByTestId("diff-view")).toBeVisible();
    await page.waitForTimeout(500);
    // The core service sends the checkout's review status again by itself.
    await page.evaluate((checkoutPath) => {
      const counts = window as unknown as { __statuses: number };
      counts.__statuses = 0;
      window.treepeek.on("review.changed", (status) => {
        if (status.checkoutPath === checkoutPath) counts.__statuses += 1;
      });
    }, wtA.path);
    const statuses = () =>
      page.evaluate(() => (window as unknown as { __statuses: number }).__statuses);
    const before = {
      list: await calls(page, "comparison.list"),
      status: await calls(page, "review.status"),
      diff: await calls(page, "diff.file"),
    };

    wtA.write({ "b.txt": "b, edited again\n" });
    await expect
      .poll(() => calls(page, "comparison.list"), { timeout: 5_000 })
      .toBe(before.list + 1);
    await expect.poll(statuses, { timeout: 5_000 }).toBe(1);
    // Give a stray fetch of the open diff, or a second one of anything, time to happen.
    await page.waitForTimeout(1_000);
    expect(await calls(page, "diff.file")).toBe(before.diff);
    expect(await calls(page, "comparison.list")).toBe(before.list + 1);
    expect(await calls(page, "review.status")).toBe(before.status);
    expect(await statuses()).toBe(1);
    await expect(page.getByTestId("preview-updated")).toHaveCount(0);
  });

  test("editing the open file updates it in place with Updated, keeping the same hunk in view", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtA.path);
    await selectFile(page, "long.txt");
    await expect(page.getByTestId("diff-view-scroll")).toBeVisible();
    await expect.poll(() => firstVisibleLine(page)).not.toBeNull();
    await scrollToLine(page, 247);
    const before = await firstVisibleLine(page);
    expect(before).toBeGreaterThan(200);
    const diffsBefore = await calls(page, "diff.file");

    wtA.write({ "long.txt": longFile({ ...TWO_HUNKS, 252: "line 252, new" }) });
    await expect(page.getByTestId("preview-updated")).toBeVisible({ timeout: 5_000 });
    expect(await calls(page, "diff.file")).toBe(diffsBefore + 1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("diffs-container")
              ?.shadowRoot?.textContent?.includes("line 252, new") ?? false,
        ),
      )
      .toBe(true);
    await expect.poll(() => firstVisibleLine(page)).toBeGreaterThan(200);
    const after = await firstVisibleLine(page);
    expect(Math.abs((after ?? 0) - (before ?? 0))).toBeLessThanOrEqual(10);

    // An editor's atomic save (write elsewhere, rename over the file) updates it the same way.
    const temp = join(wtA.path, ".long.txt.tmp-save");
    writeFileSync(
      temp,
      longFile({ ...TWO_HUNKS, 250: "line 250, saved atomically", 252: "line 252, new" }),
    );
    renameSync(temp, join(wtA.path, "long.txt"));
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document
                .querySelector("diffs-container")
                ?.shadowRoot?.textContent?.includes("saved atomically") ?? false,
          ),
        { timeout: 5_000 },
      )
      .toBe(true);
    await expect(page.getByTestId("preview-updated")).toBeVisible();

    // Moving on clears the marker.
    await selectFile(page, "a.txt");
    await expect(page.getByTestId("preview-updated")).toHaveCount(0);
  });

  test("a reverted open file shows no longer changed, with its last changes dimmed", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtA.path);
    await selectFile(page, "a.txt");
    await expect(page.getByTestId("diff-view")).toBeVisible();

    wtA.write({ "a.txt": "a\n" });
    await expect(page.getByTestId("preview-no-longer-changed")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("preview-stale")).toBeVisible();
    await expect(page.getByTestId("preview-stale").getByTestId("diff-view")).toBeVisible();
    await expect(row(page, "a.txt")).toHaveCount(0);

    await selectFile(page, "b.txt");
    await expect(page.getByTestId("preview-no-longer-changed")).toHaveCount(0);
    await expect(page.getByTestId("preview-stale")).toHaveCount(0);
  });

  test("a removed worktree says it no longer exists, and leaves once something else is selected", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtA.path);
    await selectFile(page, "a.txt");
    await expect(page.getByTestId("diff-view")).toBeVisible();

    repo.repoGit(["worktree", "remove", "--force", wtA.path]);
    await expect(page.getByTestId("preview-checkout-gone")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("checkout-gone")).toHaveText("This worktree no longer exists.");
    await expect(page.getByTestId("preview-stale")).toBeVisible();
    // Still selected, still listed, until something else is selected.
    expect(await selectedCheckout(page)).toBe(wtA.path);
    await expect(page.getByTestId("scan-status")).toHaveText(/^3 Git checkouts/);

    await selectCheckout(page, wtB.path);
    await expect(page.getByTestId("scan-status")).toHaveText(/^2 Git checkouts/);
    await expect(
      page.getByTestId("folder-picker").locator(`option[value="${wtA.path}"]`),
    ).toHaveCount(0);
    await expect(page.getByTestId("preview-checkout-gone")).toHaveCount(0);
  });

  test("a new worktree appears and a commit moves the counts, without ⌘R", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtB.path);
    await expect(page.getByTestId("checkout-counts")).toContainText("0 commits");

    const wtC = repo.worktree("wt-c", { from: "main" });
    await expect(page.getByTestId("scan-status")).toHaveText(/^4 Git checkouts/, {
      timeout: 5_000,
    });
    await expect(
      page.getByTestId("folder-picker").locator(`option[value="${wtC.path}"]`),
    ).toHaveCount(1);
    await waitForWatching(page, 6);

    wtB.commit({ "two.txt": "2\n" });
    await expect(page.getByTestId("checkout-counts")).toContainText("1 commit", { timeout: 5_000 });
    expect(await calls(page, "scan.start")).toBe(1);
  });

  test("a file marked Viewed and edited on disk turns amber without ⌘R", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtA.path);
    await row(page, "b.txt").getByTestId("viewed-checkbox").click();
    await expect(row(page, "b.txt")).toHaveAttribute("data-review", "viewed");

    wtA.write({ "b.txt": "b, edited after viewing\n" });
    await expect(row(page, "b.txt")).toHaveAttribute("data-review", "changedSinceViewed", {
      timeout: 5_000,
    });
    await expect(row(page, "b.txt").getByTestId("changed-badge")).toBeVisible();
    expect(await calls(page, "scan.start")).toBe(1);
  });

  test("an event storm pauses the working tree with a banner, git still refreshes, and Refresh resumes", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtA.path);
    await expect(page.getByTestId("checkout-counts")).toContainText("1 commit");

    const generated = join(wtA.path, "generated");
    mkdirSync(generated);
    const startedAt = Date.now();
    for (let index = 0; index < 5_000; index += 1) {
      writeFileSync(join(generated, `file-${index}.txt`), `${index}\n`);
    }
    await expect(page.getByTestId("refresh-storm")).toBeVisible({ timeout: 3_000 });
    const shownAfter = Date.now() - startedAt;
    console.log(`[${target}] storm banner after ${shownAfter} ms`);
    expect(shownAfter).toBeLessThan(3_000);
    await expect(page.getByTestId("refresh-storm")).toContainText("Lots of changes in wt-a");

    // Git-dir signals stay live: a commit still updates the counts.
    wtA.git(["commit", "--quiet", "--no-verify", "-am", "during the storm"]);
    await expect(page.getByTestId("checkout-counts")).toContainText("2 commits", {
      timeout: 5_000,
    });
    await expect(page.getByTestId("refresh-storm")).toBeVisible();

    await page.getByTestId("refresh-resume").click();
    await expect(page.getByTestId("refresh-banner")).toHaveCount(0, { timeout: 10_000 });
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    // Working-tree refresh runs again.
    await selectFile(page, "b.txt");
    wtA.write({ "b.txt": "b, after the storm\n" });
    await expect(page.getByTestId("preview-updated")).toBeVisible({ timeout: 5_000 });
  });

  test("after the Mac wakes, changes made while events were lost show up", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtB.path);
    await expect(page.getByTestId("checkout-uncommitted")).toHaveCount(0);

    await liveInfo(page, true);
    wtB.write({ "asleep.txt": "written while asleep\n" });
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("checkout-uncommitted")).toHaveCount(0);

    const resumed = await page.evaluate(() => window.treepeek.main.test.powerResume());
    expect(resumed.ok).toBe(true);
    await expect(page.getByTestId("checkout-uncommitted")).toContainText("+1 uncommitted file", {
      timeout: 5_000,
    });
    await liveInfo(page, false);
    const current = app;
    await expect.poll(() => current.log("core")).toContain("revalidated after sleep");
  });

  test("the core service restarts and live refresh comes back with it", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await waitForWatching(page, 5);
    await selectCheckout(page, wtB.path);
    const info = await page.evaluate(() => window.treepeek.core.app.info());
    if (!info.ok) throw new Error("the core service did not answer");
    // The core service of this app instance only, found through the instance itself.
    process.kill(info.value.pid, "SIGKILL");
    await expect(page.getByTestId("connection-banner")).toHaveText("Reconnecting…", {
      timeout: 3_000,
    });
    await expect(page.getByTestId("connection-banner")).toBeHidden({ timeout: 10_000 });
    await waitForScan(page, 3);
    await waitForWatching(page, 5);

    wtB.commit({ "after-restart.txt": "x\n" });
    await expect(page.getByTestId("checkout-counts")).toContainText("1 commit", {
      timeout: 5_000,
    });
  });
});

test.describe(`live refresh when watchers fail (${target})`, () => {
  let fx: Fixture;
  let repo: FixtureRepo;
  let wt: FixtureCheckout;
  let app: App | undefined;

  test.beforeEach(() => {
    fx = fixture();
    repo = fx.repo("app").commit({ "a.txt": "a\n" });
    wt = repo.worktree("wt", { from: "main" });
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    fx.cleanup();
  });

  test("with FSEvents failing, fs.watch watches and changes still arrive", async () => {
    app = await launchWithFolder(fx.root, { env: { TREEPEEK_E2E_WATCHER_FAULT: "fsevents" } });
    const { page } = app;
    await waitForScan(page, 2);
    await waitForWatching(page, 4);
    const info = await liveInfo(page);
    expect(info.backend).toBe("fs.watch");
    expect(info.subscriptions.every((item) => item.backend === "fs.watch")).toBe(true);
    await selectCheckout(page, wt.path);
    wt.write({ "new.txt": "new\n" });
    await expect(page.getByTestId("checkout-uncommitted")).toContainText("+1 uncommitted file", {
      timeout: 5_000,
    });
    await expect(page.getByTestId("refresh-banner")).toHaveCount(0);
  });

  test("with both failing, the window says live refresh is unavailable, tried once each", async () => {
    app = await launchWithFolder(fx.root, {
      env: { TREEPEEK_E2E_WATCHER_FAULT: "fsevents,fs.watch" },
    });
    const { page } = app;
    await waitForScan(page, 2);
    await expect(page.getByTestId("refresh-unavailable")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("refresh-unavailable")).toContainText(
      "Live refresh unavailable for",
    );
    await expect(page.getByTestId("refresh-unavailable")).toContainText("⌘R");
    // Give a retry loop, if there were one, time to show in the log.
    await page.waitForTimeout(2_000);
    const log = app.log("core");
    const attempts = (backend: string) =>
      log
        .split("\n")
        .filter(
          (line) =>
            line.includes("could not watch a folder") &&
            line.includes(`"backend":"${backend}"`) &&
            line.includes(`"path":"${wt.path}"`),
        ).length;
    expect(attempts("fsevents")).toBe(1);
    expect(attempts("fs.watch")).toBe(1);
    expect(log.split("\n").filter((line) => line.includes("live refresh unavailable")).length).toBe(
      4,
    );
  });
});
