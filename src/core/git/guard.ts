import { GitError } from "./errors";

/**
 * Commands Treepeek never runs, because they write to a repository or touch the network
 * (git-service command catalogue, "Never used"). Two-word entries name a subcommand and
 * its verb or flag.
 */
export const FORBIDDEN: readonly string[] = Object.freeze([
  "fetch",
  "pull",
  "push",
  "checkout",
  "switch",
  "reset",
  "stash",
  "commit",
  "gc",
  "worktree add",
  "worktree remove",
  "worktree prune",
  "hash-object -w",
  "update-index",
  "update-ref",
]);

/** Returns why the arguments are refused, or `null`. */
type ArgumentCheck = (rest: readonly string[]) => string | null;

/**
 * The subcommands in the command catalogue, each with a check on its remaining arguments.
 * Anything not listed is refused too, so a new command is added here on purpose, with a
 * test, rather than slipping through a list of what is forbidden.
 */
const ALLOWED: ReadonlyMap<string, ArgumentCheck> = new Map<string, ArgumentCheck>([
  ["rev-parse", () => null],
  ["status", () => null],
  ["merge-base", () => null],
  ["rev-list", () => null],
  ["diff", () => null],
  ["ls-files", () => null],
  ["cat-file", () => null],
  ["hash-object", (rest) => (hasOption(rest, "-w") ? "hash-object -w writes objects" : null)],
  ["worktree", (rest) => (rest[0] === "list" ? null : "only `worktree list` is read-only")],
  ["remote", (rest) => (rest[0] === "get-url" ? null : "only `remote get-url` is read-only")],
  ["reflog", (rest) => (rest[0] === "show" ? null : "only `reflog show` is read-only")],
  ["config", checkConfigListing],
]);

/** The only flags `config` may take: together they list config and change nothing. */
const CONFIG_LISTING_FLAGS: ReadonlySet<string> = new Set([
  "--list",
  "-l",
  "--show-scope",
  "--show-origin",
  "--includes",
  "-z",
  "--null",
]);

/**
 * `git config` writes with a key and value, `--add`, `--unset`, `--edit` and more, so only
 * the listing (`--list` plus display flags, no other argument) is allowed.
 */
function checkConfigListing(rest: readonly string[]): string | null {
  if (!rest.includes("--list") && !rest.includes("-l")) return "only `config --list` is read-only";
  const other = rest.find((arg) => !CONFIG_LISTING_FLAGS.has(arg));
  return other === undefined ? null : `\`config --list\` does not take ${JSON.stringify(other)}`;
}

/**
 * Options refused before `--` on every command: they write files (`--output`), run
 * programs (`--ext-diff`, `--textconv`, `--filters`, `--show-signature`), reach into
 * submodules (whose own config could run programs), or undo what `runGit` pins (colour,
 * diff prefixes, submodule handling). `runGit` adds the safe forms itself; a caller's
 * later flag would override them.
 */
const REFUSED_OPTIONS: readonly RegExp[] = [
  /^--output(=|$)/,
  /^--ext-diff$/,
  /^--textconv$/,
  /^--filters$/,
  /^--show-signature$/,
  /^--color(=|$)/,
  /^--no-prefix$/,
  /^--default-prefix$/,
  /^--src-prefix(=|$)/,
  /^--dst-prefix(=|$)/,
  /^--ignore-submodules(=|$)/,
  /^--submodule(=|$)/,
  /^--recurse-submodules(=|$)/,
];

const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

/**
 * Throws unless `args` is a read-only command from the catalogue. `args` starts with the
 * subcommand: global options are `runGit`'s alone, because a caller's `-c` would come
 * after the hardening options and override them.
 */
export function assertAllowedSubcommand(args: readonly string[]): void {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !SUBCOMMAND.test(subcommand)) {
    throw refuse(`it must start with a subcommand, not ${JSON.stringify(subcommand ?? "")}`);
  }
  const verb = rest[0];
  if (
    FORBIDDEN.includes(subcommand) ||
    (verb !== undefined && FORBIDDEN.includes(`${subcommand} ${verb}`)) ||
    (subcommand === "hash-object" && hasOption(rest, "-w"))
  ) {
    throw refuse(`\`${subcommand}\` writes to the repository or uses the network`);
  }
  const check = ALLOWED.get(subcommand);
  if (!check) throw refuse(`\`${subcommand}\` is not in the command catalogue`);
  const problem = check(rest);
  if (problem) throw refuse(problem);
  for (const option of optionsOf(rest)) {
    if (REFUSED_OPTIONS.some((pattern) => pattern.test(option))) {
      throw refuse(`the option ${option} is not allowed`);
    }
  }
}

/** The arguments before `--` or `--end-of-options`; what follows is never an option. */
function optionsOf(rest: readonly string[]): string[] {
  const options: string[] = [];
  for (const arg of rest) {
    if (arg === "--" || arg === "--end-of-options") break;
    options.push(arg);
  }
  return options;
}

function hasOption(rest: readonly string[], flag: string): boolean {
  // `-w` may hide in a bundle of short flags (`-tw`), so check each letter.
  const letter = flag.slice(1);
  return optionsOf(rest).some(
    (arg) => arg === flag || (/^-[a-zA-Z]+$/.test(arg) && arg.includes(letter)),
  );
}

function refuse(reason: string): GitError {
  return new GitError("internal", `Refused to run git: ${reason}.`);
}
