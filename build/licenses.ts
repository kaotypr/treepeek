/**
 * What Treepeek ships, and under which licenses: the shared half of
 * `build/generate-notices.ts` and `build/check-licenses.ts`.
 *
 * The app ships two kinds of third-party code, and both count:
 *
 * - Runtime `dependencies` (only `@parcel/watcher` today), which electron-builder copies
 *   into `app.asar` with everything they depend on.
 * - The dev dependencies electron-vite bundles into `out/`: React, `@pierre/diffs`, Shiki and
 *   the rest. They are dev dependencies only so that electron-builder does not copy them a
 *   second time.
 *
 * So the shipped set starts from the runtime dependencies plus every package the app's
 * source imports, and follows each package's own dependencies from there. That can include
 * a package the bundler later drops, never miss one it keeps. Package manifests are read
 * straight from `node_modules`, which the hoisted install (`bunfig.toml`) lays out the way
 * Node resolves it.
 *
 * Shiki's grammars and themes are bundled from `@shikijs/langs` and `@shikijs/themes`, which
 * carry no license data of their own. Their licenses come from `tm-grammars` and
 * `tm-themes`, the collections Shiki builds them from (dev dependencies for that reason).
 * The ones in `src/renderer/diff-view/highlight/excluded-assets.ts` are left out of the
 * build, so they are not shipped. Where a collection records no usable license, the license
 * was reviewed upstream: `build/license-allowlist.json` records it, and
 * `build/asset-licenses/<kind>-<name>.txt` holds the license text read there.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXCLUDED_GRAMMARS,
  EXCLUDED_THEMES,
} from "../src/renderer/diff-view/highlight/excluded-assets";

/** The source folders whose code ends up in the app. */
const SOURCE_DIRS = ["src/main", "src/core", "src/preload", "src/renderer", "src/shared"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".css", ".html"];

/**
 * Imported by the app but not shipped from `node_modules`: Electron is the runtime itself,
 * and its licenses ship in the app as `LICENSE.electron.txt` and `LICENSES.chromium.html`.
 */
const PROVIDED_BY_RUNTIME = new Set(["electron"]);

export interface LicenseFile {
  /** The file's name inside the package, such as `LICENSE.md`. */
  name: string;
  text: string;
}

export interface ShippedPackage {
  name: string;
  version: string;
  /** Absolute path of the package folder. */
  dir: string;
  /** The SPDX expression from `package.json`, or `UNKNOWN` when it declares none. */
  license: string;
  licenseFiles: LicenseFile[];
  noticeFiles: LicenseFile[];
  /** A browsable source URL, when `package.json` names one. */
  source: string | null;
}

export interface BundledAsset {
  kind: "grammar" | "theme";
  name: string;
  displayName: string;
  /** The SPDX id the collection records, or `UNKNOWN` when it records none. */
  license: string;
  licenseUrl: string | null;
  source: string | null;
}

/** One block of a collection's NOTICE file: the license text that covers `files`. */
export interface NoticeBlock {
  files: string[];
  licenseUrl: string | null;
  spdx: string | null;
  text: string;
}

export interface BundledAssetSet {
  kind: "grammar" | "theme";
  /** The package the app bundles them from, such as `@shikijs/langs 4.6.0`. */
  bundledFrom: string;
  /** The collection their license data comes from, such as `tm-grammars 1.32.22`. */
  collection: { name: string; version: string; license: string; licenseText: string };
  assets: BundledAsset[];
  notices: NoticeBlock[];
}

export interface Shipped {
  /** The app's own `package.json` name and version. */
  app: { name: string; version: string; electron: string | null };
  packages: ShippedPackage[];
  bundled: BundledAssetSet[];
}

interface Manifest {
  name: string;
  version: string;
  license: string;
  dependencies: string[];
  optionalDependencies: string[];
  peerDependencies: string[];
  devDependencies: Record<string, string>;
  source: string | null;
}

/** Collects what the app at `root` ships. Throws when the install is incomplete. */
export async function collectShipped(root: string): Promise<Shipped> {
  const app = readManifest(root);
  const roots = new Set([...app.dependencies, ...sourceImports(root)]);
  const packages = shippedPackages(root, [...roots]);
  const electronDir = resolvePackageDir("electron", root, root);
  const bundled: BundledAssetSet[] = [];
  const langs = packages.find((pkg) => pkg.name === "@shikijs/langs");
  if (langs) bundled.push(await bundledGrammars(root, langs));
  const themes = packages.find((pkg) => pkg.name === "@shikijs/themes");
  if (themes) bundled.push(await bundledThemes(root, themes));
  return {
    app: {
      name: app.name,
      version: app.version,
      electron: electronDir ? readManifest(electronDir).version : null,
    },
    packages,
    bundled,
  };
}

// ---------------------------------------------------------------------------------------
// The app's imports

/** The npm packages the app's own source imports, by package name. */
export function sourceImports(root: string): string[] {
  const names = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(root, dir))) {
      if (file.endsWith(".d.ts")) continue;
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const name = packageName(specifier);
        if (name && !PROVIDED_BY_RUNTIME.has(name)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

/**
 * The module specifiers a file loads at run time: static and side-effect imports, re-exports,
 * dynamic `import()`, `require()`, and CSS `@import` / `@plugin`. Type-only imports and
 * `typeof import()` are left out: they never reach the bundle.
 */
export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const statement = /\b(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(statement)) {
    if (!match[2] && match[3]) found.push(match[3]);
  }
  const patterns = [
    /(?:^|[^\w.$@])import\s*["']([^"']+)["']/g,
    /(?<!typeof\s+)\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /@(?:import|plugin|reference)\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return found;
}

/** The package a specifier names, or `null` for relative paths, aliases and Node built-ins. */
export function packageName(specifier: string): string | null {
  const bare = specifier.split("?")[0] ?? "";
  if (bare === "" || bare.startsWith(".") || bare.startsWith("/") || bare.startsWith("#")) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return null; // node:, virtual:, data:, https:
  if (bare.startsWith("@renderer/")) return null; // the renderer's path alias
  const parts = bare.split("/");
  const name = bare.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  if (bare.startsWith("@") && parts.length < 2) return null;
  if (builtinModules.includes(name)) return null;
  return name;
}

function stripComments(source: string): string {
  // Block comments, then line comments that start a line or follow whitespace or code
  // punctuation (so the `//` inside a URL string is kept).
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1");
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) files.push(path);
  }
  return files.sort();
}

// ---------------------------------------------------------------------------------------
// The dependency tree

/**
 * Every package reachable from `roots` through `dependencies`, installed
 * `optionalDependencies` and required `peerDependencies`, resolved the way Node does from
 * each dependent's folder. Sorted by name, then version.
 */
export function shippedPackages(root: string, roots: readonly string[]): ShippedPackage[] {
  const seen = new Map<string, ShippedPackage>();
  const queue: { name: string; from: string; optional: boolean; via: string }[] = roots.map(
    (name) => ({ name, from: root, optional: false, via: "the app" }),
  );
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const dir = resolvePackageDir(next.name, next.from, root);
    if (!dir) {
      if (next.optional) continue;
      throw new Error(
        `${next.name} (needed by ${next.via}) is not installed. Run \`bun install --frozen-lockfile\`.`,
      );
    }
    const key = realpathSync(dir);
    if (seen.has(key)) continue;
    const manifest = readManifest(dir);
    seen.set(key, {
      name: manifest.name,
      version: manifest.version,
      dir: key,
      license: manifest.license,
      licenseFiles: readFiles(dir, LICENSE_FILE),
      noticeFiles: readFiles(dir, NOTICE_FILE),
      source: manifest.source,
    });
    const via = `${manifest.name}@${manifest.version}`;
    for (const name of manifest.dependencies) queue.push({ name, from: dir, optional: false, via });
    for (const name of manifest.optionalDependencies) {
      queue.push({ name, from: dir, optional: true, via });
    }
    for (const name of manifest.peerDependencies) {
      queue.push({ name, from: dir, optional: true, via });
    }
  }
  return [...seen.values()].sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.version, b.version),
  );
}

/** Node's lookup: `node_modules/<name>` in `from` and each parent, up to `root`. */
export function resolvePackageDir(name: string, from: string, root: string): string | null {
  const top = resolve(root);
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === top || !dir.startsWith(top + sep)) return null;
    dir = dirname(dir);
  }
}

function readManifest(dir: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${join(dir, "package.json")} has no name or version`);
  }
  const optionalPeers = isRecord(raw.peerDependenciesMeta) ? raw.peerDependenciesMeta : {};
  const peers = Object.keys(isRecord(raw.peerDependencies) ? raw.peerDependencies : {}).filter(
    (name) => {
      const meta = optionalPeers[name];
      return !(isRecord(meta) && meta.optional === true);
    },
  );
  return {
    name: raw.name,
    version: raw.version,
    license: licenseExpression(raw),
    dependencies: Object.keys(isRecord(raw.dependencies) ? raw.dependencies : {}),
    optionalDependencies: Object.keys(
      isRecord(raw.optionalDependencies) ? raw.optionalDependencies : {},
    ),
    peerDependencies: peers,
    devDependencies: stringRecord(raw.devDependencies),
    source: sourceUrl(raw.repository) ?? (typeof raw.homepage === "string" ? raw.homepage : null),
  };
}

/** `license`, the old `license: {type}` object, or the old `licenses` array (any of them). */
function licenseExpression(manifest: Record<string, unknown>): string {
  const { license, licenses } = manifest;
  if (typeof license === "string" && license.trim() !== "") return license.trim();
  if (isRecord(license) && typeof license.type === "string") return license.type.trim();
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (isRecord(entry) && typeof entry.type === "string" ? entry.type : null))
      .filter((type): type is string => type !== null);
    if (types.length === 1 && types[0]) return types[0];
    if (types.length > 1) return `(${types.join(" OR ")})`;
  }
  return "UNKNOWN";
}

function sourceUrl(repository: unknown): string | null {
  const raw =
    typeof repository === "string"
      ? repository
      : isRecord(repository) && typeof repository.url === "string"
        ? repository.url
        : null;
  if (!raw) return null;
  const github = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (github) return `https://github.com/${github[1]}`;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
}

const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;
const NOTICE_FILE = /^notice(\..*)?$/i;

function readFiles(dir: string, pattern: RegExp): LicenseFile[] {
  return readdirSync(dir)
    .filter((name) => pattern.test(name) && statSync(join(dir, name)).isFile())
    .sort(compareText)
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").trimEnd() }));
}

// ---------------------------------------------------------------------------------------
// Shiki's grammars and themes

async function bundledGrammars(root: string, langs: ShippedPackage): Promise<BundledAssetSet> {
  const collection = await loadCollection(root, langs, "tm-grammars");
  const raw = await import(pathToFileURL(join(collection.dir, "index.js")).href);
  const info = new Map<string, Record<string, unknown>>();
  for (const list of [raw.grammars, raw.injections]) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (isRecord(entry) && typeof entry.name === "string") info.set(entry.name, entry);
    }
  }
  const excluded = new Set(EXCLUDED_GRAMMARS.map((asset) => asset.name));
  const names = moduleNames(join(langs.dir, "dist")).filter((name) => !excluded.has(name));
  return {
    kind: "grammar",
    bundledFrom: `${langs.name} ${langs.version}`,
    collection: collection.summary,
    assets: names.map((name) => asset("grammar", name, info.get(name), collection.summary)),
    notices: noticeBlocks(join(collection.dir, "NOTICE"), names),
  };
}

async function bundledThemes(root: string, themes: ShippedPackage): Promise<BundledAssetSet> {
  const collection = await loadCollection(root, themes, "tm-themes");
  const raw = await import(pathToFileURL(join(collection.dir, "index.js")).href);
  const info = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(raw.themes) ? raw.themes : []) {
    if (isRecord(entry) && typeof entry.name === "string") info.set(entry.name, entry);
  }
  const excluded = new Set(EXCLUDED_THEMES.map((asset) => asset.name));
  const names = moduleNames(join(themes.dir, "dist")).filter((name) => !excluded.has(name));
  return {
    kind: "theme",
    bundledFrom: `${themes.name} ${themes.version}`,
    collection: collection.summary,
    assets: names.map((name) => asset("theme", name, info.get(name), collection.summary)),
    notices: noticeBlocks(join(collection.dir, "NOTICE"), names),
  };
}

/**
 * The collection a Shiki package was built from, checked against the range that package
 * declares, so the license data describes the grammars and themes actually bundled.
 */
async function loadCollection(
  root: string,
  bundler: ShippedPackage,
  name: "tm-grammars" | "tm-themes",
): Promise<{ dir: string; summary: BundledAssetSet["collection"] }> {
  const dir = resolvePackageDir(name, root, root);
  if (!dir) {
    throw new Error(
      `${name} is not installed. It holds the license data of the ${bundler.name} assets the app bundles; run \`bun install --frozen-lockfile\`.`,
    );
  }
  const manifest = readManifest(dir);
  const wanted = readManifest(bundler.dir).devDependencies[name];
  if (wanted && !satisfiesCaret(manifest.version, wanted)) {
    throw new Error(
      `${name} ${manifest.version} does not match the ${wanted} that ${bundler.name} ${bundler.version} was built from. Install a matching ${name}.`,
    );
  }
  const licenseText = readFiles(dir, LICENSE_FILE)
    .map((file) => file.text)
    .join("\n\n");
  return {
    dir,
    summary: { name, version: manifest.version, license: manifest.license, licenseText },
  };
}

/** The grammar or theme modules in a Shiki `dist` folder, without the alias modules. */
function moduleNames(dist: string): string[] {
  return readdirSync(dist)
    .filter((file) => file.endsWith(".mjs") && file !== "index.mjs")
    .filter((file) => !readFileSync(join(dist, file), "utf8").startsWith("/* Alias "))
    .map((file) => file.slice(0, -".mjs".length))
    .sort(compareText);
}

function asset(
  kind: BundledAsset["kind"],
  name: string,
  info: Record<string, unknown> | undefined,
  collection: BundledAssetSet["collection"],
): BundledAsset {
  if (!info) {
    throw new Error(
      `The bundled ${kind} "${name}" is missing from ${collection.name} ${collection.version}. Install the ${collection.name} version Shiki was built from.`,
    );
  }
  const text = (key: string) => (typeof info[key] === "string" ? (info[key] as string) : null);
  return {
    kind,
    name,
    displayName: text("displayName") ?? name,
    license: text("license") ?? "UNKNOWN",
    licenseUrl: text("licenseUrl"),
    source: text("source"),
  };
}

/**
 * The blocks of a `tm-grammars` / `tm-themes` NOTICE file that cover any of `names`. Each
 * block starts with a rule of `=` followed by `Files:`, `License:` and `SPDX:` lines, then
 * a rule of `-` and the license text (which may itself contain `=` rules).
 */
export function noticeBlocks(file: string, names: readonly string[]): NoticeBlock[] {
  const wanted = new Set(names);
  const text = readFileSync(file, "utf8");
  const blocks: NoticeBlock[] = [];
  for (const part of text.split(/\n={40,}\n(?=Files:)/).slice(1)) {
    const header = /^Files:\s*(.*)\n(?:License:\s*(.*)\n)?(?:SPDX:\s*(.*)\n)?-{40,}\n/.exec(part);
    if (!header) continue;
    const files = (header[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/\.json$/, ""))
      .filter((entry) => wanted.has(entry));
    if (files.length === 0) continue;
    blocks.push({
      files,
      licenseUrl: header[2]?.trim() || null,
      spdx: header[3]?.trim() || null,
      text: part.slice(header[0].length).trimEnd(),
    });
  }
  return blocks;
}

/** `version` satisfies `^range` (or an exact `range`): the same major, and not older. */
export function satisfiesCaret(version: string, range: string): boolean {
  const want = parseVersion(range.replace(/^[\^~=]/, ""));
  const have = parseVersion(version);
  if (!want || !have) return false;
  if (!range.startsWith("^")) return compareVersions(have, want) === 0;
  if (have[0] !== want[0]) return false;
  if (want[0] === 0 && have[1] !== want[1]) return false;
  return compareVersions(have, want) >= 0;
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------
// The allow-list

export interface LicenseException {
  kind: "package" | "grammar" | "theme";
  name: string;
  /** The license the review found (an SPDX id or `LicenseRef-…`). */
  license: string;
  /**
   * The value the package or collection records, when it differs from `license` (such as
   * `NOASSERTION`). The exception applies only while that value is unchanged, so a changed
   * record is reviewed again.
   */
  recorded: string | null;
  reason: string;
}

export interface Allowlist {
  allowed: string[];
  exceptions: LicenseException[];
}

/** Reads `build/license-allowlist.json`, refusing an exception without a reason. */
export function loadAllowlist(file: string): Allowlist {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.allowed) || !Array.isArray(raw.exceptions)) {
    throw new Error(`${file} needs an "allowed" list and an "exceptions" list`);
  }
  const allowed = raw.allowed.filter((id): id is string => typeof id === "string");
  const exceptions = raw.exceptions.map((entry, index): LicenseException => {
    const where = `${file}, exceptions[${index}]`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object`);
    const kinds = (["package", "grammar", "theme"] as const).filter(
      (kind) => typeof entry[kind] === "string",
    );
    const kind = kinds[0];
    if (kinds.length !== 1 || !kind) {
      throw new Error(`${where} needs exactly one of "package", "grammar" or "theme"`);
    }
    if (typeof entry.license !== "string" || entry.license.trim() === "") {
      throw new Error(`${where} needs the "license" the review found`);
    }
    if (entry.recorded !== undefined && typeof entry.recorded !== "string") {
      throw new Error(`${where}: "recorded" must be a string`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(`${where} needs a "reason"`);
    }
    return {
      kind,
      name: String(entry[kind]),
      license: entry.license,
      recorded: entry.recorded ?? null,
      reason: entry.reason,
    };
  });
  return { allowed, exceptions };
}

export interface Finding {
  kind: "package" | "grammar" | "theme";
  name: string;
  version: string | null;
  license: string;
  /** Where to look: the package folder relative to the root, or the asset's source. */
  where: string | null;
}

export interface CheckResult {
  checked: { packages: number; grammars: number; themes: number };
  /** Outside the allow-list, with no exception for that license. */
  violations: Finding[];
  /** Outside the allow-list, covered by a reviewed exception. */
  excepted: (Finding & { reason: string })[];
  /** Exceptions that match nothing shipped any more. */
  unusedExceptions: LicenseException[];
  /** Apache-2.0 packages with a NOTICE file that the root `NOTICE` does not name. */
  missingFromNotice: ShippedPackage[];
  /** Grammars and themes allowed by an exception, with no license text to ship. */
  missingLicenseText: Finding[];
}

/**
 * Checks every shipped package, grammar and theme against the allow-list. `assetTexts` holds
 * the reviewed license texts of grammars and themes (`assetLicenseTexts`).
 */
export function checkShipped(
  shipped: Shipped,
  allowlist: Allowlist,
  notice: string,
  assetTexts: ReadonlyMap<string, string> = new Map(),
): CheckResult {
  const allowed = new Set(allowlist.allowed.map((id) => id.toLowerCase()));
  const used = new Set<LicenseException>();
  const violations: Finding[] = [];
  const excepted: CheckResult["excepted"] = [];
  const missingLicenseText: Finding[] = [];
  const consider = (finding: Finding) => {
    if (isAllowed(finding.license, allowed)) return;
    const exception = findException(allowlist, finding);
    if (exception) {
      used.add(exception);
      excepted.push({ ...finding, reason: exception.reason });
      if (finding.kind !== "package" && !assetTexts.has(assetKey(finding.kind, finding.name))) {
        missingLicenseText.push(finding);
      }
    } else {
      violations.push(finding);
    }
  };
  const root = commonRoot(shipped.packages.map((pkg) => pkg.dir));
  for (const pkg of shipped.packages) {
    consider({
      kind: "package",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      where: root ? relative(root, pkg.dir) : pkg.dir,
    });
  }
  for (const set of shipped.bundled) {
    for (const item of set.assets) {
      consider({
        kind: item.kind,
        name: item.name,
        version: null,
        license: item.license,
        where: item.source ?? item.licenseUrl,
      });
    }
  }
  const missingFromNotice = shipped.packages.filter(
    (pkg) =>
      pkg.noticeFiles.length > 0 &&
      /\bapache-2\.0\b/i.test(pkg.license) &&
      !new RegExp(`(^|[\\s\`])${escapeRegExp(pkg.name)}([\\s\`]|$)`, "m").test(notice),
  );
  const count = (kind: BundledAsset["kind"]) =>
    shipped.bundled.filter((set) => set.kind === kind).reduce((n, s) => n + s.assets.length, 0);
  return {
    checked: {
      packages: shipped.packages.length,
      grammars: count("grammar"),
      themes: count("theme"),
    },
    violations,
    excepted,
    unusedExceptions: allowlist.exceptions.filter((entry) => !used.has(entry)),
    missingFromNotice,
    missingLicenseText,
  };
}

/** The exception for this package or asset and the license value it records, if any. */
export function findException(
  allowlist: Allowlist,
  item: { kind: LicenseException["kind"]; name: string; license: string },
): LicenseException | undefined {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return allowlist.exceptions.find(
    (entry) =>
      entry.kind === item.kind &&
      entry.name === item.name &&
      same(entry.recorded ?? entry.license, item.license),
  );
}

export function assetKey(kind: "grammar" | "theme", name: string): string {
  return `${kind}-${name}`;
}

/**
 * The license texts read upstream for grammars and themes whose collection records none,
 * from `build/asset-licenses/<kind>-<name>.txt`, keyed by `assetKey`.
 */
export function assetLicenseTexts(root: string): Map<string, string> {
  const dir = join(root, "build", "asset-licenses");
  const texts = new Map<string, string>();
  if (!existsSync(dir)) return texts;
  for (const file of readdirSync(dir).sort(compareText)) {
    if (!file.endsWith(".txt")) continue;
    texts.set(file.slice(0, -".txt".length), readFileSync(join(dir, file), "utf8").trimEnd());
  }
  return texts;
}

/** The packages folder all of `dirs` share (`<root>/node_modules`'s parent). */
function commonRoot(dirs: readonly string[]): string | null {
  const first = dirs[0];
  if (!first) return null;
  const marker = `${sep}node_modules${sep}`;
  const index = first.indexOf(marker);
  return index >= 0 ? first.slice(0, index) : null;
}

/**
 * Whether an SPDX license expression is satisfied by the allowed ids: `OR` needs one side
 * allowed, `AND` both, and `X WITH Y` only when that whole pair is on the list. Ids compare
 * without regard to case, as SPDX matches them. Anything unparseable is not allowed.
 */
export function isAllowed(expression: string, allowed: ReadonlySet<string>): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position]?.toUpperCase();
  const orExpression = (): boolean | null => {
    let value = andExpression();
    while (value !== null && peek() === "OR") {
      position++;
      const right = andExpression();
      value = right === null ? null : value || right;
    }
    return value;
  };
  const andExpression = (): boolean | null => {
    let value = term();
    while (value !== null && peek() === "AND") {
      position++;
      const right = term();
      value = right === null ? null : value && right;
    }
    return value;
  };
  const term = (): boolean | null => {
    const token = tokens[position];
    if (token === undefined || token === ")") return null;
    position++;
    if (token === "(") {
      const value = orExpression();
      if (tokens[position] !== ")") return null;
      position++;
      return value;
    }
    if (["AND", "OR", "WITH"].includes(token.toUpperCase())) return null;
    if (peek() === "WITH") {
      const exception = tokens[position + 1];
      if (exception === undefined) return null;
      position += 2;
      return allowed.has(`${token} WITH ${exception}`.toLowerCase());
    }
    return allowed.has(token.toLowerCase());
  };
  const result = orExpression();
  return result === true && position === tokens.length;
}

// ---------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A locale-independent order, so generated files do not depend on the machine. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
