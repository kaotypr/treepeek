import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Fixture, fixture } from "../support/git-fixture";
import { launchApp, launchLog, launchWithFolder, target, windowKind } from "./support/app";
import { selectCheckout, selectFile, waitForScan } from "./support/review";

/**
 * The menu bar and the shortcuts: every shortcut runs its command exactly once (the page
 * announces each run as a `treepeek:command` event, which these tests count), and the
 * native menu items run the same commands, enabled only for a scan window. Menu items are
 * clicked through the test-only `TREEPEEK_E2E_MENU` hook, since a background-mode window is
 * never focused and the native menu cannot be driven over DevTools.
 */

async function countRuns(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runs: string[] = [];
    (window as unknown as { __runs: string[] }).__runs = runs;
    window.addEventListener("treepeek:command", (event) =>
      runs.push((event as CustomEvent<{ id: string }>).detail.id),
    );
  });
}

const runs = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __runs: string[] }).__runs]);

/** Presses `keys` and answers the commands that ran, after giving a second run time to show. */
async function press(page: Page, keys: string): Promise<string[]> {
  const before = (await runs(page)).length;
  await page.keyboard.press(keys);
  await page.waitForTimeout(150);
  return (await runs(page)).slice(before);
}

test.describe(`menus and shortcuts (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let fx: Fixture;
  let middle: string;

  test.beforeAll(() => {
    fx = fixture();
    const repo = fx.repo("app").commit({ "a.txt": "a\n", "b.txt": "b\n" });
    const first = repo.worktree("w1", { from: "main" }).commit({ "one.txt": "1\n" });
    const second = repo
      .worktree("w2", { from: "w1" })
      .commit({ "two.txt": "2\n", "three.txt": "3\n" });
    repo.worktree("w3", { from: "w2" }).commit({ "four.txt": "4\n" });
    void first;
    middle = second.path;
  });

  test.afterAll(() => fx?.cleanup());

  test("every shortcut runs its command once, and no menu runs it again", async () => {
    const log = launchLog();
    const app = await launchWithFolder(fx.root, { env: { TREEPEEK_E2E_LAUNCH_LOG: log.file } });
    try {
      const { page } = app;
      await waitForScan(page, 4);
      await selectCheckout(page, middle);
      await selectFile(page, "three.txt");
      await countRuns(page);

      const shortcuts: [string, string][] = [
        ["Meta+R", "scan.refresh"],
        ["Meta+T", "view.timeline"],
        ["Meta+T", "view.timeline"],
        ["Meta+Shift+T", "view.tree"],
        ["Meta+Shift+T", "view.tree"],
        ["Meta+2", "preview.unified"],
        ["Meta+3", "preview.result"],
        ["Meta+1", "preview.split"],
        ["Meta+Shift+F", "preview.focus"],
        ["Meta+Shift+F", "preview.focus"],
        ["Meta+]", "checkout.next"],
        ["Meta+[", "checkout.previous"],
        ["Meta+E", "checkout.openInEditor"],
        ["Meta+Shift+E", "checkout.openInTerminal"],
        ["Meta+Shift+R", "checkout.revealInFinder"],
        ["Meta+K", "comparison.settings"],
      ];
      for (const [keys, id] of shortcuts) {
        expect(await press(page, keys), keys).toEqual([id]);
        if (id === "comparison.settings") await page.keyboard.press("Escape");
      }
      await selectFile(page, "three.txt");
      expect(await press(page, "Alt+ArrowDown"), "⌥↓").toEqual(["file.next"]);
      expect(await press(page, "Alt+ArrowUp"), "⌥↑").toEqual(["file.previous"]);
      // Review marks: V, ⌘↩, and ⌘Z once there is a "Mark all" to undo.
      await selectFile(page, "three.txt");
      expect(await press(page, "v"), "V").toEqual(["file.toggleViewed"]);
      await expect(page.getByTestId("viewed-toggle")).toHaveAttribute("aria-pressed", "true");
      expect(await press(page, "Meta+Enter"), "⌘↩").toEqual(["file.markViewedAndNext"]);
      await page.getByTestId("mark-all-reviewed").click();
      await expect(page.getByTestId("review-progress")).toHaveAttribute("data-state", "reviewed");
      expect(await press(page, "Meta+z"), "⌘Z").toEqual(["review.undo"]);
      await expect(page.getByTestId("review-progress")).toHaveAttribute("data-state", "partial");
      expect(await press(page, "Meta+F"), "⌘F").toEqual(["files.filter"]);
      await expect(page.getByTestId("file-filter")).toBeFocused();
      // In the filter field ⌥↓ is the field's own, but ⌘ shortcuts still run.
      expect(await press(page, "Alt+ArrowDown")).toEqual([]);
      expect(await press(page, "Meta+1")).toEqual(["preview.split"]);

      // Each "Open in…" shortcut started exactly one program.
      expect(log.read().map((entry) => entry.action)).toEqual(["run", "run", "reveal"]);

      expect(await press(page, "Meta+,"), "⌘,").toEqual(["app.settings"]);
      const settings = await app.waitForPage(
        async (candidate) => (await windowKind(candidate)) === "settings",
        "the settings window",
      );
      expect(settings).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test("menu items run the window's commands, once each", async () => {
    const app = await launchWithFolder(fx.root, {
      env: { TREEPEEK_E2E_MENU: "view.timeline,view.tree,preview.unified,scan.refresh" },
    });
    try {
      const { page } = app;
      await waitForScan(page);
      await expect(page.getByRole("button", { name: "Timeline", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByTestId("tree-toggle")).toHaveAttribute("aria-pressed", "true");
      for (const id of ["view.timeline", "view.tree", "preview.unified", "scan.refresh"]) {
        expect(app.log("main")).toContain(`test menu click {"id":"${id}"}`);
      }
      // The layout the menu set is what the window saves.
      await expect
        .poll(() => {
          const saved = JSON.parse(readFileSync(join(app.userDataDir, "settings.json"), "utf8"));
          return saved.windows?.[0]?.ui ?? null;
        })
        .toMatchObject({ timelineOpen: true, navigatorMode: "tree", previewMode: "unified" });
    } finally {
      await app.close();
    }
  });

  test("checkout items are disabled until a checkout is selected", async () => {
    const app = await launchWithFolder(fx.root, {
      env: { TREEPEEK_E2E_MENU: "checkout.copyPath,checkout.openInEditor,view.timeline" },
    });
    try {
      await waitForScan(app.page);
      await expect.poll(() => app.log("main")).toContain('test menu click {"id":"view.timeline"}');
      const log = app.log("main");
      expect(log).toContain(
        'test menu click skipped {"id":"checkout.copyPath","reason":"disabled"}',
      );
      expect(log).toContain(
        'test menu click skipped {"id":"checkout.openInEditor","reason":"disabled"}',
      );
    } finally {
      await app.close();
    }
  });

  test("with no scan window, window items are disabled, and Settings… opens one window", async () => {
    const app = await launchApp({
      env: { TREEPEEK_E2E_MENU: "checkout.copyPath,view.timeline,settings,settings" },
    });
    try {
      await app.waitForPage(
        async (candidate) => (await windowKind(candidate)) === "settings",
        "the settings window",
      );
      await expect.poll(() => app.log("main")).toContain("focused the settings window");
      const log = app.log("main");
      expect(log).toContain(
        'test menu click skipped {"id":"checkout.copyPath","reason":"disabled"}',
      );
      expect(log).toContain('test menu click skipped {"id":"view.timeline","reason":"disabled"}');
      expect(log.match(/opened the settings window/g)).toHaveLength(1);
      const kinds = await Promise.all(app.pages().map((page) => windowKind(page)));
      expect(kinds.filter((kind) => kind === "settings")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
