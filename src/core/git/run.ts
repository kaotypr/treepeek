import { isAbsolute } from "node:path";
import { GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS } from "../../shared/constants";
import { GitError } from "./errors";
import { assertAllowedSubcommand } from "./guard";
import { type ProcessOutput, runProcess } from "./process";
import { type GitPriority, GitQueue } from "./queue";
import { type GitBinary, requireGit } from "./runtime";
import { configOverrideEnv, UntrustedConfigCache, userConfigFiles } from "./untrusted-config";

/**
 * Config passed with `-c` on every call, so a repository's own config cannot run programs
 * or reach the network (git-service design, "Running git safely"). The design's five come
 * first; the last two close gaps found while building this:
 *
 * - `log.showSignature=false`: with it on, `reflog show` hands a signed commit to
 *   `gpg.program`, which repository config can name.
 * - `protocol.allow=never`: no transport is allowed, so a partial clone cannot fetch
 *   missing objects on an older Git that ignores `GIT_NO_LAZY_FETCH`.
 *
 * Filter drivers are named by the repository, so they are switched off per folder instead
 * (`repositoryEnv`, `untrusted-config.ts`).
 */
export const HARDENING_CONFIG: readonly string[] = Object.freeze([
  "core.fsmonitor=false",
  "core.pager=cat",
  "color.ui=false",
  "diff.external=",
  "core.quotePath=false",
  "log.showSignature=false",
  "protocol.allow=never",
]);

/**
 * Never look inside a submodule's working tree. To tell whether a submodule has changes of
 * its own, Git runs `git status` inside it, and that reads the submodule's own config,
 * filter drivers included, which the overrides for the outer repository do not cover. With
 * `dirty` ignored, a submodule shows only as its gitlink changing (domain model,
 * "Out of scope"). On the command line it also wins over `submodule.<name>.ignore` and
 * `diff.ignoreSubmodules` in the repository's config.
 */
const IGNORE_SUBMODULE_TREES = "--ignore-submodules=dirty";

/** Flags every call of a subcommand gets right after the subcommand. */
const PINNED_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "diff",
    Object.freeze([
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      // The patch parser assumes these prefixes; `diff.noprefix` or `diff.mnemonicPrefix`
      // in a user's config would change them.
      "--src-prefix=a/",
      "--dst-prefix=b/",
      IGNORE_SUBMODULE_TREES,
      // `diff.submodule=diff` would run `git diff` inside the submodule for a patch.
      "--submodule=short",
    ]),
  ],
  ["status", Object.freeze([IGNORE_SUBMODULE_TREES])],
]);

/** The read-only config listing the overrides come from (`untrusted-config.ts`). */
const CONFIG_LIST_ARGS: readonly string[] = Object.freeze([
  "config",
  "--show-scope",
  "--show-origin",
  "--list",
  "-z",
]);

export interface RunGitOptions {
  /** Aborting kills the process, or removes the call from the queue if it has not started. */
  signal: AbortSignal;
  /** Default `GIT_TIMEOUT_MS`; scans pass `GIT_SCAN_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Default `GIT_MAX_OUTPUT_BYTES`; diffs pass the diff-pipeline caps. */
  maxBytes?: number;
  /** Queue lane. Default `normal`. */
  priority?: GitPriority;
  /** Written to git's stdin, which is then closed. */
  stdin?: string | Uint8Array;
  /** Exit codes that count as success. Default `[0]`. */
  okExitCodes?: readonly number[];
}

export type GitOutput = ProcessOutput;

const queue = new GitQueue();
const untrustedConfig = new UntrustedConfigCache();

/** The queue every `runGit` call waits in. */
export function gitQueue(): GitQueue {
  return queue;
}

/**
 * The full argument list for `git <args>` in `cwd`: `-C`, the hardening config, the
 * subcommand, its pinned flags (`PINNED_FLAGS`), then the caller's arguments. Throws a
 * `GitError` for anything the guard refuses, before any process starts. Long-lived batch
 * processes build their arguments here too.
 */
export function gitArgs(cwd: string, args: readonly string[]): string[] {
  if (!isAbsolute(cwd)) throw new GitError("internal", "git must run in an absolute folder.");
  assertAllowedSubcommand(args);
  const [subcommand = "", ...rest] = args;
  const pinned = PINNED_FLAGS.get(subcommand) ?? [];
  return [
    "-C",
    cwd,
    ...HARDENING_CONFIG.flatMap((entry) => ["-c", entry]),
    subcommand,
    ...pinned,
    ...rest,
  ];
}

export interface ConfigEnvOptions {
  signal: AbortSignal;
  /** Time limit for listing the config. Default `GIT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Queue lane for listing the config. Default `normal`. */
  priority?: GitPriority;
}

/**
 * The environment git needs in `cwd` on top of `git.env`: the overrides that switch off
 * every filter driver the repository's own config defines (`untrusted-config.ts`). Lists
 * the folder's config first when nothing current is kept, in its own queue slot, so call
 * it before taking one. Rejects like `runGit`; a call must not run without it.
 */
export async function repositoryEnv(
  cwd: string,
  git: GitBinary,
  options: ConfigEnvOptions,
): Promise<NodeJS.ProcessEnv> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const priority = options.priority ?? "normal";
  const overrides = await untrustedConfig.overrides(cwd, {
    signal: options.signal,
    sources: git.env,
    home: git.env.HOME,
    userConfigFiles: userConfigFiles(git.env),
    read: async (folder, signal) => {
      const argv = gitArgs(folder, CONFIG_LIST_ARGS);
      const output = await queue.run(
        () =>
          runProcess(git.path, argv, {
            env: git.env,
            signal,
            timeoutMs,
            maxBytes: GIT_MAX_OUTPUT_BYTES,
          }),
        priority,
        signal,
      );
      return output.stdout;
    },
  });
  return overrides.length === 0 ? git.env : { ...git.env, ...configOverrideEnv(overrides) };
}

/**
 * Runs one git command, the only way the core service runs git. `args` starts with the
 * subcommand; paths go after `--`. Every call carries the overrides for the folder's own
 * filter drivers (`repositoryEnv`). Resolves with stdout as bytes; rejects with a
 * `GitError` (refused command, git missing, timeout, output too large, cancelled, or a
 * failing exit code mapped from stderr).
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions,
): Promise<GitOutput> {
  const argv = gitArgs(cwd, args);
  if (options.signal.aborted) throw new GitError("cancelled", "The Git command was cancelled.");
  const git = await requireGit();
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const priority = options.priority ?? "normal";
  const env = await repositoryEnv(cwd, git, { signal: options.signal, timeoutMs, priority });
  return queue.run(
    () =>
      runProcess(git.path, argv, {
        env,
        signal: options.signal,
        timeoutMs,
        maxBytes: options.maxBytes ?? GIT_MAX_OUTPUT_BYTES,
        stdin: options.stdin,
        okExitCodes: options.okExitCodes,
      }),
    priority,
    options.signal,
  );
}
