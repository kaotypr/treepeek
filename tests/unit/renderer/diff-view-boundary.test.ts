import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The viewer library stays behind `DiffView` (diff-pipeline design, "DiffView interface"),
 * so it can be swapped: nothing outside `src/renderer/diff-view/` may import it.
 */
const root = resolve(import.meta.dirname, "../../..");
const SRC = join(root, "src");
const ALLOWED = join(SRC, "renderer", "diff-view") + sep;
/** `from "…"`, a side-effect `import "…"`, or a dynamic `import("…")` of the library. */
const LIBRARY_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["']@pierre\/diffs(?:\/[^"']*)?["']/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("diff viewer boundary", () => {
  it("only src/renderer/diff-view imports @pierre/diffs", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(ALLOWED))
      .filter((file) => LIBRARY_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("finds the adapter's own imports (the check can fail)", () => {
    const inside = sourceFiles(ALLOWED).filter((file) =>
      LIBRARY_IMPORT.test(readFileSync(file, "utf8")),
    );
    expect(inside.length).toBeGreaterThan(0);
  });
});
