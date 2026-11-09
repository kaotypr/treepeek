import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Driving the review screen the way a person does: the picker, the file list, the preview
 * and the shortcuts. Every helper waits for what it changed to be on screen.
 */

/** Waits until the window's scan is done (the navigator states the checkout count). */
export async function waitForScan(page: Page, count?: number): Promise<void> {
  const status = page.getByTestId("scan-status");
  await expect(status).toHaveText(
    count === undefined ? /Git checkout|No Git checkouts/ : new RegExp(`^${count} Git checkouts?`),
    { timeout: 30_000 },
  );
}

export async function selectCheckout(page: Page, path: string): Promise<void> {
  await page.getByTestId("folder-picker").selectOption(path);
  await expect(page.getByTestId("checkout-details")).toBeVisible();
}

/** The picker's value: the selected checkout's path, or `""`. */
export function selectedCheckout(page: Page): Promise<string> {
  return page.getByTestId("folder-picker").inputValue();
}

export function fileRows(page: Page): Locator {
  return page.getByTestId("file-list").getByRole("option");
}

/** The paths in the file list, in order (only the rows the list has rendered). */
export async function listedFiles(page: Page): Promise<string[]> {
  await expect(page.getByTestId("file-list").getByText("Loading changes…")).toHaveCount(0);
  return fileRows(page).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-path") ?? ""),
  );
}

export async function selectFile(page: Page, path: string): Promise<void> {
  await page
    .getByTestId("file-list")
    .locator(`[role="option"][data-path="${path}"]`)
    .first()
    .click();
  await expect(page.getByTestId("preview-title")).toContainText(path);
}

/** The selected row in the file list, by path. */
export function selectedFile(page: Page): Promise<string | null> {
  return page
    .getByTestId("file-list")
    .locator('[role="option"][aria-selected="true"]')
    .getAttribute("data-path", { timeout: 2_000 })
    .catch(() => null);
}

/** Picks a comparison kind in the settings popover, opening it with ⌘K when needed. */
export async function chooseComparison(page: Page, label: string): Promise<void> {
  const popover = page.getByTestId("comparison-popover");
  if (!(await popover.isVisible())) await page.keyboard.press("Meta+K");
  await expect(popover).toBeVisible();
  await popover.getByRole("radio", { name: label, exact: false }).check();
}

export async function closeComparison(page: Page): Promise<void> {
  const popover = page.getByTestId("comparison-popover");
  if (await popover.isVisible()) await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
}

/** Text of every line the diff viewer has rendered (both columns in split mode). */
export function renderedLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = document.querySelector("diffs-container");
    return [...(host?.shadowRoot?.querySelectorAll("[data-line]") ?? [])].map(
      (row) => row.textContent ?? "",
    );
  });
}

/** The diff view's path and mode, or the notice it shows instead. */
export function previewState(
  page: Page,
): Promise<{ path: string | null; mode: string | null; notice: string | null }> {
  return page.evaluate(() => {
    const view =
      document.querySelector<HTMLElement>('[data-testid="diff-view-scroll"]') ??
      document.querySelector<HTMLElement>('[data-testid="diff-view-notice"]');
    return {
      path: view?.dataset.diffPath ?? null,
      mode: view?.dataset.diffMode ?? null,
      notice: document.querySelector('[data-testid="diff-view-notice"]')?.textContent ?? null,
    };
  });
}

/**
 * One-off git processes the core service is running now: its child processes, minus the
 * long-lived `cat-file` and `hash-object` batch processes it keeps on purpose.
 */
export async function runningGitCalls(page: Page): Promise<string[]> {
  const { execFileSync } = await import("node:child_process");
  const info = await page.evaluate(() => window.treepeek.core.app.info());
  if (!info.ok) throw new Error("the core service did not answer");
  const listing = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid]) => Number(ppid) === info.value.pid)
    .map((parts) => parts.slice(2).join(" "))
    .filter((command) => /\bgit\b/.test(command) && !/cat-file|hash-object/.test(command));
}
