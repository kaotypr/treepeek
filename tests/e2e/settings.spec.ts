import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Fixture, type FixtureCheckout, fixture } from "../support/git-fixture";
import {
  type App,
  launchApp,
  launchLog,
  launchWithFolder,
  target,
  windowKind,
} from "./support/app";
import { chooseComparison, closeComparison, selectCheckout, waitForScan } from "./support/review";

/**
 * The Settings window (⌘,): one instance, six sections, and every setting saved and applied
 * without a restart. Native dialogs answer through `TREEPEEK_E2E_DIALOG`, and "Open in…"
 * and Open Logs Folder are recorded instead of run.
 */

function savedSettings(app: App): Record<string, unknown> {
  return JSON.parse(readFileSync(join(app.userDataDir, "settings.json"), "utf8"));
}

async function openSection(settings: Page, id: string): Promise<void> {
  await settings.getByTestId(`settings-nav-${id}`).click();
  await expect(settings.getByTestId(`settings-${id}`)).toBeVisible();
}

test.describe(`settings (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let app: App;
  let fx: Fixture;
  let work: FixtureCheckout;
  let settings: Page;
  const log = launchLog();

  test.beforeAll(async () => {
    fx = fixture();
    const repo = fx.repo("app").commit({ "a.txt": "a\n" });
    work = repo
      .worktree("work", { from: "main" })
      .commit({ "committed.txt": "c\n" })
      .write({ "uncommitted.txt": "u\n" });
    // A git older than Treepeek supports, for the Git section's "too old".
    const oldGit = fx.outsidePath("old-git/git");
    mkdirSync(join(fx.outside, "old-git"));
    writeFileSync(oldGit, '#!/bin/sh\necho "git version 2.30.2"\n', { mode: 0o755 });
    app = await launchWithFolder(fx.root, {
      env: { TREEPEEK_E2E_LAUNCH_LOG: log.file, TREEPEEK_E2E_DIALOG: oldGit },
    });
    await waitForScan(app.page, 2);
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  test("⌘, opens one Settings window, and again brings that one forward", async () => {
    await app.page.keyboard.press("Meta+,");
    settings = await app.waitForPage(
      async (page) => (await windowKind(page)) === "settings",
      "the settings window",
    );
    await expect(settings.getByTestId("settings-general")).toBeVisible();
    await expect(settings.getByRole("navigation", { name: "Settings sections" })).toContainText(
      "GeneralReviewIntegrationsGitUpdatesAdvanced",
    );
    await app.page.keyboard.press("Meta+,");
    await expect.poll(() => app.log("main")).toContain("focused the settings window");
    const kinds = await Promise.all(app.pages().map((page) => windowKind(page)));
    expect(kinds.filter((kind) => kind === "settings")).toHaveLength(1);
  });

  test("General: the appearance applies to every window at once", async () => {
    await openSection(settings, "general");
    await settings.getByTestId("appearance-dark").check();
    await expect(app.page.locator("html")).toHaveClass(/\bdark\b/);
    await expect(settings.locator("html")).toHaveClass(/\bdark\b/);
    await settings.getByTestId("appearance-light").check();
    await expect(app.page.locator("html")).not.toHaveClass(/\bdark\b/);
    expect(savedSettings(app).appearance).toBe("light");
  });

  test("General: restoring windows can be turned off", async () => {
    await settings.getByTestId("restore-windows").click();
    await expect(settings.getByTestId("restore-windows")).toHaveAttribute("aria-checked", "false");
    expect(savedSettings(app).restoreWindows).toBe(false);
    await settings.getByTestId("restore-windows").click();
    await expect.poll(() => savedSettings(app).restoreWindows).toBe(true);
  });

  test("Review: the default comparison applies to the next checkout selected", async () => {
    await openSection(settings, "review");
    await settings.getByTestId("default-comparison").selectOption("working");
    await expect(settings.getByTestId("settings-review")).toContainText(
      "Staged, unstaged, and untracked files",
    );
    await expect.poll(() => savedSettings(app).defaultComparison).toBe("working");

    const { page } = app;
    await selectCheckout(page, work.path);
    await page.keyboard.press("Meta+K");
    await expect(
      page.getByTestId("comparison-popover").getByRole("radio", { name: /Current uncommitted/ }),
    ).toBeChecked();
    // Back to the usual default for the tests that follow.
    await chooseComparison(page, "All worktree changes");
    await closeComparison(page);
    await settings.getByTestId("default-comparison").selectOption("review");
  });

  test("Integrations: a custom editor command saves and ⌘E uses it at once", async () => {
    await openSection(settings, "integrations");
    const choice = settings.getByTestId("editor-choice");
    await expect(choice.locator("option")).toContainText(["Custom command…"]);
    await choice.selectOption("custom");

    await settings.getByTestId("editor-command").fill("my'editor {path}");
    await settings.getByTestId("editor-command-save").click();
    await expect(settings.getByTestId("editor-problem")).toContainText("unclosed");

    await settings.getByTestId("editor-command").fill("myeditor --line {line} {path}");
    await settings.getByTestId("editor-command-save").click();
    await expect(settings.getByTestId("editor-saved")).toHaveText("Saved.");
    expect(savedSettings(app).editor).toEqual({
      kind: "custom",
      command: "myeditor --line {line} {path}",
    });

    const before = log.read().length;
    await app.page.keyboard.press("Meta+E");
    await expect.poll(() => log.read().length).toBe(before + 1);
    expect(log.read().at(-1)).toEqual({
      action: "run",
      command: "myeditor",
      args: ["--line", "1", work.path],
    });
  });

  test("Git: shows the git in use, and a picked git that is too old is named and not used", async () => {
    await openSection(settings, "git");
    await expect(settings.getByTestId("git-current")).toContainText(/Git \d+\.\d+/);
    await expect(settings.getByTestId("git-override")).toHaveText("Found automatically");
    await settings.getByTestId("git-choose").click();
    await expect(settings.getByTestId("git-picked")).toContainText("Git 2.30.2 at ");
    await expect(settings.getByTestId("git-picked")).toContainText("is older than 2.36.0");
    await expect(settings.getByTestId("git-override")).toHaveText("Found automatically");
    expect(savedSettings(app).gitPath).toBeNull();
    // The scan carries on with the git it had.
    await expect(app.page.getByTestId("git-setup")).toHaveCount(0);

    await settings.getByTestId("git-detect-again").click();
    await expect(settings.getByTestId("git-detect-again")).toBeEnabled();
    await expect(settings.getByTestId("git-current")).toContainText(/Git \d+\.\d+/);
  });

  test("Updates is a placeholder, and Advanced opens the logs folder", async () => {
    await openSection(settings, "updates");
    await expect(settings.getByTestId("updates-placeholder")).toBeVisible();
    await openSection(settings, "advanced");
    const before = log.read().length;
    await settings.getByTestId("open-logs").click();
    await expect.poll(() => log.read().length).toBe(before + 1);
    expect(log.read().at(-1)).toEqual({
      action: "openFolder",
      path: join(app.userDataDir, "logs"),
    });
  });
});

test.describe(`restoring windows (${target})`, () => {
  let fx: Fixture;
  test.beforeAll(() => {
    fx = fixture();
    fx.repo("app").commit({ "a.txt": "a\n" });
  });
  test.afterAll(() => fx?.cleanup());

  for (const restoreWindows of [true, false]) {
    test(`with restoring ${restoreWindows ? "on" : "off"}, the last windows ${restoreWindows ? "come back" : "do not"}`, async () => {
      const app = await launchApp({
        settings: {
          version: 1,
          restoreWindows,
          windows: [{ scanRoot: fx.root, bounds: null, ui: null }],
        },
      });
      try {
        await expect.poll(() => windowKind(app.page)).toBe(restoreWindows ? "scan" : "welcome");
      } finally {
        await app.close();
      }
    });
  }
});
