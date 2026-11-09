import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  compareGitVersions,
  formatGitVersion,
  type GitState,
  type GitVersion,
  MIN_GIT_VERSION,
} from "../../shared/domain/git";
import { gitEnvForLoginPath } from "./env";
import { runProcess } from "./process";

/** Homebrew's git on Apple Silicon, then on Intel Macs. */
export const KNOWN_GIT_LOCATIONS: readonly string[] = Object.freeze([
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
]);

/**
 * macOS's git shim. Without the Xcode Command Line Tools, running it opens an install
 * dialog, so it is run only after `xcode-select -p` names an existing folder.
 */
export const SYSTEM_GIT = "/usr/bin/git";

const XCODE_SELECT = "/usr/bin/xcode-select";
const DISCOVERY_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_BYTES = 64 * 1024;

export interface DiscoverOptions {
  /** The git binary from settings; tried first. */
  override: string | null;
  /** `PATH` from the login shell; its folders are tried next, in order. */
  loginPath: string | null;
}

/** Seams for tests; the defaults are the real macOS locations. */
export interface DiscoverDeps {
  knownLocations?: readonly string[];
  systemGit?: string;
  xcodeSelect?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** The environment the login `PATH` is merged into. Default `process.env`. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * Finds a usable git (git-service design, "Finding git"). Candidates, in order:
 *
 * 1. the override from settings;
 * 2. `git` in each folder of the login `PATH`;
 * 3. `/opt/homebrew/bin/git`, then `/usr/local/bin/git`;
 * 4. `/usr/bin/git`, only when `xcode-select -p` succeeds and names an existing folder.
 *
 * The first candidate whose `--version` runs and is at least `MIN_GIT_VERSION` wins. The
 * system git is guarded wherever it turns up, including on the `PATH` or behind a symlink,
 * and no binary runs twice.
 */
export async function discoverGit(
  options: DiscoverOptions,
  deps: DiscoverDeps = {},
): Promise<GitState> {
  const env = gitEnvForLoginPath(options.loginPath, deps.baseEnv);
  const timeoutMs = deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const systemGit = deps.systemGit ?? SYSTEM_GIT;
  const guardSystemGit = (deps.platform ?? process.platform) === "darwin";
  const systemGitReal = await realpathOrNull(systemGit);

  const candidates = [
    ...(options.override ? [options.override] : []),
    ...pathCandidates(options.loginPath),
    ...(deps.knownLocations ?? KNOWN_GIT_LOCATIONS),
    systemGit,
  ];

  const tried = new Set<string>();
  let tooOld: { path: string; version: GitVersion } | null = null;
  let toolsMissing = false;
  let toolsInstalled: boolean | undefined;

  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    const real = await realpathOrNull(candidate);
    if (real === null || tried.has(real)) continue;
    tried.add(real);
    if (!(await isExecutableFile(real))) continue;

    if (guardSystemGit && real === systemGitReal) {
      toolsInstalled ??= await hasCommandLineTools(
        deps.xcodeSelect ?? XCODE_SELECT,
        env,
        timeoutMs,
      );
      if (!toolsInstalled) {
        toolsMissing = true;
        continue;
      }
    }

    const version = await readVersion(candidate, env, timeoutMs);
    if (version === null) continue;
    if (compareGitVersions(version, MIN_GIT_VERSION) < 0) {
      tooOld ??= { path: candidate, version };
      continue;
    }
    return { found: true, path: candidate, version: formatGitVersion(version) };
  }

  if (tooOld) {
    return {
      found: false,
      problem: "tooOld",
      detail: `Git ${formatGitVersion(tooOld.version)} at ${tooOld.path} is older than ${formatGitVersion(MIN_GIT_VERSION)}, the oldest version Treepeek supports.`,
    };
  }
  if (toolsMissing) {
    return {
      found: false,
      problem: "xcodeMissing",
      detail: `${systemGit} needs the Xcode Command Line Tools, which are not installed.`,
    };
  }
  return { found: false, problem: "notFound" };
}

/**
 * Reads `git --version` output: `git version 2.39.5 (Apple Git-154)` → `[2, 39, 5]`. A
 * missing patch number counts as 0; suffixes such as `.rc1` or `.windows.1` are ignored.
 */
export function parseGitVersion(text: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/m.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function pathCandidates(loginPath: string | null): string[] {
  if (!loginPath) return [];
  return loginPath
    .split(delimiter)
    .filter((folder) => isAbsolute(folder))
    .map((folder) => join(folder, "git"));
}

async function readVersion(
  file: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<GitVersion | null> {
  try {
    const output = await runProcess(file, ["--version"], {
      env,
      timeoutMs,
      maxBytes: VERSION_OUTPUT_BYTES,
    });
    return parseGitVersion(output.stdout.toString("utf8"));
  } catch {
    return null;
  }
}

async function hasCommandLineTools(
  xcodeSelect: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  if (!isAbsolute(xcodeSelect)) return false;
  try {
    const output = await runProcess(xcodeSelect, ["-p"], {
      env,
      timeoutMs,
      maxBytes: VERSION_OUTPUT_BYTES,
    });
    const folder = output.stdout.toString("utf8").trim();
    if (!isAbsolute(folder)) return false;
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
