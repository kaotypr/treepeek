import { expect, type Page, test } from "@playwright/test";
import { SMALL_FIXTURES } from "../../scripts/make-diff-fixtures";
import { type Files, type Fixture, type FixtureCheckout, fixture } from "../support/git-fixture";
import { contrastViolations } from "./support/a11y";
import { type App, launchWithFolder, target } from "./support/app";
import { expectSettledOn, MODES, type Mode, smallFixtures } from "./support/diff-lab";
import {
  chooseComparison,
  closeComparison,
  listedFiles,
  previewState,
  runningGitCalls,
  selectCheckout,
  selectedFile,
  selectFile,
  waitForScan,
} from "./support/review";

const MODE_KEY: Readonly<Record<Mode, string>> = {
  split: "Meta+Digit1",
  unified: "Meta+Digit2",
  result: "Meta+Digit3",
};

/** The first diff line whose row is in view, by its `data-line` number. */
function firstVisibleLine(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="diff-view-scroll"]');
    const host = document.querySelector("diffs-container");
    if (!scroll || !host?.shadowRoot) return null;
    const top = scroll.getBoundingClientRect().top;
    let best: number | null = null;
    for (const row of host.shadowRoot.querySelectorAll<HTMLElement>("[data-line]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top + 1 || rect.height === 0) continue;
      const line = Number(row.dataset.line);
      if (best === null || line < best) best = line;
      if (rect.top > top + 40) break;
    }
    return best;
  });
}

/** Scrolls the diff so the row for `line` sits at the top of the view. */
async function scrollToLine(page: Page, line: number): Promise<void> {
  await page.evaluate((target) => {
    const scroll = document.querySelector<HTMLElement>('[data-testid="diff-view-scroll"]');
    const host = document.querySelector("diffs-container");
    const row = host?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${target}"]`);
    if (!scroll || !row) throw new Error(`line ${target} is not rendered`);
    scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  }, line);
  await page.waitForTimeout(300);
}

test.describe(`compare and preview (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let app: App;
  let fx: Fixture;
  const fixtureCheckouts = new Map<string, FixtureCheckout>();
  let first: FixtureCheckout;
  let second: FixtureCheckout;
  let parallel: FixtureCheckout;
  let many: FixtureCheckout;
  const manyFiles = Array.from(
    { length: 60 },
    (_, i) => `files/f-${String(i).padStart(2, "0")}.txt`,
  );

  test.beforeAll(async () => {
    fx = fixture();

    // One repository per diff viewer fixture: the worktree's only change is that fixture's.
    for (const spec of SMALL_FIXTURES) {
      const repo = fx.repo(`fx-${spec.name}`).commit(spec.before as Files);
      const after: Record<string, Files[string]> = {};
      for (const path of Object.keys(spec.before)) after[path] = null;
      for (const [path, content] of Object.entries(spec.after)) {
        after[path] = spec.executableAfter?.includes(path)
          ? { content, executable: true }
          : content;
      }
      fixtureCheckouts.set(spec.name, repo.worktree(spec.name, { from: "main" }).commit(after));
    }

    // The comparison kinds: first → second follow each other; parallel does not.
    const kinds = fx.repo("kinds").commit({ "base.txt": "base\n" });
    first = kinds.worktree("k-first", { from: "main" }).commit({ "first.txt": "1\n" });
    second = kinds.worktree("k-second", { from: "k-first" }).commit({ "second.txt": "2\n" });
    second.write({ "staged.txt": "s\n" }).stage(["staged.txt"]).write({ "wip.txt": "w\n" });
    second.git(["branch", "--set-upstream-to=main"]);
    parallel = kinds.worktree("k-parallel", { from: "main" }).commit({ "p.txt": "p\n" });

    // Many files, a long one with distant hunks, and a deleted one.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
    const before: Record<string, string> = {
      "long.txt": `${lines.join("\n")}\n`,
      "gone.txt": "bye\n",
    };
    for (const [i, path] of manyFiles.entries()) before[path] = `file ${i}\nsecond line\n`;
    const busy = fx.repo("busy").commit(before);
    const changedFiles: Record<string, string | null> = { "gone.txt": null };
    changedFiles["long.txt"] =
      `${lines.map((line, i) => (i % 20 === 19 ? `${line} changed` : line)).join("\n")}\n`;
    for (const [i, path] of manyFiles.entries()) changedFiles[path] = `file ${i}\nchanged line\n`;
    many = busy.worktree("busy-wt", { from: "main" }).commit(changedFiles);

    app = await launchWithFolder(fx.root);
    await waitForScan(app.page);
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  for (const [name, diff] of smallFixtures()) {
    test(`${name} renders in each preview mode`, async () => {
      const { page } = app;
      const checkout = fixtureCheckouts.get(name);
      if (!checkout) throw new Error(`no checkout for ${name}`);
      await selectCheckout(page, checkout.path);
      expect(await listedFiles(page)).toEqual([diff.path]);
      await selectFile(page, diff.path);
      for (const mode of MODES) {
        if (mode === "result" && diff.status === "deleted") {
          await expect(page.getByRole("button", { name: "Resulting file" })).toBeDisabled();
          await page.keyboard.press(MODE_KEY.result);
          expect((await previewState(page)).mode).toBe("unified");
          continue;
        }
        await page.keyboard.press(MODE_KEY[mode]);
        await expectSettledOn(page, diff, mode);
      }
      await page.keyboard.press(MODE_KEY.split);
    });
  }

  test("every comparison kind lists its files, with All worktree changes by default", async () => {
    const { page } = app;
    await selectCheckout(page, second.path);
    await expect(page.getByTestId("comparison-summary")).toContainText("All worktree changes");
    expect(await listedFiles(page)).toEqual(["second.txt", "staged.txt", "wip.txt"]);

    const expectations: Array<[string, string[]]> = [
      ["Made in this worktree", ["second.txt"]],
      ["Current uncommitted changes", ["staged.txt", "wip.txt"]],
      ["Already arrived since previous worktree", []],
      ["All changes since previous worktree", ["second.txt"]],
      ["Compare with upstream", ["first.txt", "second.txt"]],
    ];
    for (const [label, files] of expectations) {
      await chooseComparison(page, label);
      await closeComparison(page);
      await expect.poll(() => listedFiles(page), { message: label }).toEqual(files);
      if (files.length === 0) {
        await expect(page.getByTestId("file-list")).toContainText("No changes in this comparison");
      }
    }

    // The working comparison names each file's category.
    await chooseComparison(page, "Current uncommitted changes");
    await closeComparison(page);
    await expect(
      page.getByTestId("file-list").getByRole("option", { name: /staged\.txt\s*, added, staged/ }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("file-list")
        .getByRole("option", { name: /wip\.txt\s*, untracked, untracked/ }),
    ).toBeVisible();
  });

  test("a base ref compares from its merge base, and an unknown one says so inline", async () => {
    const { page } = app;
    await selectCheckout(page, second.path);
    await chooseComparison(page, "Compare with another base");
    const popover = page.getByTestId("comparison-popover");
    await popover.getByTestId("comparison-ref-input").fill("no-such-branch");
    await popover.getByTestId("comparison-ref-input").press("Enter");
    await expect(popover.getByTestId("comparison-error")).toBeVisible();
    await popover.getByTestId("comparison-ref-input").fill("main");
    await popover.getByTestId("comparison-ref-input").press("Enter");
    await expect(popover.getByTestId("comparison-error")).toBeHidden();
    await closeComparison(page);
    expect(await listedFiles(page)).toEqual(["first.txt", "second.txt"]);
  });

  test("kinds a checkout cannot have are disabled with the reason", async () => {
    const { page } = app;
    await selectCheckout(page, parallel.path);
    await page.keyboard.press("Meta+K");
    const popover = page.getByTestId("comparison-popover");
    for (const label of [
      "Already arrived since previous worktree",
      "All changes since previous worktree",
    ]) {
      const option = popover.locator("label", { hasText: label });
      await expect(option.getByRole("radio")).toBeDisabled();
      await expect(option).toContainText("No direct previous worktree");
    }
    await expect(popover.locator("label", { hasText: "Compare with upstream" })).toContainText(
      "This branch has no upstream",
    );
    await closeComparison(page);

    await selectCheckout(page, first.path);
    await page.keyboard.press("Meta+K");
    await expect(
      popover
        .locator("label", { hasText: "All changes since previous worktree" })
        .getByRole("radio"),
    ).toBeEnabled();
    await closeComparison(page);
  });

  test("switching modes keeps the same part of the file in view", async () => {
    const { page } = app;
    await selectCheckout(page, many.path);
    await selectFile(page, "long.txt");
    await page.keyboard.press(MODE_KEY.split);
    await expect.poll(() => firstVisibleLine(page)).not.toBeNull();
    await scrollToLine(page, 199);
    const anchor = await firstVisibleLine(page);
    expect(anchor).toBeGreaterThanOrEqual(198);
    for (const mode of ["unified", "result", "split"] as const) {
      await page.keyboard.press(MODE_KEY[mode]);
      await expect
        .poll(
          async () => {
            const line = await firstVisibleLine(page);
            return line !== null && Math.abs(line - (anchor ?? 0)) <= 2;
          },
          { message: `anchor kept in ${mode} mode` },
        )
        .toBe(true);
    }
  });

  test("the resulting file is unavailable for a deleted file", async () => {
    const { page } = app;
    await selectCheckout(page, many.path);
    await selectFile(page, "gone.txt");
    await expect(page.getByRole("button", { name: "Resulting file" })).toBeDisabled();
  });

  test("holding ↓ through 50 files ends on the last file's diff, with no git left running", async () => {
    const { page } = app;
    await selectCheckout(page, many.path);
    await selectFile(page, manyFiles[0] as string);
    await page.getByRole("listbox", { name: "Changed files" }).focus();
    for (let i = 0; i < 50; i += 1) await page.keyboard.press("ArrowDown");
    const last = manyFiles[50] as string;
    await expect.poll(() => selectedFile(page)).toBe(last);
    await expect(page.getByTestId("preview-title")).toHaveText(last);
    await expect
      .poll(async () => {
        const view = await previewState(page);
        const lines = await page.evaluate(() =>
          [
            ...(document
              .querySelector("diffs-container")
              ?.shadowRoot?.querySelectorAll("[data-line]") ?? []),
          ].map((row) => row.textContent ?? ""),
        );
        return (
          view.path === last &&
          lines.length > 0 &&
          lines.every((line) => /^(file 50|second line|changed line)$/.test(line))
        );
      })
      .toBe(true);
    await expect.poll(() => runningGitCalls(page), { timeout: 5_000 }).toEqual([]);
  });

  test("Focus preview hides the side panels, and file shortcuts keep working", async () => {
    const { page } = app;
    await selectCheckout(page, many.path);
    await selectFile(page, manyFiles[3] as string);
    await page.keyboard.press("Meta+T");
    await expect(page.getByTestId("timeline")).toBeVisible();
    await page.keyboard.press("Meta+Shift+F");
    await expect(page.getByTestId("navigator")).toBeHidden();
    await expect(page.getByTestId("timeline")).toBeHidden();
    await expect(page.getByTestId("focus-preview")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(page.getByTestId("preview-title")).toHaveText(manyFiles[4] as string);
    await page.keyboard.press("Meta+Shift+F");
    await expect(page.getByTestId("navigator")).toBeVisible();
    await expect(page.getByTestId("timeline")).toBeVisible();
    await page.keyboard.press("Meta+T");
    await expect(page.getByTestId("timeline")).toBeHidden();
  });

  test("the filter narrows the list as the person types", async () => {
    const { page } = app;
    await selectCheckout(page, many.path);
    await page.keyboard.press("Meta+F");
    await expect(page.getByTestId("file-filter")).toBeFocused();
    await page.keyboard.type("f-1");
    await expect(page.getByTestId("file-count")).toHaveText("10 of 62");
    await page.keyboard.type("7");
    expect(await listedFiles(page)).toEqual(["files/f-17.txt"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-count")).toHaveText("62 files");
  });

  test("with a diff open, both themes pass the accessibility checks", async () => {
    const { page } = app;
    await selectCheckout(page, many.path);
    await selectFile(page, "long.txt");
    await page.keyboard.press("Meta+T");
    for (const appearance of ["light", "dark"] as const) {
      await page.evaluate(
        (next) => window.treepeek.main.settings.set({ appearance: next }),
        appearance,
      );
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        appearance === "dark",
      );
      const violations = await contrastViolations(page);
      expect(violations.map((violation) => `${appearance}: ${violation}`)).toEqual([]);
    }
    // macOS "Increase contrast": the stronger variants must pass too.
    await page.emulateMedia({ contrast: "more" });
    try {
      for (const appearance of ["light", "dark"] as const) {
        await page.evaluate(
          (next) => window.treepeek.main.settings.set({ appearance: next }),
          appearance,
        );
        await page.waitForFunction(
          (dark) => document.documentElement.classList.contains("dark") === dark,
          appearance === "dark",
        );
        const violations = await contrastViolations(page);
        expect(violations.map((violation) => `${appearance}, more contrast: ${violation}`)).toEqual(
          [],
        );
      }
    } finally {
      await page.emulateMedia({ contrast: null });
    }
    await page.evaluate(() => window.treepeek.main.settings.set({ appearance: "system" }));
    await page.keyboard.press("Meta+T");
  });

  test("the keyboard reaches every control", async () => {
    const { page } = app;
    await selectCheckout(page, many.path);
    await selectFile(page, "long.txt");
    await page.keyboard.press("Meta+T");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const reached = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press("Tab");
      reached.add(
        await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          return (
            element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 30) ?? ""
          );
        }),
      );
    }
    for (const control of [
      "Timeline",
      "Refresh",
      "Close timeline",
      "Worktrees in timeline order",
      "Git folder",
      "Tree view",
      "Comparison settings",
      "Filter files",
      "Changed files",
      "Focus preview",
    ]) {
      expect([...reached], control).toContain(control);
    }
    expect([...reached].some((label) => label.startsWith("Appearance:"))).toBe(true);
    expect([...reached]).toEqual(
      expect.arrayContaining(["Side by side", "Unified", "Resulting file"]),
    );
    await page.keyboard.press("Meta+T");
  });
});
