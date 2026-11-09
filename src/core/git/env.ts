/**
 * Variables set on every git process (git-service design, "Running git safely"), plus two
 * that the design's table does not name:
 *
 * - `GIT_LITERAL_PATHSPECS=1`: paths after `--` are file names, never globs or `:(magic)`,
 *   so a file called `*.ts` or `:(exclude)x` names only itself.
 * - `GIT_NO_LAZY_FETCH=1`: a partial clone never fetches missing objects (Git 2.45 and
 *   later; older Git ignores it, and `protocol.allow=never` in the fixed arguments still
 *   refuses the transport).
 */
export const GIT_ENV_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  /** Never take the index lock (status would otherwise refresh and write the index). */
  GIT_OPTIONAL_LOCKS: "0",
  /** Never prompt. */
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  /** Nothing to ask for; no network is used. */
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  /** Stable English messages, so `errors.ts` can recognise them. */
  LC_ALL: "C",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_NO_LAZY_FETCH: "1",
});

/**
 * The only `GIT_*` variables kept from the login environment. They choose which user and
 * system config Git reads, which is where `safe.directory` lives, so they stay honoured.
 * Every other `GIT_*` variable (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS`, `GIT_TRACE*` and so on) would point git at
 * another repository, run a program, write a file or change results, so it is dropped.
 */
const KEPT_GIT_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
]);

/** The environment for git processes: the login environment with the table applied. */
export function gitEnv(loginEnv: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(loginEnv)) {
    if (value === undefined) continue;
    if (name.startsWith("GIT_") && !KEPT_GIT_VARIABLES.has(name)) continue;
    env[name] = value;
  }
  return Object.assign(env, GIT_ENV_OVERRIDES);
}

/**
 * The git environment for this process, with `PATH` replaced by the login shell's when main
 * could read it (an app started from Finder inherits launchd's short `PATH`).
 */
export function gitEnvForLoginPath(
  loginPath: string | null,
  base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return gitEnv(loginPath ? { ...base, PATH: loginPath } : base);
}
