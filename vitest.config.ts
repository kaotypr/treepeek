import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "tests/unit/shared/**/*.test.ts",
            "tests/unit/core/**/*.test.ts",
            "tests/unit/main/**/*.test.ts",
            "tests/unit/build/**/*.test.ts",
          ],
          // Tests create real temporary git repositories.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          // Real repositories, real watchers and the debounce window.
          testTimeout: 30_000,
        },
      },
      {
        resolve: {
          alias: { "@renderer": resolve(root, "src/renderer") },
        },
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["tests/unit/renderer/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
