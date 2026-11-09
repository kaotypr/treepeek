import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { writeLargeFixtures } from "../../scripts/make-diff-fixtures";
import type { FileDiff } from "../../src/shared/domain/diff";
import { type App, LAB_OUT_DIR, launchApp, target } from "./support/app";
import {
  expectSettledOn,
  expectShowing,
  MODES,
  type Mode,
  openLab,
  show,
  smallFixtures,
} from "./support/diff-lab";

const root = resolve(import.meta.dirname, "../..");
const LAB_FIXTURES = join(LAB_OUT_DIR, "renderer/lab-fixtures");

/** Strings only the lab's code contains; none may reach the production build. */
const LAB_MARKERS = ["diff-lab", "DiffLab", "Diff lab", "Rapid switch", "lab-fixtures"];

test("the production build contains no diff lab code", () => {
  test.skip(target === "packaged", "checks the `bun run build` output in out/");
  const files = listFiles(join(root, "out"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(file, "latin1");
    for (const marker of LAB_MARKERS) {
      expect(text.includes(marker), `${marker} in ${file}`).toBe(false);
    }
  }
});

test.describe("diff lab (lab build)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(target === "packaged", "the lab is never packaged");

  const fixtures = smallFixtures();
  let app: App;
  let page: Page;

  test.beforeAll(async () => {
    writeLargeFixtures(LAB_FIXTURES);
    app = await launchApp({ build: "lab", settings: { appearance: "light" } });
    page = app.page;
    await openLab(page);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  for (const mode of MODES) {
    test(`every small fixture renders in ${mode} mode`, async () => {
      for (const [name, diff] of fixtures) {
        await show(page, name, mode);
        await expectSettledOn(page, diff, mode);
      }
    });
  }

  test("rapid switching ends on the last selection, 10 runs out of 10", async () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const last = await page.evaluate((s) => {
        const lab = window.__diffLab;
        if (lab === undefined) throw new Error("The diff lab is not open");
        return lab.rapidSwitch(s);
      }, seed);
      const diff = fixtures.get(last.name);
      if (diff === undefined) throw new Error(`Unknown fixture ${last.name}`);
      await expectSettledOn(page, diff, last.mode);
    }
  });

  test("a theme flip changes colors without a new highlight request", async () => {
    await show(page, "small-edit", "split");
    await expectSettledOn(page, fixture(fixtures, "small-edit"), "split");
    await waitForHighlight(page);
    const before = await colors(page);
    expect(before.token).not.toBe("");
    expect(before.background).not.toBe("");
    const requests = await highlightRequests(page);

    await page.evaluate(() => window.treepeek.main.settings.set({ appearance: "dark" }));
    await expect
      .poll(() => page.evaluate(() => document.documentElement.className))
      .toContain("dark");
    await expect.poll(async () => (await colors(page)).token).not.toBe(before.token);
    const after = await colors(page);
    expect(after.background).not.toBe(before.background);
    await page.waitForTimeout(500);
    expect(await highlightRequests(page)).toBe(requests);

    await page.evaluate(() => window.treepeek.main.settings.set({ appearance: "light" }));
    await expect.poll(async () => (await colors(page)).token).toBe(before.token);
    expect(await highlightRequests(page)).toBe(requests);
  });

  test("a mode change keeps the view on the same hunk", async () => {
    const big = largeFixture("big-20k");
    await show(page, "big-20k", "split");
    await expectShowing(page, big, "split");
    const hunk = big.hunks[20];
    if (hunk === undefined) throw new Error("big-20k has fewer than 21 hunks");
    await page.evaluate(() => window.__diffLab?.view()?.scrollToHunk(20));
    await page.waitForTimeout(300);
    const anchor = await page.evaluate(() => window.__diffLab?.view()?.getAnchor() ?? null);
    expect(anchor).not.toBeNull();
    expect(anchor?.line).toBeGreaterThanOrEqual(hunk.newStart);
    expect(anchor?.line).toBeLessThan(hunk.newStart + hunk.newLines);

    for (const mode of ["unified", "result"] as const) {
      await page.evaluate((m) => window.__diffLab?.setMode(m), mode);
      await page.waitForTimeout(500);
      const next = await page.evaluate(() => window.__diffLab?.view()?.getAnchor() ?? null);
      expect(next?.line, `anchor line in ${mode} mode`).toBe(anchor?.line);
    }
  });

  test("the 50,000-line patch renders with highlighting off", async () => {
    const patch = largeFixture("patch-50k");
    expect(patch.limits.highlightOff).toBe(true);
    for (const mode of ["split", "unified"] as const satisfies readonly Mode[]) {
      await show(page, "patch-50k", mode);
      await expectShowing(page, patch, mode);
      await expect(page.getByTestId("diff-view-note")).toHaveText(
        "Highlighting off for large file.",
      );
    }
  });
});

function fixture(all: Map<string, FileDiff>, name: string): FileDiff {
  const diff = all.get(name);
  if (diff === undefined) throw new Error(`No fixture named ${name}`);
  return diff;
}

function largeFixture(name: string): FileDiff {
  return JSON.parse(readFileSync(join(LAB_FIXTURES, `${name}.json`), "utf8"));
}

function highlightRequests(page: Page): Promise<number> {
  return page.evaluate(() => window.__diffLab?.highlightRequests() ?? -1);
}

/** Waits until syntax colors are applied (the first token has a non-default color). */
async function waitForHighlight(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector("diffs-container")?.shadowRoot;
        const token = root?.querySelector<HTMLElement>("[data-line] span");
        return token?.style.getPropertyValue("--diffs-token-light") ?? "";
      }),
    )
    .not.toBe("");
}

/**
 * As painted: a syntax token whose light and dark colors differ, and an added line's
 * background.
 */
function colors(page: Page): Promise<{ token: string; background: string }> {
  return page.evaluate(() => {
    const root = document.querySelector("diffs-container")?.shadowRoot;
    const tokens = [...(root?.querySelectorAll<HTMLElement>("[data-line] span") ?? [])];
    const token = tokens.find(
      (span) =>
        span.style.getPropertyValue("--diffs-token-light").toLowerCase() !==
        span.style.getPropertyValue("--diffs-token-dark").toLowerCase(),
    );
    const added = root?.querySelector<HTMLElement>('[data-line-type="change-addition"]');
    return {
      token: token ? getComputedStyle(token).color : "",
      background: added ? getComputedStyle(added).backgroundColor : "",
    };
  });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}
