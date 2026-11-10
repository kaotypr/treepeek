import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderNotices } from "../../../build/generate-notices";
import {
  assetLicenseTexts,
  checkShipped,
  collectShipped,
  importSpecifiers,
  isAllowed,
  loadAllowlist,
  noticeBlocks,
  packageName,
  type Shipped,
  satisfiesCaret,
  shippedPackages,
} from "../../../build/licenses";
import {
  EXCLUDED_GRAMMARS,
  EXCLUDED_THEMES,
} from "../../../src/renderer/diff-view/highlight/excluded-assets";

const repoRoot = resolve(import.meta.dirname, "../../..");
const ALLOWED = new Set(["mit", "isc", "bsd-3-clause", "apache-2.0"]);

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "treepeek-licenses-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** A package folder with a manifest and optional files, under `dir`. */
function pkg(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  writeJson(join(dir, "package.json"), manifest);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

describe("isAllowed", () => {
  it.each([
    ["MIT", true],
    ["apache-2.0", true],
    ["(MIT OR GPL-3.0)", true],
    ["GPL-3.0 OR MIT", true],
    ["MIT AND ISC", true],
    ["MIT AND GPL-3.0", false],
    ["(MIT AND GPL-3.0) OR ISC", true],
    ["GPL-3.0", false],
    ["Apache-2.0 WITH LLVM-exception", false],
    ["UNKNOWN", false],
    ["NOASSERTION", false],
    ["SEE LICENSE IN LICENSE", false],
    ["(MIT", false],
    ["MIT OR", false],
    ["", false],
  ])("%s → %s", (expression, expected) => {
    expect(isAllowed(expression, ALLOWED)).toBe(expected);
  });

  it("allows an exception pair only when the whole pair is listed", () => {
    const allowed = new Set([...ALLOWED, "apache-2.0 with llvm-exception"]);
    expect(isAllowed("Apache-2.0 WITH LLVM-exception", allowed)).toBe(true);
  });
});

describe("importSpecifiers and packageName", () => {
  it("finds runtime imports and leaves out type-only ones", () => {
    const source = [
      'import React, { useState } from "react";',
      "import {",
      "  a,",
      "  b,",
      '} from "@scope/multi-line";',
      'import type { Thing } from "types-only";',
      'export type { Other } from "types-only-too";',
      'export { c } from "re-exported";',
      'import "side-effect/worker.js";',
      'const lazy = import("dynamic-pkg");',
      'type Mod = typeof import("typeof-only");',
      'const legacy = require("required-pkg");',
      '// import gone from "line-comment"',
      '/* import gone from "block-comment" */',
      'const url = "https://example.com/x"; import last from "after-url";',
    ].join("\n");
    expect(importSpecifiers(source).sort()).toEqual(
      [
        "@scope/multi-line",
        "after-url",
        "dynamic-pkg",
        "re-exported",
        "react",
        "required-pkg",
        "side-effect/worker.js",
      ].sort(),
    );
  });

  it("finds CSS imports", () => {
    expect(importSpecifiers('@import "tailwindcss";\n@plugin "some-plugin";')).toEqual([
      "tailwindcss",
      "some-plugin",
    ]);
  });

  it.each([
    ["react", "react"],
    ["react-dom/client", "react-dom"],
    ["@pierre/diffs/worker/worker.js", "@pierre/diffs"],
    ["@base-ui/react/switch", "@base-ui/react"],
    ["pkg/file.js?worker", "pkg"],
    ["./local", null],
    ["../up", null],
    ["/absolute", null],
    ["node:fs", null],
    ["fs", null],
    ["@renderer/lib/utils", null],
    ["virtual:thing", null],
    ["@scope", null],
  ])("%s → %s", (specifier, expected) => {
    expect(packageName(specifier)).toBe(expected);
  });
});

describe("shippedPackages", () => {
  it("follows dependencies the way Node resolves them, and not dev dependencies", () => {
    const root = tempDir();
    const nm = join(root, "node_modules");
    pkg(
      join(nm, "a"),
      {
        name: "a",
        version: "1.0.0",
        license: "MIT",
        dependencies: { b: "^2" },
        optionalDependencies: { "not-installed": "1" },
        peerDependencies: { "optional-peer": "1", "c-peer": "1" },
        peerDependenciesMeta: { "optional-peer": { optional: true } },
        devDependencies: { "dev-only": "1" },
      },
      { LICENSE: "MIT text of a", "NOTICE.md": "a's notice" },
    );
    pkg(join(nm, "a", "node_modules", "b"), {
      name: "b",
      version: "2.0.0",
      licenses: [{ type: "MIT" }, { type: "Apache-2.0" }],
    });
    pkg(join(nm, "b"), { name: "b", version: "1.0.0", license: "ISC" });
    pkg(join(nm, "c-peer"), {
      name: "c-peer",
      version: "1.0.0",
      license: { type: "BSD-3-Clause" },
    });
    pkg(join(nm, "optional-peer"), { name: "optional-peer", version: "1.0.0", license: "GPL-3.0" });
    pkg(join(nm, "dev-only"), { name: "dev-only", version: "1.0.0", license: "GPL-3.0" });

    const shipped = shippedPackages(root, ["a"]);
    expect(shipped.map((p) => `${p.name}@${p.version} ${p.license}`)).toEqual([
      "a@1.0.0 MIT",
      "b@2.0.0 (MIT OR Apache-2.0)",
      "c-peer@1.0.0 BSD-3-Clause",
    ]);
    const a = shipped[0];
    expect(a?.licenseFiles).toEqual([{ name: "LICENSE", text: "MIT text of a" }]);
    expect(a?.noticeFiles).toEqual([{ name: "NOTICE.md", text: "a's notice" }]);
  });

  it("refuses a missing required dependency", () => {
    const root = tempDir();
    pkg(join(root, "node_modules", "a"), {
      name: "a",
      version: "1.0.0",
      license: "MIT",
      dependencies: { missing: "1" },
    });
    expect(() => shippedPackages(root, ["a"])).toThrow(/missing \(needed by a@1.0.0\)/);
  });

  it("marks a package that declares no license as UNKNOWN", () => {
    const root = tempDir();
    pkg(join(root, "node_modules", "bare"), { name: "bare", version: "1.0.0" });
    expect(shippedPackages(root, ["bare"])[0]?.license).toBe("UNKNOWN");
  });
});

describe("checkShipped", () => {
  function shipped(packages: Shipped["packages"]): Shipped {
    return {
      app: { name: "treepeek", version: "0.0.0", electron: null },
      packages,
      bundled: [
        {
          kind: "grammar",
          bundledFrom: "@shikijs/langs 1.0.0",
          collection: { name: "tm-grammars", version: "1.0.0", license: "MIT", licenseText: "" },
          assets: [
            {
              kind: "grammar",
              name: "copyleft",
              displayName: "Copyleft",
              license: "GPL-3.0",
              licenseUrl: null,
              source: "https://example.com/copyleft",
            },
          ],
          notices: [],
        },
      ],
    };
  }
  const entry = (name: string, license: string, notice = false): Shipped["packages"][number] => ({
    name,
    version: "1.0.0",
    dir: `/repo/node_modules/${name}`,
    license,
    licenseFiles: [],
    noticeFiles: notice ? [{ name: "NOTICE", text: "notice" }] : [],
    source: null,
  });
  const allowlist = (exceptions: unknown[] = []) => {
    const file = join(tempDir(), "allowlist.json");
    writeJson(file, { allowed: ["MIT", "Apache-2.0"], exceptions });
    return loadAllowlist(file);
  };

  it("reports packages and bundled assets outside the allow-list", () => {
    const result = checkShipped(
      shipped([entry("fine", "MIT"), entry("gpl", "GPL-3.0")]),
      allowlist(),
      "",
    );
    expect(result.checked).toEqual({ packages: 2, grammars: 1, themes: 0 });
    expect(result.violations.map((f) => `${f.kind} ${f.name} ${f.license}`)).toEqual([
      "package gpl GPL-3.0",
      "grammar copyleft GPL-3.0",
    ]);
  });

  it("accepts a reviewed exception only for the license it was reviewed for", () => {
    const result = checkShipped(
      shipped([entry("gpl", "GPL-3.0"), entry("changed", "AGPL-3.0")]),
      allowlist([
        { package: "gpl", license: "GPL-3.0", reason: "reviewed" },
        { package: "changed", license: "GPL-3.0", reason: "reviewed for the old license" },
        { grammar: "copyleft", license: "GPL-3.0", reason: "reviewed grammar" },
        { theme: "gone", license: "GPL-3.0", reason: "no longer shipped" },
      ]),
      "",
    );
    expect(result.violations.map((f) => f.name)).toEqual(["changed"]);
    expect(result.excepted.map((f) => `${f.name}: ${f.reason}`)).toEqual([
      "gpl: reviewed",
      "copyleft: reviewed grammar",
    ]);
    expect(result.unusedExceptions.map((e) => e.name)).toEqual(["changed", "gone"]);
  });

  it("requires the root NOTICE to name Apache-2.0 packages that carry a NOTICE file", () => {
    const packages = [entry("@scope/apache", "Apache-2.0", true), entry("mit", "MIT", true)];
    expect(
      checkShipped(shipped(packages), allowlist(), "").missingFromNotice.map((p) => p.name),
    ).toEqual(["@scope/apache"]);
    expect(
      checkShipped(shipped(packages), allowlist(), "Bundled:\n\n- @scope/apache\n")
        .missingFromNotice,
    ).toEqual([]);
    // A longer name that merely starts with it does not count.
    expect(
      checkShipped(shipped(packages), allowlist(), "- @scope/apache-extra\n").missingFromNotice,
    ).toHaveLength(1);
  });

  it("applies a reviewed exception only while the collection records the same value", () => {
    const reviewed = {
      grammar: "copyleft",
      license: "MIT",
      recorded: "GPL-3.0",
      reason: "the upstream LICENSE is MIT",
    };
    const texts = new Map([["grammar-copyleft", "MIT text"]]);
    const result = checkShipped(shipped([]), allowlist([reviewed]), "", texts);
    expect(result.violations).toEqual([]);
    expect(result.excepted.map((f) => f.name)).toEqual(["copyleft"]);
    expect(result.missingLicenseText).toEqual([]);
    // The record changed: the review no longer covers it.
    const changed = checkShipped(
      shipped([]),
      allowlist([{ ...reviewed, recorded: "NOASSERTION" }]),
      "",
      texts,
    );
    expect(changed.violations.map((f) => f.name)).toEqual(["copyleft"]);
  });

  it("requires the license text of a grammar or theme it accepts by exception", () => {
    const result = checkShipped(
      shipped([]),
      allowlist([{ grammar: "copyleft", license: "MIT", recorded: "GPL-3.0", reason: "r" }]),
      "",
    );
    expect(result.violations).toEqual([]);
    expect(result.missingLicenseText.map((f) => f.name)).toEqual(["copyleft"]);
  });

  it("refuses an exception without a reason", () => {
    const file = join(tempDir(), "allowlist.json");
    writeJson(file, { allowed: [], exceptions: [{ package: "x", license: "GPL-3.0" }] });
    expect(() => loadAllowlist(file)).toThrow(/needs a "reason"/);
  });
});

describe("noticeBlocks", () => {
  it("splits a collection's NOTICE into the blocks for the wanted files", () => {
    const rule = "=".repeat(105);
    const thin = "-".repeat(105);
    const file = join(tempDir(), "NOTICE");
    writeFileSync(
      file,
      [
        "THIRD-PARTY SOFTWARE NOTICES",
        "",
        rule,
        "Files:   one.json, two.json",
        "License: https://example.com/one",
        "SPDX:    MIT",
        thin,
        "MIT text",
        "=".repeat(78),
        "a rule inside the license text",
        "",
        rule,
        "Files:   three.json",
        "License: https://example.com/three",
        "SPDX:    Apache-2.0",
        thin,
        "Apache text",
        "",
      ].join("\n"),
    );
    expect(noticeBlocks(file, ["two"])).toEqual([
      {
        files: ["two"],
        licenseUrl: "https://example.com/one",
        spdx: "MIT",
        text: `MIT text\n${"=".repeat(78)}\na rule inside the license text`,
      },
    ]);
    expect(noticeBlocks(file, ["one", "three"]).map((block) => block.files)).toEqual([
      ["one"],
      ["three"],
    ]);
  });
});

describe("satisfiesCaret", () => {
  it.each([
    ["1.32.22", "^1.32.22", true],
    ["1.40.0", "^1.32.22", true],
    ["1.32.21", "^1.32.22", false],
    ["2.0.0", "^1.32.22", false],
    ["0.4.1", "^0.4.0", true],
    ["0.5.0", "^0.4.0", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
  ])("%s in %s → %s", (version, range, expected) => {
    expect(satisfiesCaret(version, range)).toBe(expected);
  });
});

describe("the app's own shipped set", () => {
  it("includes the diff viewer, the runtime dependency and every Shiki grammar and theme", async () => {
    const shipped = await collectShipped(repoRoot);
    const names = shipped.packages.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(["@pierre/diffs", "@parcel/watcher", "react", "shiki", "valibot"]),
    );
    // Build tools and test tools are not shipped.
    for (const tool of ["electron", "electron-builder", "vite", "vitest", "typescript"]) {
      expect(names).not.toContain(tool);
    }
    const grammars = shipped.bundled.find((set) => set.kind === "grammar")?.assets ?? [];
    const themes = shipped.bundled.find((set) => set.kind === "theme")?.assets ?? [];
    expect(grammars.map((g) => g.name)).toEqual(
      expect.arrayContaining(["typescript", "javascript", "json", "markdown", "yaml", "hcl"]),
    );
    expect(themes.map((t) => t.name)).toEqual(expect.arrayContaining(["andromeeda"]));

    const text = renderNotices(shipped);
    expect(text).toMatch(/^@pierre\/diffs \d+\.\d+\.\d+$/m);
    expect(text).toContain("TypeScript (typescript)");
    expect(text).toContain("Syntax grammars bundled through Shiki");
    expect(text).toContain("Color themes bundled through Shiki");
  }, 30_000);

  it("leaves out the grammars and themes the build leaves out", async () => {
    const shipped = await collectShipped(repoRoot);
    const names = (kind: string) =>
      shipped.bundled.find((set) => set.kind === kind)?.assets.map((a) => a.name) ?? [];
    for (const { name } of EXCLUDED_GRAMMARS) expect(names("grammar")).not.toContain(name);
    for (const { name } of EXCLUDED_THEMES) expect(names("theme")).not.toContain(name);
    const text = renderNotices(shipped);
    for (const { name } of [...EXCLUDED_GRAMMARS, ...EXCLUDED_THEMES]) {
      expect(text).not.toMatch(new RegExp(`\\(${name}\\)$|^Files: (.*, )?${name}(,|$)`, "m"));
    }
  }, 30_000);

  it("ships the license text read upstream for every reviewed grammar and theme", async () => {
    const shipped = await collectShipped(repoRoot);
    const allowlist = loadAllowlist(join(repoRoot, "build", "license-allowlist.json"));
    const texts = assetLicenseTexts(repoRoot);
    const result = checkShipped(shipped, allowlist, "", texts);
    expect(result.missingLicenseText).toEqual([]);
    const text = renderNotices(shipped, { allowlist, texts });
    const reviewed = allowlist.exceptions.filter((entry) => entry.kind !== "package");
    expect(reviewed.length).toBeGreaterThan(0);
    for (const entry of reviewed) {
      const licenseText = texts.get(`${entry.kind}-${entry.name}`) ?? "";
      expect(text).toContain(`Files: ${entry.name}\nLicense: ${entry.license}`);
      expect(text).toContain(licenseText);
    }
  }, 30_000);
});
