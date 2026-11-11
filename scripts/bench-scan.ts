/**
 * Scan benchmark: times a scan of a folder holding 30 checkouts, cold and warm, and counts
 * the git processes each starts; then times `review` on a checkout with a large untracked
 * tree, which is where `hash-object --stdin-paths` does its work. Local only, not in CI;
 * the numbers are the baseline recorded in `docs/platform-notes.md`.
 *
 *   bun scripts/bench-scan.ts [--rounds N] [--untracked N]
 *
 * - `--rounds N` (default 5): cold and warm scans, each round in fresh core state.
 * - `--untracked N` (default 10000): files in the large untracked tree.
 *
 * The core service runs from its own modules, driven over a session's MessagePort the way a
 * window drives it, with the tests' git (`TREEPEEK_GIT`, or `git` on the `PATH`).
 *
 * - **Cold**: a new `CoreState` (no repository caches, no batch processes) and a new git
 *   environment, so every folder's config listing is read again. The fixture's files are in
 *   the OS file cache either way: cold means Treepeek's caches, not the disk's.
 * - **Warm**: `scan.start` again in the same session, as ⌘R does.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { observeSpawns, type SpawnEvent } from "../src/core/git/process";
import type { ComparisonResult } from "../src/shared/domain/compare";
import type { Result } from "../src/shared/ipc";
import { resetGitRuntime, setTestGit } from "../tests/support/core-git";
import { type Client, type Harness, harness } from "../tests/support/core-session";
import { testGitPath, testGitVersion } from "../tests/support/git";
import { type Fixture, type FixtureRepo, fixture } from "../tests/support/git-fixture";

interface Options {
  rounds: number;
  untracked: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { rounds: 5, untracked: 10_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = Number(argv[i + 1]);
    if (arg === "--rounds" && Number.isInteger(value) && value > 0) options.rounds = value;
    else if (arg === "--untracked" && Number.isInteger(value) && value > 0) {
      options.untracked = value;
    } else throw new Error(`Unknown or invalid argument: ${arg}`);
    i += 1;
  }
  return options;
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const REPOSITORIES = ["alpha", "beta", "gamma"];
const WORKTREES_PER_REPOSITORY = 9;
const BASE_FILES = 200;
const BASE_COMMITS = 10;

function baseFiles(commit: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < BASE_FILES; i += 1) {
    // Every commit touches a tenth of the files.
    const version = i % 10 === commit % 10 ? commit : 0;
    files[`src/m${i % 20}/file-${i}.ts`] = `export const value${i} = ${version};\n`.repeat(20);
  }
  return files;
}

/**
 * Three repositories, each a main checkout and nine linked worktrees: 30 checkouts. Each
 * worktree has two commits of its own and uncommitted changes (staged, unstaged and
 * untracked); every third starts from an older commit, so the timeline has both relations.
 */
function buildScanFixture(): Fixture {
  const fx = fixture();
  for (const name of REPOSITORIES) {
    const repo: FixtureRepo = fx.repo(name);
    for (let commit = 1; commit <= BASE_COMMITS; commit += 1) repo.commit(baseFiles(commit));
    for (let n = 1; n <= WORKTREES_PER_REPOSITORY; n += 1) {
      const from = n % 3 === 0 ? "HEAD~3" : "main";
      const worktree = repo.worktree(`worktrees/${name}-${n}`, {
        from: repo.rev(from),
        branch: `${name}-${n}`,
      });
      worktree.commit({ [`src/m${n}/file-${n}.ts`]: `export const changed = ${n};\n` });
      worktree.commit({ [`feature-${n}/new.ts`]: `export const added = ${n};\n` });
      worktree.write({ [`src/m${n + 1}/file-${n + 1}.ts`]: "staged\n" });
      worktree.stage([`src/m${n + 1}/file-${n + 1}.ts`]);
      worktree.write({
        [`src/m${n + 2}/file-${n + 2}.ts`]: "unstaged\n",
        [`notes-${n}.md`]: "untracked\n",
        [`scratch/${n}/a.txt`]: "a\n",
        [`scratch/${n}/b.txt`]: "b\n",
      });
    }
  }
  return fx;
}

/** One repository whose checkout holds `count` untracked files in 100 folders. */
function buildUntrackedFixture(count: number): { fx: Fixture; repo: FixtureRepo } {
  const fx = fixture();
  const repo = fx.repo("big").commit({ "README.md": "big\n" });
  for (let i = 0; i < count; i += 1) {
    const folder = join(repo.path, "generated", `d${i % 100}`);
    if (i < 100) mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `f${i}.txt`), `untracked file ${i}\n`.repeat(8));
  }
  return { fx, repo };
}

// ---------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------

interface Measure {
  ms: number;
  spawns: number;
  /** Processes by git subcommand. */
  bySubcommand: Map<string, number>;
}

/** The subcommand in a `gitArgs` list: the first argument after the `-C`/`-c` pairs. */
function subcommandOf(args: readonly string[]): string {
  let i = 0;
  while (args[i] === "-C" || args[i] === "-c") i += 2;
  const subcommand = args[i] ?? "?";
  const flag = args[i + 1];
  if (subcommand === "hash-object" && flag === "--stdin-paths") return "hash-object --stdin-paths";
  if (subcommand === "cat-file" && flag?.startsWith("--batch")) return `cat-file ${flag}`;
  return subcommand;
}

async function measure(work: () => Promise<unknown>): Promise<Measure> {
  const bySubcommand = new Map<string, number>();
  let spawns = 0;
  const stop = observeSpawns((event: SpawnEvent) => {
    if (event.type !== "spawn") return;
    spawns += 1;
    const subcommand = subcommandOf(event.args);
    bySubcommand.set(subcommand, (bySubcommand.get(subcommand) ?? 0) + 1);
  });
  const started = performance.now();
  try {
    await work();
  } finally {
    stop();
  }
  return { ms: performance.now() - started, spawns, bySubcommand };
}

function unwrap<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} ${result.error.message}`);
  return result.value;
}

/** A session in fresh core state, with a new git environment (no config listings kept). */
async function freshSession(root: string): Promise<{ created: Harness; client: Client }> {
  setTestGit();
  const created = harness();
  const { client } = created.open(1);
  // The desktop's own scan: the walked checkouts only.
  unwrap(
    await client.call("session.open", { scanRoots: [root], worktrees: "walked" }),
    "session.open",
  );
  return { created, client };
}

async function scanOnce(client: Client, id: number): Promise<number> {
  unwrap(await client.call("scan.start", { requestId: `bench-${id}` }), "scan.start");
  await client.waitForEvent("scan.done", id, 120_000);
  const done = client.events<{ durationMs: number }>("scan.done")[id - 1];
  return done?.durationMs ?? Number.NaN;
}

interface ScanRound {
  cold: Measure;
  warm: Measure;
  checkouts: number;
}

async function scanRound(root: string): Promise<ScanRound> {
  const { created, client } = await freshSession(root);
  try {
    const cold = await measure(() => scanOnce(client, 1));
    const warm = await measure(() => scanOnce(client, 2));
    return { cold, warm, checkouts: client.events("scan.checkout").length / 2 };
  } finally {
    created.dispose();
  }
}

interface UntrackedRun {
  files: number;
  first: Measure;
  recomputed: Measure;
  cached: Measure;
}

/**
 * `review` on the big checkout: the first list hashes every untracked file; after
 * `invalidate(path, ["workingTree"])` the list is computed again but the `(path, size,
 * mtimeNs)` hash cache answers; a third call is served from the comparison cache.
 */
async function untrackedRun(fx: Fixture, repo: FixtureRepo): Promise<UntrackedRun> {
  const { created, client } = await freshSession(fx.root);
  try {
    await scanOnce(client, 1);
    let files = 0;
    const list = async () => {
      const result = await client.call<ComparisonResult>("comparison.list", {
        checkoutPath: repo.path,
        kind: "review",
      });
      files = unwrap(result, "comparison.list").files.length;
    };
    const first = await measure(list);
    const resources = created.state.repository(repo.commonDir);
    if (!resources) throw new Error("the repository is not held");
    resources.cache.invalidate(repo.path, ["workingTree"]);
    const recomputed = await measure(list);
    const cached = await measure(list);
    return { files, first, recomputed, cached };
  } finally {
    created.dispose();
  }
}

// ---------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function timing(measures: readonly Measure[]): string {
  const times = measures.map((item) => item.ms);
  return `${median(times).toFixed(0)} ms (min ${Math.min(...times).toFixed(0)}, max ${Math.max(...times).toFixed(0)})`;
}

function spawnsText(measures: readonly Measure[]): string {
  const counts = [...new Set(measures.map((item) => item.spawns))];
  return counts.length === 1 ? String(counts[0]) : `${Math.min(...counts)}–${Math.max(...counts)}`;
}

function breakdown(measure: Measure): string {
  return [...measure.bySubcommand]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([subcommand, count]) => `${subcommand} ${count}`)
    .join(", ");
}

/** Bun runs these scripts; the app's core service runs on Electron's Node. */
function runtime(): string {
  const bun = process.versions.bun;
  return bun ? `Bun ${bun}` : `Node ${process.version}`;
}

function machine(): string {
  const cpu = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" });
  const memory = spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" });
  const os = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
  const gb = Math.round(Number(memory.stdout.trim()) / 1024 ** 3);
  return `${cpu.stdout.trim() || arch()}, ${gb} GB, macOS ${os.stdout.trim()} (${arch()})`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const log = (line = "") => process.stdout.write(`${line}\n`);

  let built = performance.now();
  const scanFixture = buildScanFixture();
  const scanBuildMs = performance.now() - built;
  built = performance.now();
  const untracked = buildUntrackedFixture(options.untracked);
  const untrackedBuildMs = performance.now() - built;
  try {
    log("# Scan benchmark");
    log();
    log(`- Run: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`);
    log(`- Machine: ${machine()}`);
    log(`- Git: ${testGitVersion()} (\`${testGitPath()}\`); ${runtime()}`);
    log(
      `- Fixtures: ${REPOSITORIES.length} repositories × (main + ${WORKTREES_PER_REPOSITORY} worktrees), ${BASE_FILES} files and ${BASE_COMMITS} commits each, built in ${(scanBuildMs / 1000).toFixed(1)} s; ${options.untracked} untracked files, written in ${(untrackedBuildMs / 1000).toFixed(1)} s`,
    );
    log();

    const rounds: ScanRound[] = [];
    for (let round = 0; round < options.rounds; round += 1) {
      rounds.push(await scanRound(scanFixture.root));
    }
    const cold = rounds.map((round) => round.cold);
    const warm = rounds.map((round) => round.warm);
    const first = rounds[0];
    if (!first) throw new Error("no rounds");
    log(`## Scan of ${first.checkouts} checkouts (${options.rounds} rounds, median)`);
    log();
    log("| Scan | Time | Git processes |");
    log("| --- | --- | --- |");
    log(`| Cold | ${timing(cold)} | ${spawnsText(cold)} |`);
    log(`| Warm | ${timing(warm)} | ${spawnsText(warm)} |`);
    log();
    log(`- Cold processes: ${breakdown(first.cold)}`);
    log(`- Warm processes: ${breakdown(first.warm)}`);
    const saved = 1 - median(warm.map((m) => m.spawns)) / median(cold.map((m) => m.spawns));
    log(`- The warm scan starts ${(saved * 100).toFixed(0)}% fewer git processes.`);
    log();

    const run = await untrackedRun(untracked.fx, untracked.repo);
    log(`## \`review\` with ${run.files} untracked files`);
    log();
    log("| List | Time | Git processes |");
    log("| --- | --- | --- |");
    log(`| First (every file hashed) | ${run.first.ms.toFixed(0)} ms | ${run.first.spawns} |`);
    log(
      `| Recomputed after \`invalidate(path, ["workingTree"])\` (hash cache) | ${run.recomputed.ms.toFixed(0)} ms | ${run.recomputed.spawns} |`,
    );
    log(`| Repeated (comparison cache) | ${run.cached.ms.toFixed(0)} ms | ${run.cached.spawns} |`);
    log();
    log(`- First list processes: ${breakdown(run.first) || "none"}`);
    log(`- Recomputed list processes: ${breakdown(run.recomputed) || "none"}`);
  } finally {
    scanFixture.cleanup();
    untracked.fx.cleanup();
    resetGitRuntime();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
