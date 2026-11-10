import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import {
  EXCLUDED_GRAMMARS,
  EXCLUDED_THEMES,
} from "./src/renderer/diff-view/highlight/excluded-assets";

const root = import.meta.dirname;

/** The id every import of an excluded grammar or theme resolves to. */
const EXCLUDED_ASSET_MODULE = "\0treepeek:excluded-shiki-asset";

/**
 * Leaves the grammars and themes in `excluded-assets.ts` out of the app. `@pierre/diffs`
 * loads Shiki's full catalog, which imports each one by name (`@shikijs/langs/ada`), and some
 * grammars import others they embed (`./glsl.mjs` from `cpp.mjs`). Whatever the import, a
 * module that resolves to an excluded file becomes one shared empty module: an embedding
 * grammar just loses that embedded language, and the renderer shows the excluded languages
 * as plain text without asking for them (`pierre/to-pierre.ts`).
 */
function excludeShikiAssets(): Plugin {
  const excluded = new Set([
    ...EXCLUDED_GRAMMARS.map(({ name }) => `@shikijs/langs/dist/${name}.mjs`),
    ...EXCLUDED_THEMES.map(({ name }) => `@shikijs/themes/dist/${name}.mjs`),
  ]);
  // `.../node_modules/@shikijs/langs/dist/ada.mjs` → `@shikijs/langs/dist/ada.mjs`
  const shikiModule =
    /[\\/]node_modules[\\/](@shikijs[\\/](?:langs|themes)[\\/]dist[\\/][^\\/]+\.mjs)$/;
  const isExcluded = (id: string) => {
    const match = shikiModule.exec(id.split("?")[0] ?? "");
    return match?.[1] !== undefined && excluded.has(match[1].replaceAll("\\", "/"));
  };
  return {
    name: "treepeek:exclude-shiki-assets",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const shikiImport =
        /^@shikijs\/(langs|themes)\//.test(source) ||
        (source.startsWith("./") && /[\\/]@shikijs[\\/](langs|themes)[\\/]/.test(importer ?? ""));
      if (!shikiImport) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && isExcluded(resolved.id) ? EXCLUDED_ASSET_MODULE : null;
    },
    load(id) {
      // An empty grammar list: spread into an embedding grammar's list, it adds nothing.
      return id === EXCLUDED_ASSET_MODULE ? "export default [];" : null;
    },
  };
}

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

export default defineConfig(({ mode }) => {
  // `--mode lab` builds the development pages (the diff lab) into their own folder, so the
  // production build in `out/` never contains them. See `src/renderer/dev/lab-enabled.ts`.
  const out = resolve(root, mode === "lab" ? "out-lab" : "out");
  return {
    // Main and the core service build together. Two Rollup inputs into `out/` give
    // `out/main/index.js` and `out/core/index.js`; code both use lands in `out/chunks/`.
    // (electron-vite's `?modulePath` import would emit the core service as a hashed file
    // inside `out/main/`, which is not the layout the packaging and tests expect.)
    main: {
      build: {
        outDir: out,
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
        outDir: resolve(out, "preload"),
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
      plugins: [react(), tailwindcss(), devServerCsp(), excludeShikiAssets()],
      // The highlight worker is a module worker that splits its grammars into chunks.
      worker: { format: "es", plugins: () => [excludeShikiAssets()] },
      build: {
        outDir: resolve(out, "renderer"),
        minify: "esbuild",
        rollupOptions: {
          input: { index: resolve(root, "src/renderer/index.html") },
        },
      },
    },
  };
});
