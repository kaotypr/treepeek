import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const root = import.meta.dirname;

/**
 * `bun run dev` only: the dev server injects React Refresh's inline preamble and HMR
 * `<style>` tags, and talks to the page over a websocket, so its CSP must allow those.
 * Built pages keep the strict policy in `index.html` (and the header `app://` adds).
 */
function devServerCsp(): Plugin {
  return {
    name: "treepeek:dev-server-csp",
    apply: "serve",
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*"),
  };
}

export default defineConfig({
  // Main and the core service build together. Two Rollup inputs into `out/` give
  // `out/main/index.js` and `out/core/index.js`; code both use lands in `out/chunks/`.
  // (electron-vite's `?modulePath` import would emit the core service as a hashed file
  // inside `out/main/`, which is not the layout the packaging and tests expect.)
  main: {
    build: {
      outDir: resolve(root, "out"),
      // `out/` also holds the preload and renderer builds; never wipe it from here.
      emptyOutDir: false,
      rollupOptions: {
        input: {
          "main/index": resolve(root, "src/main/index.ts"),
          "core/index": resolve(root, "src/core/index.ts"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(root, "out/preload"),
      // Windows run sandboxed, and a sandboxed preload must be a single CommonJS file.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, "src/preload/index.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    base: "./",
    resolve: {
      alias: { "@renderer": resolve(root, "src/renderer") },
    },
    plugins: [react(), tailwindcss(), devServerCsp()],
    build: {
      outDir: resolve(root, "out/renderer"),
      minify: "esbuild",
      rollupOptions: {
        input: { index: resolve(root, "src/renderer/index.html") },
      },
    },
  },
});
