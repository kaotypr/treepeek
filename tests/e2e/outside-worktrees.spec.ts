import { expect, type Page, test } from "@playwright/test";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../support/git-fixture";
import { type App, launchWithFolder, target } from "./support/app";
import { waitForScan } from "./support/review";

/**
 * A window shows the checkouts its walk finds under its folder, and nothing else: a
 * worktree of a scanned repository that lies outside the folder, or inside another checkout
 * (an agent's `<repo>/.claude/worktrees/<name>`), is not shown, before or after live
 * refresh reads the worktree list again, and the path rule refuses its paths.
 */
test.describe(`outside worktrees (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let app: App;
  let fx: Fixture;
  let repo: FixtureRepo;
  let feature: FixtureCheckout;
  const hidden: FixtureCheckout[] = [];

  test.beforeAll(async () => {
    fx = fixture();
    repo = fx.repo("app").commit({ "README.md": "hello\n" });
    feature = repo.worktree("app-feature", { from: "main" });
    hidden.push(
      repo.outsideWorktree("agents/app-outside", { from: "main" }).write({ "out.txt": "o\n" }),
      repo.agentWorktree("task-1", { from: "main" }).write({ "agent.txt": "a\n" }),
    );
    app = await launchWithFolder(fx.root);
    await waitForScan(app.page, 2);
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  /** The checkout paths the timeline holds. */
  function timelinePaths(page: Page): Promise<string[]> {
    return page
      .getByTestId("timeline-list")
      .getByRole("option")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-checkout-path") ?? ""));
  }

  /** What each call that takes a checkout path answers for `checkoutPath`. */
  function answers(page: Page, checkoutPath: string) {
    return page.evaluate(async (path) => {
      const core = window.treepeek.core;
      const results = await Promise.all([
        core.comparison.list({ checkoutPath: path, kind: "working" }),
        core.diff.file({
          requestId: `outside-${path}`,
          checkoutPath: path,
          comparison: { kind: "working" },
          path: "README.md",
          category: "unstaged",
        }),
        core.review.status({ checkoutPaths: [path] }),
        core.review.mark({ checkoutPath: path, paths: ["README.md"], viewed: true }),
        core.start.override({ checkoutPath: path, commit: null }),
      ]);
      return results.map((result) => (result.ok ? "ok" : result.error.code));
    }, checkoutPath);
  }

  test("shows only the checkouts the walk finds", async () => {
    const { page } = app;
    await page.keyboard.press("Meta+T");
    await expect(page.getByTestId("timeline")).toBeVisible();
    await expect.poll(() => timelinePaths(page)).toEqual([repo.path, feature.path]);
    for (const checkout of hidden) {
      await expect(
        page.getByTestId("folder-picker").locator(`option[value="${checkout.path}"]`),
      ).toHaveCount(0);
    }
  });

  test("refuses a hidden worktree's paths with notInScan", async () => {
    for (const checkout of hidden) {
      expect(await answers(app.page, checkout.path), checkout.path).toEqual(
        Array(5).fill("notInScan"),
      );
    }
    // A shown checkout answers the same calls.
    expect((await answers(app.page, feature.path))[0]).toBe("ok");
  });

  test("still hides worktrees added outside after live refresh reads the list again", async () => {
    const { page } = app;
    hidden.push(
      repo.outsideWorktree("agents/app-later", { from: "main" }),
      repo.agentWorktree("task-2", { from: "main" }),
    );
    // A worktree under the folder too, so the window shows that the refresh ran.
    const later = repo.worktree("app-third", { from: "main" });
    await expect(page.getByTestId("scan-status")).toHaveText(/^3 Git checkouts/, {
      timeout: 10_000,
    });
    await expect.poll(() => timelinePaths(page)).toEqual([repo.path, feature.path, later.path]);
    for (const checkout of hidden) {
      expect(await answers(page, checkout.path), checkout.path).toEqual(Array(5).fill("notInScan"));
    }
  });
});
