import { expect, type Locator, type Page, test } from "@playwright/test";
import { DEFAULT_WINDOW_UI_STATE } from "../../src/shared/settings";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../support/git-fixture";
import {
  type App,
  launchApp,
  launchWithFolder,
  newUserDataDir,
  target,
  windowKind,
} from "./support/app";
import {
  listedFiles,
  renderedLines,
  selectCheckout,
  selectedFile,
  selectFile,
  waitForScan,
} from "./support/review";

/**
 * Review marks: Viewed checkboxes and V, the progress they add up to, "Mark all as
 * reviewed", "Unmark all" and ⌘Z, "Since you viewed" after an edit and ⌘R, "Mark viewed and
 * open next", the Hide viewed and Hide reviewed filters, marks across a restart and across
 * two windows, the menu items, and clearing review data in Settings.
 */

const progress = (page: Page) => page.getByTestId("review-progress-text");
const row = (page: Page, path: string): Locator =>
  page.getByTestId("file-list").locator(`[role="option"][data-path="${path}"]`);

async function check(page: Page, path: string): Promise<void> {
  await row(page, path).getByTestId("viewed-checkbox").click();
}

/** The review status the core service reports for checkouts, for the rings to match. */
function statuses(page: Page, paths: string[]) {
  return page.evaluate(async (checkoutPaths) => {
    const result = await window.treepeek.core.review.status({ checkoutPaths });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.map((status) => ({
      path: status.checkoutPath,
      total: status.total,
      viewed: status.viewed,
    }));
  }, paths);
}

test.describe(`review marks (${target})`, () => {
  let fx: Fixture;
  let repo: FixtureRepo;
  let w1: FixtureCheckout;
  let w2: FixtureCheckout;
  let app: App | undefined;

  test.beforeEach(() => {
    fx = fixture();
    repo = fx.repo("app").commit({ "a.txt": "a\n", "b.txt": "b\n" });
    // In w1's review scope: a commit, an edit and a new file.
    w1 = repo
      .worktree("w1", { from: "main" })
      .commit({ "one.txt": "1\n" })
      .write({ "a.txt": "a, edited\n", "new.txt": "new\n" });
    w2 = repo.worktree("w2", { from: "w1" }).write({ "two.txt": "2\n" });
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    fx?.cleanup();
  });

  test("marking files raises the progress, in the list, the details and the rings", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await selectCheckout(page, w1.path);
    await expect(progress(page)).toHaveText("0 / 3 files · 0%");

    await check(page, "a.txt");
    await expect(row(page, "a.txt")).toHaveAttribute("data-review", "viewed");
    await expect(progress(page)).toHaveText("1 / 3 files · 33%");

    await selectFile(page, "new.txt");
    await page.keyboard.press("v");
    await expect(page.getByTestId("viewed-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(progress(page)).toHaveText("2 / 3 files · 66%");
    await page.getByTestId("viewed-toggle").click();
    await expect(progress(page)).toHaveText("1 / 3 files · 33%");

    // Every timeline row's ring says what the core service counts for it.
    await page.keyboard.press("Meta+T");
    const paths = [repo.path, w1.path, w2.path];
    const counted = await statuses(page, paths);
    for (const status of counted) {
      const ring = page
        .getByTestId("timeline")
        .locator(`[data-checkout-path="${status.path}"]`)
        .getByTestId("progress-ring");
      const percent = status.total === 0 ? 0 : Math.floor((status.viewed * 100) / status.total);
      await expect(ring, status.path).toHaveAttribute("data-percent", String(percent));
    }
    expect(counted.find((status) => status.path === w1.path)).toEqual({
      path: w1.path,
      total: 3,
      viewed: 1,
    });
    // The main checkout has no changes: no progress to show.
    await expect(
      page
        .getByTestId("timeline")
        .locator(`[data-checkout-path="${repo.path}"]`)
        .getByTestId("progress-ring"),
    ).toHaveAttribute("data-state", "empty");
  });

  test("Mark all and Unmark all are one action each, and ⌘Z restores the exact marks", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await selectCheckout(page, w1.path);
    await check(page, "a.txt");
    await expect(progress(page)).toHaveText("1 / 3 files · 33%");

    await page.getByTestId("mark-all-reviewed").click();
    await expect(page.getByTestId("review-progress")).toHaveAttribute("data-state", "reviewed");
    await expect(progress(page)).toContainText("3 / 3 files · 100%");
    await page.keyboard.press("Meta+z");
    await expect(progress(page)).toHaveText("1 / 3 files · 33%");
    for (const [path, state] of [
      ["a.txt", "viewed"],
      ["new.txt", "unviewed"],
      ["one.txt", "unviewed"],
    ] as const) {
      await expect(row(page, path), path).toHaveAttribute("data-review", state);
    }

    await page.getByTestId("unmark-all").click();
    await expect(progress(page)).toHaveText("0 / 3 files · 0%");
    await page.keyboard.press("Meta+z");
    await expect(progress(page)).toHaveText("1 / 3 files · 33%");
    await expect(row(page, "a.txt")).toHaveAttribute("data-review", "viewed");
  });

  test("an edit after viewing shows the amber badge after ⌘R, and Since you viewed shows only it", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await selectCheckout(page, w1.path);
    await selectFile(page, "a.txt");
    await page.keyboard.press("v");
    await expect(row(page, "a.txt")).toHaveAttribute("data-review", "viewed");

    w1.write({ "a.txt": "a, edited\nan edit after viewing\n" });
    await page.keyboard.press("Meta+R");
    await expect(row(page, "a.txt")).toHaveAttribute("data-review", "changedSinceViewed", {
      timeout: 15_000,
    });
    await expect(row(page, "a.txt").getByTestId("changed-badge")).toBeVisible();
    await expect(page.getByTestId("review-changed-count")).toContainText("1 file changed");

    await selectFile(page, "a.txt");
    await page.getByTestId("since-viewed").click();
    await expect(page.getByTestId("since-viewed-note")).toBeVisible();
    await expect(page.getByTestId("preview-stats")).toContainText("+1 −0");
    await expect
      .poll(() => renderedLines(page))
      .toContainEqual(expect.stringContaining("an edit after viewing"));
    // Marking it again clears the flag.
    await page.keyboard.press("v");
    await expect(row(page, "a.txt")).toHaveAttribute("data-review", "viewed");
    await expect(page.getByTestId("since-viewed")).toHaveCount(0);
  });

  test("Mark viewed and open next walks the list, and stays on the last file", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await selectCheckout(page, w1.path);
    expect(await listedFiles(page)).toEqual(["a.txt", "new.txt", "one.txt"]);
    await selectFile(page, "a.txt");
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => selectedFile(page)).toBe("new.txt");
    await expect(row(page, "a.txt")).toHaveAttribute("data-review", "viewed");

    // The button below the diff does the same.
    await page.getByTestId("diff-view-next-file").click();
    await expect.poll(() => selectedFile(page)).toBe("one.txt");
    await page.keyboard.press("Meta+Enter");
    await expect(row(page, "one.txt")).toHaveAttribute("data-review", "viewed");
    expect(await selectedFile(page)).toBe("one.txt");
    await expect(page.getByTestId("review-progress")).toHaveAttribute("data-state", "reviewed");
  });

  test("Hide viewed hides viewed files, and Hide reviewed exactly the worktrees at 100%", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await selectCheckout(page, w1.path);
    await check(page, "a.txt");
    await selectFile(page, "one.txt");
    await page.getByTestId("hide-viewed").click();
    await expect.poll(() => listedFiles(page)).toEqual(["new.txt", "one.txt"]);
    await expect(page.getByTestId("file-count")).toHaveText("2 of 3");
    await page.getByTestId("hide-viewed").click();
    await expect.poll(() => listedFiles(page)).toEqual(["a.txt", "new.txt", "one.txt"]);

    await selectCheckout(page, w2.path);
    await page.getByTestId("mark-all-reviewed").click();
    await expect(page.getByTestId("review-progress")).toHaveAttribute("data-state", "reviewed");
    await page.keyboard.press("Meta+T");
    await expect(page.getByTestId("timeline-reviewed")).toHaveText("1 of 3 worktrees reviewed");
    await page.getByTestId("hide-reviewed").check();
    const shown = page.getByTestId("timeline-list").locator("[data-checkout-path]");
    await expect(shown).toHaveCount(2);
    expect(
      await shown.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-checkout-path"))),
    ).toEqual(expect.arrayContaining([repo.path, w1.path]));
  });

  test("marks survive a restart", async () => {
    const userDataDir = newUserDataDir();
    app = await launchWithFolder(fx.root, { userDataDir });
    await waitForScan(app.page, 3);
    await selectCheckout(app.page, w1.path);
    await check(app.page, "new.txt");
    await expect(progress(app.page)).toHaveText("1 / 3 files · 33%");
    await app.close();

    app = await launchWithFolder(fx.root, { userDataDir });
    const page = app.page;
    await waitForScan(page, 3);
    await selectCheckout(page, w1.path);
    await expect(progress(page)).toHaveText("1 / 3 files · 33%");
    await expect(row(page, "new.txt")).toHaveAttribute("data-review", "viewed");
  });

  test("two windows on overlapping folders see the same marks", async () => {
    app = await launchWithFolder([fx.root, w1.path]);
    const opened = app;
    const byRoot = (root: string) =>
      opened.waitForPage(
        async (page) =>
          (await page.getByTestId("scan-window").getAttribute("data-scan-root")) === root,
        `the window on ${root}`,
      );
    const wide = await byRoot(fx.root);
    const narrow = await byRoot(w1.path);
    await waitForScan(wide, 3);
    await waitForScan(narrow, 1);
    await selectCheckout(narrow, w1.path);
    await selectCheckout(wide, w1.path);
    await expect(progress(narrow)).toHaveText("0 / 3 files · 0%");

    await check(wide, "one.txt");
    await expect(progress(wide)).toHaveText("1 / 3 files · 33%");
    // The other window hears of it without doing anything.
    await expect(progress(narrow)).toHaveText("1 / 3 files · 33%");
    await expect(row(narrow, "one.txt")).toHaveAttribute("data-review", "viewed");
  });

  test("menu items mark all and unmark all, each running once", async () => {
    app = await launchApp({
      settings: {
        version: 1,
        restoreWindows: true,
        windows: [
          {
            scanRoot: fx.root,
            bounds: null,
            ui: { ...DEFAULT_WINDOW_UI_STATE, selectedCheckout: w1.path },
          },
        ],
      },
      env: { TREEPEEK_E2E_MENU: "wait:checkout.markAllReviewed,wait:checkout.unmarkAll" },
    });
    const opened = app;
    await expect
      .poll(() => opened.log("main"), { timeout: 30_000 })
      .toContain('test menu click {"id":"checkout.unmarkAll"}');
    const page = await opened.waitForPage(
      async (candidate) => (await windowKind(candidate)) === "scan",
      "the scan window",
    );
    await expect(progress(page)).toHaveText("0 / 3 files · 0%");
    const core = opened.log("core");
    expect(core.match(/marked all as reviewed/g)).toHaveLength(1);
    expect(core.match(/unmarked all/g)).toHaveLength(1);
    expect(
      opened.log("main").match(/test menu click \{"id":"checkout.markAllReviewed"\}/g),
    ).toHaveLength(1);
  });

  test("Settings shows the snapshot store, clears review data, and hides viewed by default", async () => {
    app = await launchWithFolder(fx.root);
    const { page } = app;
    await waitForScan(page, 3);
    await selectCheckout(page, w1.path);
    await check(page, "a.txt");
    await expect(progress(page)).toHaveText("1 / 3 files · 33%");

    await page.keyboard.press("Meta+,");
    const opened = app;
    const settings = await opened.waitForPage(
      async (candidate) => (await windowKind(candidate)) === "settings",
      "the settings window",
    );
    await settings.getByTestId("settings-nav-advanced").click();
    await expect(settings.getByTestId("snapshot-usage")).toHaveText(/^Snapshots: 1 \(/);
    await settings.getByTestId("clear-review-data").click();
    await expect(settings.getByTestId("clear-review-confirm")).toBeVisible();
    await settings.getByTestId("clear-review-cancel").click();
    await expect(settings.getByTestId("snapshot-usage")).toHaveText(/^Snapshots: 1 \(/);
    await settings.getByTestId("clear-review-data").click();
    await settings.getByTestId("clear-review-ok").click();
    await expect(settings.getByTestId("clear-review-message")).toHaveText("Review data cleared.");
    await expect(settings.getByTestId("snapshot-usage")).toHaveText("Snapshots: 0 (0 bytes)");
    // The open window's progress starts over.
    await expect(progress(page)).toHaveText("0 / 3 files · 0%");

    await settings.getByTestId("settings-nav-review").click();
    await settings.getByTestId("hide-viewed-default").click();
    await expect(page.getByTestId("hide-viewed")).toHaveAttribute("aria-pressed", "true");
  });
});
