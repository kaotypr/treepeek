/**
 * The file list on a 5,000-file comparison (review screen plan, task 6). Timing on shared
 * runners is noise, so this runs only when asked: `TREEPEEK_PERF=1 bun run test:e2e
 * tests/e2e/file-list.perf.spec.ts`, on a local machine, after `bun run build`. The result
 * is written to `test-results/file-list-perf.json`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { fixture } from "../support/git-fixture";
import { launchWithFolder, target } from "./support/app";
import { measureWheelScroll } from "./support/perf";
import { selectCheckout, waitForScan } from "./support/review";

const FILES = 5_000;
const SCROLL_MS = 5_000;
const OUT = resolve(import.meta.dirname, "../../test-results/file-list-perf.json");

test.describe(`file list performance (${target})`, () => {
  test.skip(process.env.TREEPEEK_PERF !== "1", "set TREEPEEK_PERF=1 to measure");
  test.describe.configure({ timeout: 120_000 });

  test(`a ${FILES.toLocaleString("en")}-file comparison scrolls without dropped frames`, async () => {
    const fx = fixture();
    const repo = fx.repo("huge").commit({ "README.md": "huge\n" });
    const files: Record<string, string> = {};
    for (let i = 0; i < FILES; i += 1) {
      files[`src/module-${String(Math.floor(i / 100)).padStart(2, "0")}/file-${i}.ts`] =
        `export const n = ${i};\n`;
    }
    const checkout = repo.worktree("huge-wt", { from: "main" }).write(files);
    const app = await launchWithFolder(fx.root, { settings: { version: 1, appearance: "light" } });
    try {
      await waitForScan(app.page, 2);
      await selectCheckout(app.page, checkout.path);
      await expect(app.page.getByTestId("file-count")).toHaveText(`${FILES} files`, {
        timeout: 60_000,
      });
      // The list is the scroll container with the "Changed files" listbox role.
      await app.page.evaluate(() =>
        document
          .querySelector('[aria-label="Changed files"]')
          ?.setAttribute("data-testid", "file-list-scroll"),
      );
      const result = await measureWheelScroll(app, app.page, "file-list-scroll", SCROLL_MS);
      console.log(JSON.stringify(result));
      mkdirSync(resolve(OUT, ".."), { recursive: true });
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            machine: {
              cpu: cpus()[0]?.model ?? "unknown",
              cores: cpus().length,
              memoryGB: Math.round(totalmem() / 1024 ** 3),
              darwin: release(),
            },
            files: FILES,
            result,
          },
          null,
          2,
        )}\n`,
      );
      // Both measurements must have seen the scroll; empty stats would pass every check.
      expect(result.scrolledPx).toBeGreaterThan(10_000);
      expect(result.frameIntervalMs.count).toBeGreaterThan(200);
      expect(result.mainThreadPerFrameMs.count).toBeGreaterThan(200);
      expect(result.mainThreadPerFrameMs.median).toBeLessThanOrEqual(16);
      expect(result.frameIntervalMs.median).toBeLessThanOrEqual(17);
    } finally {
      await app.close();
      fx.cleanup();
    }
  });
});
