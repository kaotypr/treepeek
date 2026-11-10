import { expect, type Page, test } from "@playwright/test";
import type { TimelineEntry } from "../../src/shared/domain/scan";
import { type Fixture, fixture } from "../support/git-fixture";
import { type App, launchApp, launchWithFolder, newUserDataDir, target } from "./support/app";
import { selectedCheckout, waitForScan } from "./support/review";

/** The timeline rows on screen: number, folder and relation, in display order. */
function timelineRows(page: Page) {
  return page
    .getByTestId("timeline-list")
    .getByRole("option")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        sequence: Number(row.getAttribute("data-sequence")),
        path: row.getAttribute("data-checkout-path"),
        folder: row.querySelector('[data-testid="timeline-folder"]')?.textContent ?? "",
        relation: row.querySelector('[data-testid="timeline-relation"]')?.textContent ?? "",
      })),
    );
}

test.describe(`timeline (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let app: App;
  let fx: Fixture;
  const userDataDir = newUserDataDir();

  test.beforeAll(async () => {
    fx = fixture();
    const repo = fx.repo("app").commit({ "README.md": "hello\n" });
    repo.worktree("app-feature", { from: "main" }).commit({ "feature.txt": "f\n" });
    repo.worktree("group/app-later", { from: "app-feature" }).commit({ "later.txt": "l\n" });
    fx.repo("svc").commit({ "x.txt": "x\n" });
    repo.worktree("app-side", { from: "main" }).commit({ "side.txt": "s\n" });
    app = await launchWithFolder(fx.root, { userDataDir });
    await waitForScan(app.page, 5);
    await app.page.keyboard.press("Meta+T");
    await expect(app.page.getByTestId("timeline")).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  test("numbers and relations are the core service's timeline", async () => {
    const { page } = app;
    // Capture the timeline the core sends on a rescan, then compare the rows with it.
    await page.evaluate(() => {
      const holder = window as unknown as { __timeline?: TimelineEntry[] };
      const stop = window.treepeek.on("scan.done", (payload) => {
        holder.__timeline = payload.timeline;
        stop();
      });
    });
    await page.keyboard.press("Meta+R");
    const timeline = await page
      .waitForFunction(() => (window as unknown as { __timeline?: TimelineEntry[] }).__timeline)
      .then((handle) => handle.jsonValue() as Promise<TimelineEntry[]>);
    await waitForScan(page, 5);

    const rows = await timelineRows(page);
    expect(rows.map((row) => [row.sequence, row.path])).toEqual(
      timeline.map((entry) => [entry.sequence, entry.checkoutPath]),
    );
    const relative = (path: string) => path.slice(fx.root.length + 1);
    for (const entry of timeline) {
      const row = rows.find((item) => item.sequence === entry.sequence);
      const expected =
        entry.relation === "first" || entry.predecessor === null
          ? "First in repository"
          : `${entry.relation === "after" ? "After" : "Parallel to"} ${relative(entry.predecessor)}`;
      expect(row?.relation, `relation of ${entry.checkoutPath}`).toBe(expected);
      expect(row?.folder).toBe(relative(entry.checkoutPath));
    }
    expect(rows.map((row) => row.relation)).toEqual([
      "First in repository",
      "After app",
      "After app-feature",
      "First in repository",
      "Parallel to group/app-later",
    ]);
  });

  test("selecting an event selects its checkout and reveals it in the navigator", async () => {
    const { page } = app;
    await page.keyboard.press("Meta+Shift+T");
    const tree = page.getByTestId("folder-tree");
    await expect(tree).toBeVisible();
    await expect(tree.locator(`[data-checkout-path="${fx.path("group/app-later")}"]`)).toHaveCount(
      0,
    );

    await page
      .getByTestId("timeline-list")
      .locator(`[data-checkout-path="${fx.path("group/app-later")}"]`)
      .click();
    await expect.poll(() => selectedCheckout(page)).toBe(fx.path("group/app-later"));
    const leaf = tree.locator(`[data-checkout-path="${fx.path("group/app-later")}"]`);
    await expect(leaf).toBeVisible();
    await expect(leaf).toHaveAttribute("aria-selected", "true");

    // ↓ in the timeline moves to the next event and selects it too.
    await page.getByTestId("timeline-list").focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => selectedCheckout(page)).toBe(fx.path("svc"));
    await page.keyboard.press("Meta+Shift+T");
  });

  test("grouping and order rearrange the events, keeping their numbers", async () => {
    const { page } = app;
    await page.getByTestId("timeline-grouping").selectOption("repository");
    await expect(page.getByTestId("timeline-group")).toHaveCount(2);
    expect(await page.getByTestId("timeline-group").allTextContents()).toEqual([
      "app4 checkouts",
      "svc1 checkout",
    ]);
    expect((await timelineRows(page)).map((row) => row.sequence)).toEqual([1, 2, 3, 5, 4]);

    await page.getByTestId("timeline-order").selectOption("newest");
    expect((await timelineRows(page)).map((row) => row.sequence)).toEqual([5, 3, 2, 1, 4]);

    await page.getByTestId("timeline-grouping").selectOption("folder");
    expect(await page.getByTestId("timeline-group").allTextContents()).toEqual([
      "Scanned folder4 checkouts",
      "group1 checkout",
    ]);
    expect((await timelineRows(page)).map((row) => row.sequence)).toEqual([5, 4, 2, 1, 3]);

    await page.getByTestId("timeline-grouping").selectOption("all");
    await page.getByTestId("timeline-order").selectOption("oldest");
    expect((await timelineRows(page)).map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  test("the window remembers its grouping and order across a relaunch", async () => {
    const { page } = app;
    await page.getByTestId("timeline-grouping").selectOption("repository");
    await page.getByTestId("timeline-order").selectOption("newest");
    // The layout is saved once changes settle (the page, then main, wait briefly).
    await page.waitForTimeout(1_500);
    await app.close();

    app = await launchApp({ userDataDir });
    await waitForScan(app.page, 5);
    await expect(app.page.getByTestId("timeline")).toBeVisible();
    await expect(app.page.getByTestId("timeline-grouping")).toHaveValue("repository");
    await expect(app.page.getByTestId("timeline-order")).toHaveValue("newest");
    expect(await selectedCheckout(app.page)).toBe(fx.path("svc"));
  });
});
