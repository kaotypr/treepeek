/**
 * Writes `build/THIRD_PARTY_NOTICES`: the license text, and any NOTICE file, of every package
 * the app ships, then the bundled Shiki grammars and themes with their licenses.
 *
 * `bun run notices`, and before every `bun run package`. electron-builder copies the file into
 * `Contents/Resources`, where About › Acknowledgements reads it. The output depends only on the
 * installed packages and the reviewed licenses in `build/`, so the same lockfile always writes
 * the same file. Grammars and themes the app leaves out are not listed.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Allowlist,
  assetKey,
  assetLicenseTexts,
  type BundledAsset,
  type BundledAssetSet,
  collectShipped,
  compareText,
  findException,
  loadAllowlist,
  type Shipped,
  type ShippedPackage,
} from "./licenses";

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

/** The reviewed licenses of grammars and themes: the exceptions and the texts read upstream. */
export interface AssetReview {
  allowlist: Allowlist;
  texts: ReadonlyMap<string, string>;
}

const NO_REVIEW: AssetReview = { allowlist: { allowed: [], exceptions: [] }, texts: new Map() };

export function renderNotices(shipped: Shipped, review: AssetReview = NO_REVIEW): string {
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
      ...set.assets.map((item) => `  ${item.name} (${licenseLabel(item, review)})`),
    );
  }
  for (const pkg of packages) out.push("", ...renderPackage(pkg));
  for (const set of shipped.bundled) out.push("", ...renderAssets(set, review));
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

function renderAssets(set: BundledAssetSet, review: AssetReview): string[] {
  const textOf = (item: BundledAsset) => review.texts.get(assetKey(item.kind, item.name));
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
    out.push(`${item.displayName} (${item.name})`, `  License: ${licenseLabel(item, review)}`);
    if (item.source) out.push(`  Source: ${item.source}`);
    if (textOf(item) !== undefined) out.push("  License text: below, as read at that source");
    else if (item.licenseUrl) out.push(`  License text: ${item.licenseUrl}`);
  }
  out.push("", `${set.collection.name} ${set.collection.version}:`, "", set.collection.licenseText);
  // The collection's own copies of license texts, except where the text read upstream at the
  // bundled commit replaces them below.
  const reviewed = new Set(
    set.assets.filter((item) => textOf(item) !== undefined).map((i) => i.name),
  );
  for (const block of set.notices) {
    const files = block.files.filter((name) => !reviewed.has(name));
    if (files.length === 0) continue;
    out.push("", THIN, `Files: ${files.join(", ")}`);
    if (block.licenseUrl) out.push(`License: ${block.licenseUrl}`);
    if (block.spdx) out.push(`SPDX: ${block.spdx}`);
    out.push(THIN, block.text);
  }
  for (const item of set.assets) {
    const text = textOf(item);
    if (text === undefined) continue;
    out.push("", THIN, `Files: ${item.name}`, `License: ${licenseLabel(item, review)}`);
    if (item.source) out.push(`Source: ${item.source}`);
    out.push(THIN, text);
  }
  return out;
}

function heading(set: BundledAssetSet): string {
  return set.kind === "grammar" ? "Syntax grammars" : "Color themes";
}

/** The license as reviewed, when the collection's record needed a review; else the record. */
function licenseLabel(item: BundledAsset, review: AssetReview): string {
  const exception = findException(review.allowlist, item);
  if (exception && exception.recorded !== null) {
    return `${exception.license}, reviewed at its source (the collection records ${item.license})`;
  }
  return item.license === "UNKNOWN" ? "not stated by its source" : item.license;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const target = join(root, "build", "THIRD_PARTY_NOTICES");
  const shipped = await collectShipped(root);
  const text = renderNotices(shipped, {
    allowlist: loadAllowlist(join(root, "build", "license-allowlist.json")),
    texts: assetLicenseTexts(root),
  });
  writeFileSync(target, text);
  const assets = shipped.bundled.map((set) => `${set.assets.length} ${set.kind}s`).join(", ");
  console.log(
    `Wrote build/THIRD_PARTY_NOTICES: ${shipped.packages.length} packages${assets ? `, ${assets}` : ""} (${Math.round(text.length / 1024)} KB).`,
  );
}
