import type { Page } from "@playwright/test";
import axe from "axe-core";

/**
 * Runs axe-core's WCAG A/AA rules (color contrast included) in the page and returns one line
 * per violating element. `@axe-core/playwright` is not used: its finishing step opens a new
 * page, which an Electron window reached over CDP cannot do.
 */
export async function contrastViolations(page: Page): Promise<string[]> {
  const loaded = await page.evaluate(() => "axe" in window);
  if (!loaded) await page.evaluate(axe.source);
  return page.evaluate(async () => {
    const runner = (window as unknown as { axe: typeof import("axe-core") }).axe;
    const results = await runner.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    return results.violations.flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id} at ${node.target.join(" ")}: ${node.failureSummary ?? ""}`,
      ),
    );
  });
}
