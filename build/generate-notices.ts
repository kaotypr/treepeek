/**
 * Writes `build/THIRD_PARTY_NOTICES`: the license text, and any NOTICE file, of every package
 * the app ships, then the bundled Shiki grammars and themes with their licenses.
 *
 * `bun run notices`, and before every `bun run package`. electron-builder copies the file into
 * `Contents/Resources`, where About › Acknowledgements reads it. The output depends only on the
 * installed packages, so the same lockfile always writes the same file.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type BundledAssetSet,
  collectShipped,
  compareText,
  type Shipped,
  type ShippedPackage,
} from "./licenses";

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

export function renderNotices(shipped: Shipped): string {
  const out: string[] = [];
  const packages = uniquePackages(shipped.packages);
  out.push(
    "THIRD-PARTY SOFTWARE NOTICES",
    "",
    `Treepeek ${shipped.app.version} includes the open-source components listed below. Each is`,
    "distributed under its own license, reproduced in full further down, together with any",
    "NOTICE file the component carries.",
    "",
    `Treepeek runs on Electron${shipped.app.electron ? ` ${shipped.app.electron}` : ""}. The licenses of Electron, Chromium and their own`,
    "components ship inside the app as LICENSE.electron.txt and LICENSES.chromium.html.",
    "",
    RULE,
    "Contents",
    RULE,
    "",
    `Packages (${packages.length}):`,
    ...packages.map((pkg) => `  ${pkg.name} ${pkg.versions.join(", ")} (${pkg.license})`),
  );
  for (const set of shipped.bundled) {
    out.push(
      "",
      `${heading(set)} (${set.assets.length}), from ${set.bundledFrom}:`,
      ...set.assets.map((item) => `  ${item.name} (${licenseLabel(item.license)})`),
    );
  }
  for (const pkg of packages) out.push("", ...renderPackage(pkg));
  for (const set of shipped.bundled) out.push("", ...renderAssets(set));
  return `${out.join("\n")}\n`;
}

interface UniquePackage {
  name: string;
  versions: string[];
  license: string;
  source: string | null;
  texts: ShippedPackage["licenseFiles"];
  notices: ShippedPackage["noticeFiles"];
}

/** One entry per package name and license text, listing every installed version it covers. */
function uniquePackages(packages: readonly ShippedPackage[]): UniquePackage[] {
  const byKey = new Map<string, UniquePackage>();
  for (const pkg of packages) {
    const key = JSON.stringify([pkg.name, pkg.license, pkg.licenseFiles, pkg.noticeFiles]);
    const existing = byKey.get(key);
    if (existing) {
      existing.versions.push(pkg.version);
      continue;
    }
    byKey.set(key, {
      name: pkg.name,
      versions: [pkg.version],
      license: pkg.license,
      source: pkg.source,
      texts: pkg.licenseFiles,
      notices: pkg.noticeFiles,
    });
  }
  return [...byKey.values()].sort((a, b) => compareText(a.name, b.name));
}

function renderPackage(pkg: UniquePackage): string[] {
  const out = [RULE, `${pkg.name} ${pkg.versions.join(", ")}`, `License: ${pkg.license}`];
  if (pkg.source) out.push(`Source: ${pkg.source}`);
  out.push(THIN);
  if (pkg.texts.length === 0) {
    out.push(
      `The package carries no license file. Its package.json declares the license as ${pkg.license}.`,
    );
  }
  for (const [index, file] of pkg.texts.entries()) {
    if (pkg.texts.length > 1) out.push(`${index > 0 ? "\n" : ""}${file.name}:`, "");
    out.push(file.text);
  }
  for (const file of pkg.notices) out.push("", `${file.name}:`, "", file.text);
  return out;
}

function renderAssets(set: BundledAssetSet): string[] {
  const out = [
    RULE,
    `${heading(set)} bundled through Shiki (${set.bundledFrom})`,
    THIN,
    `Shiki bundles these ${set.kind}s from ${set.collection.name} ${set.collection.version}, which collects them`,
    `from the projects named below and records their licenses. ${set.collection.name} itself is`,
    `licensed ${set.collection.license}; its license follows the list.`,
    "",
  ];
  for (const item of set.assets) {
    out.push(`${item.displayName} (${item.name})`, `  License: ${licenseLabel(item.license)}`);
    if (item.source) out.push(`  Source: ${item.source}`);
    if (item.licenseUrl) out.push(`  License text: ${item.licenseUrl}`);
  }
  out.push("", `${set.collection.name} ${set.collection.version}:`, "", set.collection.licenseText);
  for (const block of set.notices) {
    out.push("", THIN, `Files: ${block.files.join(", ")}`);
    if (block.licenseUrl) out.push(`License: ${block.licenseUrl}`);
    if (block.spdx) out.push(`SPDX: ${block.spdx}`);
    out.push(THIN, block.text);
  }
  return out;
}

function heading(set: BundledAssetSet): string {
  return set.kind === "grammar" ? "Syntax grammars" : "Color themes";
}

function licenseLabel(license: string): string {
  return license === "UNKNOWN" ? "not stated by its source" : license;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const target = join(root, "build", "THIRD_PARTY_NOTICES");
  const shipped = await collectShipped(root);
  const text = renderNotices(shipped);
  writeFileSync(target, text);
  const assets = shipped.bundled.map((set) => `${set.assets.length} ${set.kind}s`).join(", ");
  console.log(
    `Wrote build/THIRD_PARTY_NOTICES: ${shipped.packages.length} packages${assets ? `, ${assets}` : ""} (${Math.round(text.length / 1024)} KB).`,
  );
}
