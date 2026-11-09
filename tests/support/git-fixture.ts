/**
 * Builds scan folders full of real repositories for core-service tests: main checkouts,
 * linked worktrees, bare repositories, stale `.git` files, expired reflogs and booby-trapped
 * config.
 *
 * ```ts
 * const fx = fixture();
 * const app = fx.repo("app").commit({ "README.md": "hello\n" });
 * const feature = app.worktree("app-feature", { from: "main" });
 * feature.commit({ "src/a.ts": "export {};\n" });
 * fx.repo("svc").commit({ "x.txt": "x\n" }).bare().worktree("svc-main", { from: "main" });
 * // ...scan fx.root...
 * fx.cleanup();
 * ```
 *
 * A fake clock dates every commit and reflog entry: each change is recorded `stepSeconds`
 * after the previous one, so the timeline order is the order the test built things in.
 * The clock starts in the past, so `expireReflog()` (`--expire=now`) expires everything.
 *
 * The fixture's own git calls carry hardening options, so they never set off a trap that
 * `maliciousConfig` arms, whenever it is called.
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gitIn } from "./git";

/** A file's content, `null` to delete it, or a file with a mode or a symlink. */
export type FileSpec =
  | string
  | Uint8Array
  | null
  | { content: string | Uint8Array; executable?: boolean }
  | { symlink: string };

export type Files = Readonly<Record<string, FileSpec>>;

/**
 * Ways a repository's own config can try to run a program.
 *
 * - `fsmonitor`: `core.fsmonitor` names the script (status, diff against the working tree).
 * - `diffExternal`: `diff.external` names it (any patch).
 * - `textconv`: a `diff=evil` attribute with `diff.evil.textconv` (any patch).
 * - `diffCommand`: the same driver's `diff.evil.command` (any patch).
 * - `pager`: `core.pager` names it.
 * - `showSignature`: `log.showSignature` with `gpg.program`; fires on a signed commit
 *   (`signedCommit()`) when the reflog or log is read.
 * - `filter`: a `filter=evil` attribute with `filter.evil.clean`/`smudge` (status, diff and
 *   `hash-object` read working-tree files through it). Not in the default set: the design's
 *   hardening does not cover it yet.
 */
export type MaliciousVector =
  | "fsmonitor"
  | "diffExternal"
  | "textconv"
  | "diffCommand"
  | "pager"
  | "showSignature"
  | "filter";

export const DEFAULT_MALICIOUS_VECTORS: readonly MaliciousVector[] = Object.freeze([
  "fsmonitor",
  "diffExternal",
  "textconv",
  "diffCommand",
  "pager",
  "showSignature",
]);

/** The attribute driver name the traps use. */
const DRIVER = "evil";

/** Options on every fixture git call, so building a fixture never fires its own traps. */
const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "log.showSignature=false",
  `filter.${DRIVER}.clean=`,
  `filter.${DRIVER}.smudge=`,
  `filter.${DRIVER}.process=`,
  "commit.gpgsign=false",
].flatMap((entry) => ["-c", entry]);

export interface FixtureGitOptions {
  /** The command writes a commit or a reflog entry: move the clock on afterwards. */
  records?: boolean;
  /** Text written to git's stdin. */
  input?: string;
  /** Exit codes that count as success. Default `[0]`. */
  okExitCodes?: readonly number[];
}

export interface FixtureOptions {
  /** When the first change is recorded. Default 2025-01-01T00:00:00Z. */
  start?: string;
  /** Seconds between recorded changes. Default 60. */
  stepSeconds?: number;
}

export interface WorktreeOptions {
  /** The commit-ish the worktree starts from: a branch, a tag or a commit id. */
  from: string;
  /** The new branch's name. Default: the folder's name, made safe for a ref. */
  branch?: string;
  /** Check `from` out detached instead of creating a branch. */
  detach?: boolean;
}

export interface StaleGitFileOptions {
  /**
   * - `dangling` (default): a worktree whose admin folder was deleted, so `.git` points at
   *   nothing and `rev-parse` fails.
   * - `copied`: a copy of another worktree's `.git` file, so `rev-parse` succeeds but Git's
   *   worktree list does not include the folder.
   */
  kind?: "dangling" | "copied";
}

const fixtures = new Set<string>();

/** Starts a fixture in a new temporary folder (a real path). */
export function fixture(options: FixtureOptions = {}): Fixture {
  return new Fixture(options);
}

/** Removes every fixture folder this process created. */
export function removeFixtures(): void {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
  fixtures.clear();
}

export class Fixture {
  /** The scan root: a real (symlink-resolved) absolute path. */
  readonly root: string;
  /**
   * A second temporary folder beside the root, for things a scan must not find: trap
   * scripts, the originals of copied worktrees, symlink targets outside every checkout.
   */
  readonly outside: string;
  readonly #step: number;
  #time: number;
  #scripts = 0;

  constructor(options: FixtureOptions = {}) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-fixture-")));
    this.outside = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-fixture-outside-")));
    fixtures.add(this.root);
    fixtures.add(this.outside);
    this.#time = Math.floor(Date.parse(options.start ?? "2025-01-01T00:00:00Z") / 1000);
    this.#step = options.stepSeconds ?? 60;
  }

  /** Creates a repository with an empty main checkout at `<root>/<name>`, on `main`. */
  repo(name: string, options: { branch?: string } = {}): FixtureRepo {
    return new FixtureRepo(this, name, options.branch ?? "main");
  }

  /** The absolute path of `relative` under the root. */
  path(relative: string): string {
    return join(this.root, relative);
  }

  /** The absolute path of `relative` under `outside`. */
  outsidePath(relative: string): string {
    return join(this.outside, relative);
  }

  /** The time the next change will be recorded at, as ISO 8601 UTC. */
  now(): string {
    return new Date(this.#time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** Moves the clock forward by `seconds` (on top of the usual step). */
  advance(seconds: number): this {
    this.#time += seconds;
    return this;
  }

  /** Removes the fixture's folder. */
  cleanup(): void {
    for (const folder of [this.root, this.outside]) {
      rmSync(folder, { recursive: true, force: true });
      fixtures.delete(folder);
    }
  }

  /** Runs git in `cwd` with the fixture's clock; advances the clock when `records` is set. */
  git(cwd: string, args: readonly string[], options: FixtureGitOptions = {}): string {
    const date = `@${this.#time} +0000`;
    const output = gitIn(cwd, [...SAFE_CONFIG, ...args], {
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.okExitCodes === undefined ? {} : { okExitCodes: options.okExitCodes }),
    });
    if (options.records) this.#time += this.#step;
    return output;
  }

  /** Writes an executable script (outside the root) that appends a line to `markerPath`. */
  trapScript(markerPath: string): string {
    this.#scripts += 1;
    const script = this.outsidePath(`scripts/trap-${this.#scripts}.sh`);
    mkdirSync(dirname(script), { recursive: true });
    const quoted = `'${markerPath.replaceAll("'", "'\\''")}'`;
    // `cat` passes stdin through, so a filter or pager still produces output.
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${quoted}\ncat\nexit 0\n`, {
      mode: 0o755,
    });
    return script;
  }
}

/** A working tree in a fixture: a main checkout or a linked worktree. */
export class FixtureCheckout {
  readonly fixture: Fixture;
  readonly #path: string;
  #commits = 0;

  constructor(fixture: Fixture, path: string) {
    this.fixture = fixture;
    this.#path = path;
  }

  /** The checkout's absolute (real) path. */
  get path(): string {
    return this.#path;
  }

  /** Runs git in this checkout. */
  git(args: readonly string[], options: FixtureGitOptions = {}): string {
    return this.fixture.git(this.path, args, options);
  }

  /** Changes files on disk only: `null` deletes, `{executable}` sets the mode, `{symlink}` links. */
  write(files: Files): this {
    for (const [relative, spec] of Object.entries(files)) {
      const file = join(this.path, relative);
      if (spec === null) {
        rmSync(file, { force: true, recursive: true });
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      if (typeof spec === "string" || spec instanceof Uint8Array) {
        rmSync(file, { force: true });
        writeFileSync(file, spec);
      } else if ("symlink" in spec) {
        rmSync(file, { force: true });
        symlinkSync(spec.symlink, file);
      } else {
        rmSync(file, { force: true });
        writeFileSync(file, spec.content, { mode: spec.executable ? 0o755 : 0o644 });
      }
    }
    return this;
  }

  /** Stages `paths`, or everything when none are given. */
  stage(paths?: readonly string[]): this {
    this.git(paths ? ["add", "--", ...paths] : ["add", "--all"]);
    return this;
  }

  /** Writes `files`, stages everything and commits. */
  commit(files: Files = {}, message?: string): this {
    this.write(files);
    this.#commits += 1;
    this.git(["add", "--all"]);
    this.git(
      [
        "commit",
        "--quiet",
        "--allow-empty",
        "--no-verify",
        "--message",
        message ?? `commit ${this.#commits}`,
      ],
      { records: true },
    );
    return this;
  }

  /** Renames a tracked file with `git mv`, leaving the rename staged. */
  rename(from: string, to: string): this {
    mkdirSync(dirname(join(this.path, to)), { recursive: true });
    this.git(["mv", "--", from, to]);
    return this;
  }

  /** Detaches HEAD at `ref`. */
  detach(ref = "HEAD"): this {
    this.git(["switch", "--quiet", "--detach", ref], { records: true });
    return this;
  }

  /**
   * Commits the current tree again with a made-up PGP signature, so `log.showSignature`
   * would hand it to `gpg.program`. Nothing verifies the signature; it only has to exist.
   */
  signedCommit(message = "signed"): this {
    const tree = this.rev("HEAD^{tree}");
    const parent = this.rev("HEAD");
    const date = `${Math.floor(Date.parse(this.fixture.now()) / 1000)} +0000`;
    const body = [
      `tree ${tree}`,
      `parent ${parent}`,
      `author Treepeek Test <test@treepeek.invalid> ${date}`,
      `committer Treepeek Test <test@treepeek.invalid> ${date}`,
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " iQEzBAABCAAdFiEEnotarealsignature",
      " -----END PGP SIGNATURE-----",
      "",
      message,
      "",
    ].join("\n");
    const oid = this.git(["hash-object", "-t", "commit", "-w", "--stdin"], { input: body }).trim();
    this.git(["update-ref", "-m", `commit: ${message}`, "HEAD", oid], { records: true });
    return this;
  }

  /** HEAD's commit id. */
  head(): string {
    return this.rev("HEAD");
  }

  /** The object id `ref` names. */
  rev(ref: string): string {
    return this.git(["rev-parse", "--verify", "--end-of-options", ref]).trim();
  }
}

/** A repository: its main checkout (until `bare()`), plus the worktrees made from it. */
export class FixtureRepo extends FixtureCheckout {
  readonly name: string;
  readonly worktrees: FixtureCheckout[] = [];
  #bare = false;
  #commonDir: string;

  constructor(fixture: Fixture, name: string, branch: string) {
    const path = fixture.path(name);
    mkdirSync(path, { recursive: true });
    super(fixture, realpathSync(path));
    this.name = name;
    gitIn(this.path, ["init", "--quiet", `--initial-branch=${branch}`]);
    gitIn(this.path, ["config", "commit.gpgsign", "false"]);
    gitIn(this.path, ["config", "core.autocrlf", "false"]);
    this.#commonDir = join(this.path, ".git");
  }

  /** The repository's common dir (`<name>/.git`, or `<name>.git` once bare). */
  get commonDir(): string {
    return this.#commonDir;
  }

  get isBare(): boolean {
    return this.#bare;
  }

  override get path(): string {
    if (this.#bare) throw new Error(`${this.name} is bare; it has no main checkout`);
    return super.path;
  }

  /** Runs git against the repository itself (works for a bare one too). */
  repoGit(args: readonly string[], options: FixtureGitOptions = {}): string {
    return this.fixture.git(this.#bare ? this.#commonDir : super.path, args, options);
  }

  /**
   * Adds a linked worktree at `<root>/<path>` starting from `options.from`, on a new branch
   * (named after the folder unless `branch` says otherwise) or detached.
   */
  worktree(path: string, options: WorktreeOptions): FixtureCheckout {
    const target = this.fixture.path(path);
    mkdirSync(dirname(target), { recursive: true });
    const branchArgs = options.detach
      ? ["--detach"]
      : ["-b", options.branch ?? refSafe(basename(path))];
    this.repoGit(["worktree", "add", "--quiet", ...branchArgs, target, options.from], {
      records: true,
    });
    const checkout = new FixtureCheckout(this.fixture, realpathSync(target));
    this.worktrees.push(checkout);
    return checkout;
  }

  /**
   * Turns the repository into a bare one at `<root>/<name>.git` and deletes the main
   * checkout. Call it before adding worktrees.
   */
  bare(): this {
    if (this.#bare) return this;
    if (this.worktrees.length > 0) throw new Error("Call bare() before adding worktrees");
    const checkout = super.path;
    const target = `${checkout}.git`;
    renameSync(join(checkout, ".git"), target);
    rmSync(checkout, { recursive: true, force: true });
    this.#bare = true;
    this.#commonDir = target;
    this.repoGit(["config", "core.bare", "true"]);
    return this;
  }

  /**
   * Leaves a folder at `<root>/<path>` with a `.git` file that Git's worktree list does not
   * account for (see `StaleGitFileOptions`).
   */
  staleGitFile(path: string, options: StaleGitFileOptions = {}): this {
    const target = this.fixture.path(path);
    if ((options.kind ?? "dangling") === "dangling") {
      this.repoGit(["worktree", "add", "--quiet", "--detach", target, "HEAD"]);
      const pointer = this.fixture
        .git(target, ["rev-parse", "--path-format=absolute", "--git-dir"])
        .trim();
      rmSync(pointer, { recursive: true, force: true });
      return this;
    }
    // A copy of a real worktree, which Git keeps listing at its original place only.
    const original = this.fixture.outsidePath(`originals/${refSafe(basename(path))}`);
    mkdirSync(dirname(original), { recursive: true });
    this.repoGit(["worktree", "add", "--quiet", "--detach", original, "HEAD"]);
    cpSync(original, target, { recursive: true });
    return this;
  }

  /** Expires every reflog entry of every worktree, as `gc` does after 90 days. */
  expireReflog(): this {
    this.repoGit(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
    return this;
  }

  /**
   * Arms traps in the repository's own config: each vector names a script that appends a
   * line to `markerPath` if anything ever runs it. Attributes go in the common dir's
   * `info/attributes`, which applies to every worktree without adding a file to any diff.
   * Returns the repository; `markerPath` must not exist while nothing has fired.
   */
  maliciousConfig(
    markerPath: string,
    options: { vectors?: readonly MaliciousVector[] } = {},
  ): this {
    const vectors = new Set(options.vectors ?? DEFAULT_MALICIOUS_VECTORS);
    const script = this.fixture.trapScript(markerPath);
    const set = (key: string, value: string) =>
      this.repoGit(["config", "--file", join(this.#commonDir, "config"), key, value]);
    const attributes: string[] = [];
    if (vectors.has("fsmonitor")) set("core.fsmonitor", script);
    if (vectors.has("diffExternal")) set("diff.external", script);
    if (vectors.has("pager")) set("core.pager", script);
    if (vectors.has("textconv")) set(`diff.${DRIVER}.textconv`, script);
    if (vectors.has("diffCommand")) set(`diff.${DRIVER}.command`, script);
    if (vectors.has("textconv") || vectors.has("diffCommand")) attributes.push(`* diff=${DRIVER}`);
    if (vectors.has("showSignature")) {
      set("log.showSignature", "true");
      set("gpg.program", script);
    }
    if (vectors.has("filter")) {
      set(`filter.${DRIVER}.clean`, script);
      set(`filter.${DRIVER}.smudge`, script);
      attributes.push(`* filter=${DRIVER}`);
    }
    if (attributes.length > 0) {
      const file = join(this.#commonDir, "info", "attributes");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${attributes.join("\n")}\n`);
    }
    return this;
  }
}

/** A folder name as a branch name: characters a ref cannot hold become `-`. */
function refSafe(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/(\.lock|\.)$/, "");
  return safe || "worktree";
}
