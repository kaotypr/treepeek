import { isAbsolute } from "node:path";
import { GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS } from "../../shared/constants";
import { GitError } from "./errors";
import { assertAllowedSubcommand } from "./guard";
import { type ProcessOutput, runProcess } from "./process";
import { type GitPriority, GitQueue } from "./queue";
import { requireGit } from "./runtime";

/**
 * Config passed with `-c` on every call, so a repository's own config cannot run programs
 * or reach the network (git-service design, "Running git safely"). The design's five come
 * first; the last two close gaps found while building this:
 *
 * - `log.showSignature=false`: with it on, `reflog show` hands a signed commit to
 *   `gpg.program`, which repository config can name.
 * - `protocol.allow=never`: no transport is allowed, so a partial clone cannot fetch
 *   missing objects on an older Git that ignores `GIT_NO_LAZY_FETCH`.
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

/** Content-producing commands always get these right after the subcommand. */
const CONTENT_COMMANDS: ReadonlySet<string> = new Set(["diff"]);
const CONTENT_FLAGS: readonly string[] = Object.freeze([
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  // The patch parser assumes these prefixes; `diff.noprefix` or `diff.mnemonicPrefix`
  // in a user's config would change them.
  "--src-prefix=a/",
  "--dst-prefix=b/",
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

/** The queue every `runGit` call waits in. */
export function gitQueue(): GitQueue {
  return queue;
}

/**
 * The full argument list for `git <args>` in `cwd`: `-C`, the hardening config, the
 * subcommand, the pinned content flags for diff commands, then the caller's arguments.
 * Throws a `GitError` for anything the guard refuses, before any process starts. Long-lived
 * batch processes build their arguments here too.
 */
export function gitArgs(cwd: string, args: readonly string[]): string[] {
  if (!isAbsolute(cwd)) throw new GitError("internal", "git must run in an absolute folder.");
  assertAllowedSubcommand(args);
  const [subcommand = "", ...rest] = args;
  const pinned = CONTENT_COMMANDS.has(subcommand) ? CONTENT_FLAGS : [];
  return [
    "-C",
    cwd,
    ...HARDENING_CONFIG.flatMap((entry) => ["-c", entry]),
    subcommand,
    ...pinned,
    ...rest,
  ];
}

/**
 * Runs one git command, the only way the core service runs git. `args` starts with the
 * subcommand; paths go after `--`. Resolves with stdout as bytes; rejects with a
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
  return queue.run(
    () =>
      runProcess(git.path, argv, {
        env: git.env,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? GIT_MAX_OUTPUT_BYTES,
        stdin: options.stdin,
        okExitCodes: options.okExitCodes,
      }),
    options.priority ?? "normal",
    options.signal,
  );
}
