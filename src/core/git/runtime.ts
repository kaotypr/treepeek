import type { GitState } from "../../shared/domain/git";
import { type DiscoverOptions, discoverGit } from "./discover";
import { gitEnvForLoginPath } from "./env";
import { GitError } from "./errors";

/** The git every call runs, with its environment. */
export interface GitBinary {
  path: string;
  version: string;
  env: NodeJS.ProcessEnv;
}

let state: GitState | null = null;
let env: NodeJS.ProcessEnv | null = null;
let pending: Promise<unknown> | null = null;
let generation = 0;

/**
 * Runs discovery and makes its result the git every later call uses. Calls made while it
 * runs wait for it. When a newer discovery starts before this one finishes (the setting
 * changed again), this one's result is dropped and it resolves `undefined`.
 */
export async function rediscoverGit(
  options: DiscoverOptions,
  discover: (options: DiscoverOptions) => Promise<GitState> = discoverGit,
): Promise<GitState | undefined> {
  generation += 1;
  const mine = generation;
  const run = discover(options).catch(
    (error: unknown): GitState => ({
      found: false,
      problem: "notFound",
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
  pending = run;
  const next = await run;
  if (mine !== generation) return undefined;
  state = next;
  env = gitEnvForLoginPath(options.loginPath);
  pending = null;
  return next;
}

/** Sets the git directly, skipping discovery (tests, and tools that already know it). */
export function setGitBinary(next: GitState, nextEnv: NodeJS.ProcessEnv): void {
  generation += 1;
  state = next;
  env = nextEnv;
  pending = null;
}

/** Forgets the git, as before the first discovery. */
export function resetGitRuntime(): void {
  generation += 1;
  state = null;
  env = null;
  pending = null;
}

/** The latest discovery result, or `null` before the first one finishes. */
export function currentGitState(): GitState | null {
  return state;
}

/**
 * The git to run, after any discovery in progress. Fails with `gitNotFound` or
 * `gitTooOld` when there is none, so a handler can show the setup screen.
 */
export async function requireGit(): Promise<GitBinary> {
  while (pending) {
    const waitingFor = pending;
    await waitingFor;
    if (pending === waitingFor) break;
  }
  if (state === null || env === null) {
    throw new GitError("gitNotFound", "Git has not been found yet.");
  }
  if (!state.found) {
    const code = state.problem === "tooOld" ? "gitTooOld" : "gitNotFound";
    throw new GitError(code, state.detail ?? "No usable Git was found.");
  }
  return { path: state.path, version: state.version, env };
}
