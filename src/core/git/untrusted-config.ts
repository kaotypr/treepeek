import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Lru } from "../cache/lru";
import { GitError } from "./errors";
import { type ConfigEntry, parseConfigList } from "./parse/config-list";

/**
 * Neutralises the filter drivers a repository's own config defines.
 *
 * A `filter=<name>` attribute (from a committed `.gitattributes`, or `info/attributes`)
 * makes Git pipe working-tree files through `filter.<name>.clean`, `.smudge` or `.process`
 * during `status`, `diff` against the working tree and `hash-object`. The command comes
 * from config, so a repository whose own config defines the driver could run any program
 * the moment Treepeek looks at it. The driver's name is the repository's choice, so it
 * cannot be pinned with a fixed `-c` like the other hardening options.
 *
 * Before git runs in a folder, its config is listed once with
 * `git config --show-scope --show-origin --list -z` (which runs nothing), and every
 * filter key set outside the user's own config (`system` and `global` scopes) is set again
 * with command-line priority: to the user's own value when they define the same key (Git
 * LFS keeps working), and otherwise to empty, which Git treats as "no filter".
 *
 * The overrides travel as `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
 * rather than `-c`: `-c` splits at the first `=`, and a driver name may contain one.
 *
 * The listing runs in the exact folder the call runs in, because what config applies
 * depends on it: `includeIf "onbranch:…"` follows the checkout's HEAD and
 * `includeIf "gitdir:…"` its git dir, so one linked worktree can see a driver that the main
 * checkout does not.
 */

/** One config key set with command-line priority on every git call in a folder. */
export interface ConfigOverride {
  readonly key: string;
  readonly value: string;
}

/** A filter driver key: `filter.<name>.<clean|smudge|process|required>`; `<name>` may hold dots. */
export const FILTER_KEY = /^filter\.(.*)\.(clean|smudge|process|required)$/s;

/**
 * Most filter keys one folder's config may set outside the user's own config. Past it the
 * call is refused rather than handing git an environment too large to start with.
 */
export const MAX_CONFIG_OVERRIDES = 256;

/** The scopes whose files the user controls; everything else came with the repository. */
const TRUSTED_SCOPES: ReadonlySet<string> = new Set(["system", "global"]);
/** Treepeek's own `-c` options; they define no filter. */
const OWN_SCOPES: ReadonlySet<string> = new Set(["command"]);

/**
 * The overrides that undo every filter key set outside the user's own config: each such
 * key gets the last value the user's config gives it, or an empty command (`false` for
 * `required`, so a required driver without a command does not fail the call).
 *
 * Throws a `GitError` when a name cannot be overridden exactly (not valid UTF-8) or there
 * are more than `MAX_CONFIG_OVERRIDES`: running git anyway could run the driver.
 */
export function filterDriverOverrides(entries: readonly ConfigEntry[]): ConfigOverride[] {
  const trusted = new Map<string, string>();
  const untrusted: string[] = [];
  for (const entry of entries) {
    if (!entry.key.startsWith("filter.")) continue;
    if (entry.invalidUtf8) {
      throw new GitError(
        "internal",
        "This repository's config names a filter driver that is not valid UTF-8, so Treepeek cannot switch it off and does not run Git here.",
      );
    }
    const match = FILTER_KEY.exec(entry.key);
    if (!match) continue;
    if (TRUSTED_SCOPES.has(entry.scope)) {
      // A key without a value is boolean true; only `required` can use that form.
      trusted.set(entry.key, entry.value ?? (match[2] === "required" ? "true" : ""));
    } else if (!OWN_SCOPES.has(entry.scope) && !untrusted.includes(entry.key)) {
      untrusted.push(entry.key);
    }
  }
  if (untrusted.length > MAX_CONFIG_OVERRIDES) {
    throw new GitError(
      "internal",
      `This repository's config defines more than ${MAX_CONFIG_OVERRIDES} filter driver settings, so Treepeek does not run Git here.`,
    );
  }
  return untrusted.map((key) => ({
    key,
    value: trusted.get(key) ?? (key.endsWith(".required") ? "false" : ""),
  }));
}

/** The environment variables that set `overrides` with command-line priority. */
export function configOverrideEnv(overrides: readonly ConfigOverride[]): Record<string, string> {
  if (overrides.length === 0) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(overrides.length) };
  overrides.forEach((override, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = override.key;
    env[`GIT_CONFIG_VALUE_${index}`] = override.value;
  });
  return env;
}

/** Lists the config that applies in `cwd` (`config --show-scope --show-origin --list -z`). */
export type ConfigReader = (cwd: string, signal: AbortSignal) => Promise<Uint8Array>;

export interface OverrideLookup {
  signal: AbortSignal;
  read: ConfigReader;
  /**
   * Identifies the git binary and environment the listing ran with; an entry listed under
   * another one is listed again (the user's config files can differ).
   */
  sources: object;
  /** `HOME`, for `include.path = ~/…`. */
  home: string | undefined;
  /** The user's own config files, stamped so editing them refreshes the trusted values. */
  userConfigFiles: readonly string[];
}

interface Listed {
  overrides: readonly ConfigOverride[];
  /** Files whose stamps the entry was listed under. */
  paths: readonly string[];
  stamp: string;
  /** False when the listing is used once and not kept (see `#list`). */
  cacheable: boolean;
  sources: object;
}

/** Folders whose listing is remembered. */
const MAX_FOLDERS = 1_000;

interface Pending {
  promise: Promise<Listed>;
  controller: AbortController;
  waiters: number;
}

/**
 * Each folder's overrides, listed once and kept until a file that decides them changes:
 * the `.git` file, HEAD (for `onbranch`), the ref tables, the repository's and the
 * worktree's config, the user's config files, every file the listing came from, and every
 * file an include names. Checking those is a few `stat` calls, so a folder's config is
 * listed again only when it may have changed.
 *
 * Calls in the same folder at the same time share one listing. A caller that gives up
 * while it runs is answered `cancelled` at once, unless it is the last one waiting: then
 * the listing is stopped and the caller is answered once its process is gone, as
 * `runGit` promises for its own process.
 */
export class UntrustedConfigCache {
  readonly #kept: Lru<string, Listed>;
  readonly #pending = new Map<string, Pending>();

  constructor(maxFolders = MAX_FOLDERS) {
    this.#kept = new Lru(maxFolders);
  }

  /** How many folders have a listing kept. */
  get size(): number {
    return this.#kept.size;
  }

  /** The overrides for git calls in `cwd`, listing its config when nothing current is kept. */
  async overrides(cwd: string, lookup: OverrideLookup): Promise<readonly ConfigOverride[]> {
    if (lookup.signal.aborted) throw cancelledError();
    const kept = this.#kept.get(cwd);
    if (kept) {
      if (kept.sources === lookup.sources && (await stampAll(kept.paths)) === kept.stamp) {
        return kept.overrides;
      }
      if (this.#kept.peek(cwd) === kept) this.#kept.delete(cwd);
    }
    return (await this.#shared(cwd, lookup)).overrides;
  }

  clear(): void {
    this.#kept.clear();
  }

  #shared(cwd: string, lookup: OverrideLookup): Promise<Listed> {
    let pending = this.#pending.get(cwd);
    // A listing every caller gave up on is being stopped; it cannot serve a new one.
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = this.#list(cwd, lookup, controller.signal);
      const started: Pending = { promise, controller, waiters: 0 };
      this.#pending.set(cwd, started);
      promise.then(
        (listed) => {
          if (this.#pending.get(cwd) !== started) return;
          this.#pending.delete(cwd);
          if (listed.cacheable) this.#kept.set(cwd, listed);
        },
        () => {
          if (this.#pending.get(cwd) === started) this.#pending.delete(cwd);
        },
      );
      pending = started;
    }
    return wait(pending, lookup.signal);
  }

  /**
   * Lists the config and works out what it depends on. The fixed files are stamped before
   * the listing, so a change while it runs is seen next time; files learned from the
   * listing (origins, include targets) can only be stamped after it.
   *
   * A listing is used once and not kept when the folder is not a checkout or git dir, when
   * it has no `local` entry (Git did not read the repository's config, as when it refuses
   * the folder for `safe.directory`), or when an include names a path this cannot follow.
   */
  async #list(cwd: string, lookup: OverrideLookup, signal: AbortSignal): Promise<Listed> {
    const located = await locate(cwd);
    const fixed = [...(located ? dependencies(located) : []), ...lookup.userConfigFiles];
    const before = await stampAll(fixed);
    const entries = parseConfigList(await lookup.read(cwd, signal));
    const overrides = filterDriverOverrides(entries);
    const learned = learnedPaths(entries, cwd, lookup.home);
    const extra = learned.paths.filter((path) => !fixed.includes(path));
    const after = await stampAll(extra);
    return {
      overrides,
      paths: [...fixed, ...extra],
      stamp: extra.length === 0 ? before : `${before}|${after}`,
      cacheable:
        located !== null && learned.complete && entries.some((entry) => entry.scope === "local"),
      sources: lookup.sources,
    };
  }
}

/** Waits for a shared listing on behalf of one caller (see `UntrustedConfigCache`). */
function wait(pending: Pending, signal: AbortSignal): Promise<Listed> {
  pending.waiters += 1;
  return new Promise<Listed>((resolve, reject) => {
    let waiting = true;
    const done = (): boolean => {
      if (!waiting) return false;
      waiting = false;
      pending.waiters -= 1;
      signal.removeEventListener("abort", onAbort);
      return true;
    };
    const onAbort = () => {
      if (!done()) return;
      if (pending.waiters > 0) {
        reject(cancelledError());
        return;
      }
      pending.controller.abort();
      pending.promise.then(
        () => reject(cancelledError()),
        () => reject(cancelledError()),
      );
    };
    pending.promise.then(
      (listed) => {
        if (done()) resolve(listed);
      },
      (error: unknown) => {
        if (done()) reject(error);
      },
    );
    // The caller may have given up while its stamps were being checked.
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelledError(): GitError {
  return new GitError("cancelled", "The Git command was cancelled.");
}

interface Located {
  /** `<cwd>/.git` when it is a file (a linked worktree's pointer), else `null`. */
  gitFile: string | null;
  gitDir: string;
  commonDir: string;
}

/**
 * The git dir and common dir behind `cwd`, read from the filesystem as Git does: `.git`
 * is a folder, or a file saying `gitdir: <path>`; a folder with `HEAD` is a git dir itself
 * (a bare repository or a common dir). `null` for anything else.
 */
async function locate(cwd: string): Promise<Located | null> {
  const marker = join(cwd, ".git");
  let gitDir: string;
  let gitFile: string | null = null;
  const info = await stat(marker).catch(() => null);
  if (info?.isDirectory()) {
    gitDir = marker;
  } else if (info?.isFile()) {
    const text = await readFile(marker, "utf8").catch(() => "");
    const match = /^gitdir: (.+?)\s*$/m.exec(text);
    if (!match?.[1]) return null;
    gitDir = resolve(cwd, match[1]);
    gitFile = marker;
  } else if ((await stat(join(cwd, "HEAD")).catch(() => null))?.isFile()) {
    gitDir = cwd;
  } else {
    return null;
  }
  const pointer = await readFile(join(gitDir, "commondir"), "utf8").catch(() => null);
  const commonDir = pointer === null ? gitDir : resolve(gitDir, pointer.trim());
  return { gitFile, gitDir, commonDir };
}

/** The files that decide a folder's config, whatever the listing says. */
function dependencies(located: Located): string[] {
  const { gitDir, commonDir } = located;
  return [
    ...(located.gitFile ? [located.gitFile] : []),
    join(gitDir, "HEAD"),
    // With the reftable backend HEAD is a stub and branches live in the tables.
    join(gitDir, "reftable", "tables.list"),
    join(gitDir, "commondir"),
    join(gitDir, "config.worktree"),
    join(commonDir, "config"),
    join(commonDir, "reftable", "tables.list"),
  ];
}

/**
 * The files the listing came from, and the files its includes name (which may not exist
 * yet). `complete` is false when an include names a path this cannot resolve.
 */
function learnedPaths(
  entries: readonly ConfigEntry[],
  cwd: string,
  home: string | undefined,
): { paths: string[]; complete: boolean } {
  const paths = new Set<string>();
  let complete = true;
  for (const entry of entries) {
    const origin = originFile(entry.origin, cwd);
    if (origin) paths.add(origin);
    if (entry.key === "include.path" || /^includeif\..*\.path$/s.test(entry.key)) {
      const target = includeTarget(entry.value, origin, home);
      if (target) paths.add(target);
      else complete = false;
    }
  }
  return { paths: [...paths], complete };
}

function originFile(origin: string, cwd: string): string | null {
  return origin.startsWith("file:") && origin.length > 5 ? resolve(cwd, origin.slice(5)) : null;
}

/** Where an include points, resolved as Git does; `null` when it cannot be told. */
function includeTarget(
  value: string | null,
  origin: string | null,
  home: string | undefined,
): string | null {
  if (!value) return null;
  if (value.startsWith("~/")) return home && isAbsolute(home) ? join(home, value.slice(2)) : null;
  // `~user/…` and `%(prefix)/…` name folders this cannot find.
  if (value.startsWith("~") || value.startsWith("%(")) return null;
  if (isAbsolute(value)) return value;
  return origin ? resolve(dirname(origin), value) : null;
}

/**
 * Inode, size and mtime of each file, or `-` for a missing one. A folder counts by inode
 * only, and a device (`/dev/null` as a config file) by its type: their mtimes change
 * without their meaning changing.
 */
async function stampAll(paths: readonly string[]): Promise<string> {
  const stamps = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path, { bigint: true });
        if (info.isFile()) return `${info.ino}:${info.size}:${info.mtimeNs}`;
        if (info.isDirectory()) return `d${info.ino}`;
        return "o";
      } catch {
        return "-";
      }
    }),
  );
  return stamps.join("|");
}

/**
 * The user's own config files from the git environment, so editing one is noticed even
 * when it had no entries yet. The system file's place is Git's build prefix, which only
 * the listing's origins reveal.
 */
export function userConfigFiles(env: Readonly<Record<string, string | undefined>>): string[] {
  const files: string[] = [];
  const global = env.GIT_CONFIG_GLOBAL;
  if (global !== undefined) {
    if (global !== "") files.push(global);
  } else {
    const home = env.HOME;
    const xdg = env.XDG_CONFIG_HOME || (home ? join(home, ".config") : undefined);
    if (xdg) files.push(join(xdg, "git", "config"));
    if (home) files.push(join(home, ".gitconfig"));
  }
  if (env.GIT_CONFIG_SYSTEM) files.push(env.GIT_CONFIG_SYSTEM);
  return files.filter((file) => isAbsolute(file));
}
