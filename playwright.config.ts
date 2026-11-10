import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the built app (`APP_TARGET=dev`, after `bun run build`) or the
 * packaged one (`APP_TARGET=packaged`, after `bun run package`). Each test launches its own
 * Electron instance, so they run one at a time.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  // With traces on (`TREEPEEK_E2E_TRACE=1`, in CI), keep a test's trace and logs only when it
  // fails. The performance specs write their results next to these folders, not inside them.
  preserveOutput: process.env.TREEPEEK_E2E_TRACE === "1" ? "failures-only" : "always",
});
