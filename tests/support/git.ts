/**
 * Real git repositories for tests. Each repository lives in its own temporary folder, and
 * git runs isolated from the machine's global and system config, so output does not depend
 * on who runs the tests (no colour, pager, prefix or quoting settings leak in).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  /** Real (symlink-resolved) absolute path of the repository's top level. */
  readonly path: string;
}

export interface GitOptions {
  /** Text written to git's stdin. */
  input?: string;
  /** Exit codes that count as success. Default `[0]`. */
  okExitCodes?: readonly number[];
  /** Extra environment variables for this call. */
  env?: Readonly<Record<string, string>>;
}

const created = new Set<string>();

/** The environment every test git process runs with. */
export function gitTestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Treepeek Test",
    GIT_AUTHOR_EMAIL: "test@treepeek.invalid",
    GIT_COMMITTER_NAME: "Treepeek Test",
    GIT_COMMITTER_EMAIL: "test@treepeek.invalid",
    LC_ALL: "C",
  };
}

/**
 * Creates an empty repository in a new temporary folder, on branch `main` by default.
 * Remove it with `removeTempRepos()` (for example in `afterAll`).
 */
export function makeTempRepo(options: { initialBranch?: string } = {}): TempRepo {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-test-")));
  created.add(path);
  const repo: TempRepo = { path };
  gitIn(repo, ["init", "--quiet", `--initial-branch=${options.initialBranch ?? "main"}`]);
  gitIn(repo, ["config", "commit.gpgsign", "false"]);
  gitIn(repo, ["config", "core.autocrlf", "false"]);
  return repo;
}

/**
 * Runs git in `repo` and returns its stdout. Throws, with stderr in the message, when git
 * exits with a code outside `okExitCodes`.
 */
export function gitIn(
  repo: TempRepo | string,
  args: readonly string[],
  options: GitOptions = {},
): string {
  const cwd = typeof repo === "string" ? repo : repo.path;
  const result = spawnSync("git", args, {
    cwd,
    env: { ...gitTestEnv(), ...options.env },
    ...(options.input === undefined ? {} : { input: options.input }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  const ok = options.okExitCodes ?? [0];
  if (result.status === null || !ok.includes(result.status)) {
    throw new Error(
      `git ${args.join(" ")} exited with ${result.status ?? result.signal}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Writes a file inside `repo`, creating parent folders. */
export function writeRepoFile(
  repo: TempRepo,
  relativePath: string,
  content: string | Uint8Array,
): void {
  const file = join(repo.path, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Stages everything and commits it; returns the new commit id. */
export function commitAll(repo: TempRepo, message: string): string {
  gitIn(repo, ["add", "--all"]);
  gitIn(repo, ["commit", "--quiet", "--allow-empty", "--message", message]);
  return gitIn(repo, ["rev-parse", "HEAD"]).trim();
}

/** Removes every repository `makeTempRepo` created in this process. */
export function removeTempRepos(): void {
  for (const path of created) rmSync(path, { recursive: true, force: true });
  created.clear();
}
