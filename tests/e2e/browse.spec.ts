import { expect, test } from "@playwright/test";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../support/git-fixture";
import { type App, launchWithFolder, target } from "./support/app";
import {
  listedFiles,
  selectCheckout,
  selectedCheckout,
  selectFile,
  waitForScan,
} from "./support/review";

/**
 * Browsing a folder's checkouts: the picker and the tree, the checkout details, Previous
 * and Next, the start override, rescanning, and the scan surviving a core restart.
 */
test.describe(`browse (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let app: App;
  let fx: Fixture;
  let repo: FixtureRepo;
  let feature: FixtureCheckout;
  let later: FixtureCheckout;
  let mainAtFeatureStart: string;
  let featureHead: string;

  test.beforeAll(async () => {
    fx = fixture();
    repo = fx.repo("app").commit({ "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" });
    mainAtFeatureStart = repo.head();
    feature = repo
      .worktree("app-feature", { from: "main" })
      .commit({ "feature.txt": "f\n" })
      .commit({ "src/a.ts": "export const a = 2;\n" })
      .write({ "notes.txt": "uncommitted\n" });
    featureHead = feature.head();
    later = repo
      .worktree("group/app-later", { from: "app-feature" })
      .commit({ "later.txt": "l\n" });
    fx.repo("svc").commit({ "x.txt": "x\n" });
    app = await launchWithFolder(fx.root);
    await waitForScan(app.page, 4);
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  test("the picker and the tree list the same checkouts, and folders count theirs", async () => {
    const { page } = app;
    const picker = await page
      .getByTestId("folder-picker")
      .locator("option:not([disabled])")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
      );
    expect(picker.sort()).toEqual(
      [fx.path("app"), fx.path("app-feature"), fx.path("group/app-later"), fx.path("svc")].sort(),
    );

    await page.keyboard.press("Meta+Shift+T");
    const tree = page.getByTestId("folder-tree");
    await expect(tree).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: /^group, 1 checkout$/ })).toBeVisible();
    await expect(
      tree.getByRole("treeitem", { name: /scanned folder|treepeek-fixture/ }).first(),
    ).toContainText("4 checkouts");
    // Expanding the folder shows its checkout; every checkout is then a tree leaf.
    await tree.getByRole("treeitem", { name: /^group, / }).click();
    const leaves = await tree
      .locator("[role=treeitem][data-checkout-path]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-checkout-path")));
    expect(leaves.sort()).toEqual(picker.sort());
    await page.keyboard.press("Meta+Shift+T");
    await expect(tree).toBeHidden();
  });

  test("checkout details show the repository, branch, start and counts", async () => {
    const { page } = app;
    await selectCheckout(page, feature.path);
    const details = page.getByTestId("checkout-details");
    await expect(details.getByTestId("checkout-repository")).toHaveText("app");
    await expect(details.getByTestId("checkout-branch")).toContainText("app-feature");
    await expect(details.getByTestId("checkout-start-commit")).toHaveText(
      mainAtFeatureStart.slice(0, 8),
    );
    await expect(details.getByTestId("checkout-start")).toContainText("First seen");
    await expect(details.getByTestId("checkout-counts")).toContainText(
      "2 commits · 2 files changed",
    );
    await expect(details.getByTestId("checkout-uncommitted")).toContainText("+1 uncommitted file");
    expect(await listedFiles(page)).toEqual(["feature.txt", "notes.txt", "src/a.ts"]);

    await selectCheckout(page, fx.path("svc"));
    await expect(details.getByTestId("checkout-repository")).toHaveText("svc");
    await expect(details.getByTestId("checkout-counts")).toContainText(
      "0 commits · 0 files changed",
    );
    await expect(details.getByTestId("checkout-uncommitted")).toHaveCount(0);
  });

  test("Previous and Next move through the same repository in timeline order", async () => {
    const { page } = app;
    await selectCheckout(page, feature.path);
    await page.getByTestId("next-event").click();
    expect(await selectedCheckout(page)).toBe(later.path);
    await expect(page.getByTestId("next-event")).toBeDisabled();
    await page.keyboard.press("Meta+BracketLeft");
    await expect.poll(() => selectedCheckout(page)).toBe(feature.path);
    await page.keyboard.press("Meta+BracketLeft");
    await expect.poll(() => selectedCheckout(page)).toBe(fx.path("app"));
    await expect(page.getByTestId("previous-event")).toBeDisabled();
    await page.keyboard.press("Meta+BracketRight");
    await expect.poll(() => selectedCheckout(page)).toBe(feature.path);

    await selectCheckout(page, fx.path("svc"));
    await expect(page.getByTestId("previous-event")).toBeDisabled();
    await expect(page.getByTestId("next-event")).toBeDisabled();
  });

  test("a start override moves First seen to the commit, and clearing it restores the reflog start", async () => {
    const { page } = app;
    await selectCheckout(page, later.path);
    const details = page.getByTestId("checkout-details");
    const reflogStart = featureHead.slice(0, 8);
    await expect(details.getByTestId("checkout-start-commit")).toHaveText(reflogStart);
    await expect(details.getByTestId("checkout-counts")).toContainText("1 commit ·");

    await details.getByRole("button", { name: "Change…" }).click();
    const dialog = page.getByTestId("start-override-dialog");
    await dialog.getByTestId("start-override-input").fill("no-such-ref");
    await dialog.getByRole("button", { name: "Set start" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();

    await dialog.getByTestId("start-override-input").fill(mainAtFeatureStart);
    await dialog.getByRole("button", { name: "Set start" }).click();
    await expect(dialog).toBeHidden();
    await expect(details.getByTestId("checkout-start-commit")).toHaveText(
      mainAtFeatureStart.slice(0, 8),
    );
    await expect(details.getByTestId("checkout-start-override")).toHaveText(" (set by you)");
    await expect(details.getByTestId("checkout-counts")).toContainText("3 commits ·");
    expect(await listedFiles(page)).toEqual(["feature.txt", "later.txt", "src/a.ts"]);

    await details.getByRole("button", { name: "Change…" }).click();
    await dialog.getByRole("button", { name: "Use the first-seen start" }).click();
    await expect(dialog).toBeHidden();
    await expect(details.getByTestId("checkout-start-commit")).toHaveText(reflogStart);
    await expect(details.getByTestId("checkout-start-override")).toHaveCount(0);
    expect(await listedFiles(page)).toEqual(["later.txt"]);
  });

  test("⌘R rescans, keeps the selection, and finds new checkouts", async () => {
    const { page } = app;
    await selectCheckout(page, feature.path);
    await selectFile(page, "src/a.ts");
    repo.worktree("app-new", { from: "main" });
    await page.keyboard.press("Meta+R");
    await waitForScan(page, 5);
    expect(await selectedCheckout(page)).toBe(feature.path);
    await expect(page.getByTestId("preview-title")).toHaveText("src/a.ts");
    const options = await page.getByTestId("folder-picker").locator("option").allTextContents();
    expect(options.some((text) => text.includes("app-new"))).toBe(true);
  });

  test("Reconnecting… shows while the core service restarts, and the scan comes back", async () => {
    const { page } = app;
    await selectCheckout(page, feature.path);
    const info = await page.evaluate(() => window.treepeek.core.app.info());
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    process.kill(info.value.pid, "SIGKILL");
    await expect(page.getByTestId("connection-banner")).toHaveText("Reconnecting…", {
      timeout: 3_000,
    });
    await expect(page.getByTestId("connection-banner")).toBeHidden({ timeout: 10_000 });
    await waitForScan(page, 5);
    expect(await selectedCheckout(page)).toBe(feature.path);
    await selectFile(page, "feature.txt");
    await expect(page.getByTestId("diff-view")).toBeVisible();
  });
});

test.describe(`browse a large folder (${target})`, () => {
  test("the first checkout is listed before the scan is done", async () => {
    const fx = fixture({ stepSeconds: 5 });
    const repo = fx.repo("big").commit({ "README.md": "big\n" });
    for (let index = 0; index < 30; index += 1) {
      repo.worktree(`wt-${String(index).padStart(2, "0")}`, { from: "main" }).write({
        [`file-${index}.txt`]: `${index}\n`,
      });
    }
    const app = await launchWithFolder(fx.root);
    try {
      await waitForScan(app.page, 31);
      // Watch a fresh scan from its first frame: reload the window with an observer in place.
      // Watch a fresh scan from its first frame: reload the window with a listener in place.
      // It subscribes before the app does, so it sees `scan.done` before the app handles it,
      // and counts the checkouts the picker already lists at that moment.
      await app.page.addInitScript(() => {
        const marks = { rowsAtDone: -1, checkoutEvents: 0 };
        (window as unknown as { __marks: typeof marks }).__marks = marks;
        const subscribe = () => {
          if (!("treepeek" in window)) return setTimeout(subscribe, 0);
          window.treepeek.on("scan.checkout", () => {
            marks.checkoutEvents += 1;
          });
          window.treepeek.on("scan.done", () => {
            if (marks.rowsAtDone >= 0) return;
            marks.rowsAtDone = document.querySelectorAll(
              '[data-testid="folder-picker"] option[value^="/"]',
            ).length;
          });
        };
        subscribe();
      });
      await app.page.reload();
      await waitForScan(app.page, 31);
      const marks = await app.page.evaluate(
        () =>
          (window as unknown as { __marks: { rowsAtDone: number; checkoutEvents: number } })
            .__marks,
      );
      expect(marks.checkoutEvents).toBe(31);
      expect(marks.rowsAtDone).toBeGreaterThan(0);
    } finally {
      await app.close();
      fx.cleanup();
    }
  });
});
