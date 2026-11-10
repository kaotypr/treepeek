import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DetectedApp } from "../../shared/ipc/contract";

/** An app Treepeek knows how to open things in. */
export interface KnownApp {
  /** Shown in Settings; a family's members show their own `.app` name instead. */
  name: string;
  /**
   * The bundle identifier, or a family prefix ending in `.*` (`com.jetbrains.*`), whose
   * every installed member is listed on its own.
   */
  bundleId: string;
  /** `.app` names looked for in the Applications folders when Spotlight finds nothing. */
  appNames: readonly string[];
  /** The editor can open a file at a line (see `editors.ts`). */
  opensAtLine?: boolean;
}

/** What detection needs from the system; tests replace it. */
export interface DetectDeps {
  /** Paths `mdfind` answers for a Spotlight query; empty when Spotlight is off. */
  mdfind(query: string): Promise<string[]>;
  /** An app bundle's `CFBundleIdentifier`, read from its `Info.plist`. */
  bundleIdOf(appPath: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Folders looked in when Spotlight finds nothing, most preferred first. */
  applicationDirs: readonly string[];
}

const RUN_TIMEOUT_MS = 5_000;

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
}

/** The real system: Spotlight, `plutil`, and the three Applications folders. */
export function systemDetectDeps(): DetectDeps {
  return {
    mdfind: async (query) =>
      (await run("/usr/bin/mdfind", [query]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".app")),
    bundleIdOf: async (appPath) => {
      const id = (
        await run("/usr/bin/plutil", [
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          join(appPath, "Contents", "Info.plist"),
        ])
      ).trim();
      return id === "" ? null : id;
    },
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    applicationDirs: ["/Applications", "/System/Applications", join(homedir(), "Applications")],
  };
}

/**
 * Which of `known` are installed, in the order of `known`. Each app is looked up by bundle
 * identifier with Spotlight (`kMDItemCFBundleIdentifier == '<id>'`); when Spotlight finds
 * nothing (it may be switched off), the Applications folders are checked for the app's
 * usual `.app` names. A family lists every member found. When an app is installed more
 * than once, the copy in an Applications folder wins.
 */
export async function detectApps(
  known: readonly KnownApp[],
  deps: DetectDeps,
): Promise<DetectedApp[]> {
  const found = await Promise.all(known.map((app) => detectOne(app, deps)));
  const seen = new Set<string>();
  const result: DetectedApp[] = [];
  for (const app of found.flat()) {
    if (seen.has(app.bundleId)) continue;
    seen.add(app.bundleId);
    result.push(app);
  }
  return result;
}

async function detectOne(app: KnownApp, deps: DetectDeps): Promise<DetectedApp[]> {
  const family = app.bundleId.endsWith(".*") ? app.bundleId.slice(0, -1) : null;
  const query = `kMDItemCFBundleIdentifier == '${family ? `${family}*` : app.bundleId}'`;
  let paths = (await deps.mdfind(query)).filter(usable);
  if (paths.length === 0) paths = await fallbackPaths(app, deps);

  const byId = new Map<string, string[]>();
  for (const path of paths) {
    // Spotlight answered for this exact id; a family's members each carry their own.
    const id = family ? await deps.bundleIdOf(path) : app.bundleId;
    if (id === null) continue;
    if (family ? !id.startsWith(family) : id !== app.bundleId) continue;
    byId.set(id, [...(byId.get(id) ?? []), path]);
  }

  const detected: DetectedApp[] = [];
  for (const [bundleId, candidates] of byId) {
    const path = preferred(candidates, deps.applicationDirs);
    detected.push({
      bundleId,
      name: family ? basename(path, ".app") : app.name,
      path,
      opensAtLine: app.opensAtLine === true,
    });
  }
  return detected.sort((a, b) => a.name.localeCompare(b.name));
}

/** The `.app` names in the Applications folders; checked against the bundle id. */
async function fallbackPaths(app: KnownApp, deps: DetectDeps): Promise<string[]> {
  const family = app.bundleId.endsWith(".*") ? app.bundleId.slice(0, -1) : null;
  const paths: string[] = [];
  for (const dir of deps.applicationDirs) {
    for (const name of app.appNames) {
      const path = join(dir, name);
      if (!(await deps.exists(path))) continue;
      const id = await deps.bundleIdOf(path);
      if (id !== null && (family ? id.startsWith(family) : id === app.bundleId)) paths.push(path);
    }
  }
  return paths;
}

/** Not in the Trash, and an app bundle. */
function usable(path: string): boolean {
  return path.endsWith(".app") && !path.includes("/.Trash/");
}

function preferred(paths: readonly string[], dirs: readonly string[]): string {
  for (const dir of dirs) {
    const inDir = paths.find((path) => path.startsWith(`${dir}/`));
    if (inDir) return inDir;
  }
  return paths[0] as string;
}
