/**
 * The git binary Treepeek runs, as discovered by the core service and shown to every window
 * (`git.state`).
 */

/** A Git version as `[major, minor, patch]`. */
export type GitVersion = readonly [major: number, minor: number, patch: number];

/**
 * The oldest Git Treepeek runs.
 *
 * 2.36 added `-z` to `git worktree list --porcelain`, the newest flag in the command
 * catalogue, and made `core.fsmonitor` a boolean. Before 2.36, the hardening argument
 * `-c core.fsmonitor=false` would name a hook program called `false` instead of turning the
 * monitor off. `docs/platform-notes.md` lists every flag with the version that introduced it.
 */
export const MIN_GIT_VERSION: GitVersion = Object.freeze([2, 36, 0] as const);

/** Why no usable git was found. */
export const GIT_PROBLEMS = Object.freeze(["notFound", "tooOld", "xcodeMissing"] as const);

/**
 * - `notFound`: no candidate exists or runs.
 * - `tooOld`: a git runs, but it is older than `MIN_GIT_VERSION`.
 * - `xcodeMissing`: the only git is macOS's `/usr/bin/git`, which needs the Xcode Command
 *   Line Tools; without them it opens an install dialog, so it is never run.
 */
export type GitProblem = (typeof GIT_PROBLEMS)[number];

/** The result of git discovery. `version` is `major.minor.patch`. */
export type GitState =
  | { found: true; path: string; version: string }
  | { found: false; problem: GitProblem; detail?: string };

/** `[2, 36, 0]` → `"2.36.0"`. */
export function formatGitVersion(version: GitVersion): string {
  return version.join(".");
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareGitVersions(a: GitVersion, b: GitVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
