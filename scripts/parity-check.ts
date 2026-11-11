/**
 * Prototype parity check: runs the prototype's `server.py` and the core service against the
 * same fixture folder and compares what each finds. Local only, not part of CI.
 *
 *   bun scripts/parity-check.ts [--prototype DIR] [--out FILE] [--keep]
 *   TREEPEEK_PROTOTYPE=DIR bun scripts/parity-check.ts
 *
 * - `--prototype DIR` (or `TREEPEEK_PROTOTYPE`): the prototype checkout holding `server.py`.
 * - `--out FILE`: where the report is written as well as printed. Default
 *   `test-results/parity-report.md` (ignored by Git; Playwright clears that folder on
 *   every end-to-end run).
 * - `--keep`: leave the fixture folder in place and print its path.
 *
 * The prototype runs the way it really runs: `python3 -B server.py` serving HTTP on
 * 127.0.0.1 (here on a free port), asked for `/api/scan` and `/api/changes`. The core
 * service runs from its own modules, driven over a session's MessagePort the way a window
 * drives it (`session.open`, `scan.start`, `comparison.list`), with a local store in a new
 * temporary folder. Both use the tests' git (`TREEPEEK_GIT`, or `git` on the `PATH`) with
 * the machine's global and system config shut out.
 *
 * Compared: the folder tree, the checkouts found, each checkout's fields and start, the
 * timeline order, predecessors and relations, and every comparison kind's file list
 * (paths, statuses, old paths, categories) with its sides, commit count and "contained".
 * Each difference is either matched to a change the design or the core's documented
 * choices intend, or reported as unexplained. Exits 1 when anything is unexplained.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { arch, release } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import * as v from "valibot";
import type {
  ComparisonResult,
  FileChange,
  ListableComparisonKind,
} from "../src/shared/domain/compare";
import type { Checkout, FolderNode, Repository, TimelineEntry } from "../src/shared/domain/scan";
import type { Result } from "../src/shared/ipc";
import { resetGitRuntime, setTestGit } from "../tests/support/core-git";
import { gitWorktreePaths, tempStore } from "../tests/support/core-scan";
import { type Client, harness } from "../tests/support/core-session";
import { gitIn, gitTestEnv, testGitPath, testGitVersion } from "../tests/support/git";
import { type Fixture, fixture } from "../tests/support/git-fixture";

const repoRoot = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------

interface Options {
  prototype: string;
  out: string;
  keep: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let prototype = process.env.TREEPEEK_PROTOTYPE ?? "";
  let out = join(repoRoot, "test-results/parity-report.md");
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prototype") prototype = argv[++i] ?? "";
    else if (arg === "--out") out = resolve(argv[++i] ?? out);
    else if (arg === "--keep") keep = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!prototype) {
    throw new Error("Pass the prototype checkout with --prototype DIR or TREEPEEK_PROTOTYPE");
  }
  prototype = resolve(prototype);
  if (!existsSync(join(prototype, "server.py"))) {
    throw new Error(`No server.py in ${prototype}`);
  }
  return { prototype, out, keep };
}

// ---------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------

const LONG = Array.from({ length: 30 }, (_, i) => `line ${i} of a file Git can follow\n`).join("");
const LONG_COPY = Array.from({ length: 30 }, (_, i) => `copied line ${i}\n`).join("");
const BINARY_1 = new Uint8Array([0, 1, 2, 3, 0, 255, 10]);
const BINARY_2 = new Uint8Array([0, 9, 9, 9, 0, 255, 10]);

/** What to ask both sides about one checkout beyond the kinds every checkout gets. */
interface CheckoutPlan {
  /** A start override (a full commit id) for `worktree` / the prototype's `start`. */
  startOverride?: string;
  /** A base ref that names no commit, to compare how both refuse it. */
  missingBase?: string;
}

interface BuiltFixture {
  fx: Fixture;
  plans: Map<string, CheckoutPlan>;
  cases: string[];
}

/** One fixture folder covering the cases the prototype and the core service share. */
function buildFixture(): BuiltFixture {
  const fx = fixture();
  const plans = new Map<string, CheckoutPlan>();

  // Repository `app`: a main checkout and four linked worktrees under `work/`.
  const app = fx.repo("app").commit({
    "README.md": "app\n",
    "src/keep.txt": "keep\n",
    "src/edit.txt": "line 1\nline 2\n",
    "src/gone.txt": "bye\n",
    "src/move-me.txt": LONG,
    "tools/run.sh": "echo hi\n",
    "assets/logo.bin": BINARY_1,
    "docs/copy-src.txt": LONG_COPY,
    "type.txt": "becomes a link\n",
    "no-newline.txt": "a\nb",
    "rename-back.txt": "comes back\n",
  });
  const basePoint = app.head();
  app.git(["branch", "base-point"]);
  app.git(["switch", "--quiet", "-c", "next"], { records: true });
  app.commit({ "src/incoming.txt": "arrived\n", "src/edit.txt": "line 1 (next)\nline 2\n" });
  app.git(["switch", "--quiet", "main"], { records: true });

  // Starts from `next`, ahead of main's HEAD: `after` the main checkout. Its folder name
  // has a space and non-ASCII characters.
  const feature = app.worktree("work/app feature ü", { from: "next", branch: "feature" });
  feature.rename("src/move-me.txt", "src/moved/renamed file.txt");
  feature.commit({
    "src/edit.txt": "line 1 (feature)\nline 2\n",
    "src/gone.txt": null,
    "src/moved/renamed file.txt": `${LONG}one more line\n`,
    "tools/run.sh": { content: "echo hi\n", executable: true },
    "with space.txt": "space\n",
    "naïve-ü 名.txt": "unicode\n",
    "line\nbreak.txt": "newline\n",
    "assets/logo.bin": BINARY_2,
    "docs/copy-dst.txt": LONG_COPY,
    "type.txt": { symlink: "README.md" },
    "no-newline.txt": "a\nc",
  });
  feature.git(["branch", "--quiet", "--set-upstream-to=next"]);
  plans.set(feature.path, { startOverride: basePoint, missingBase: "no-such-branch" });

  // Made from the feature worktree's branch: `after` it.
  const hotfix = app.worktree("work/app-hotfix", { from: "feature", branch: "hotfix" });
  hotfix.commit({ "src/edit.txt": "line 1 (hotfix)\nline 2\n", "hotfix.txt": "fix\n" });

  // Made from an older commit: `parallel` to the hotfix.
  const parallel = app.worktree("work/app-parallel", { from: "base-point", branch: "parallel" });
  parallel.commit({ "README.md": null, "assets/new.bin": BINARY_2, "src/edit.txt": "other\n" });

  // A detached HEAD.
  const detached = app.worktree("work/app-detached", { from: "next", detach: true });
  detached.write({ "scratch.txt": "not committed\n" });

  // Uncommitted work in the feature worktree, after the hotfix branched off: staged,
  // unstaged and untracked files, a path dropped from the index but kept on disk, and a
  // staged rename whose old path is back on disk.
  feature.write({ "staged.txt": "staged\n", "src/edit.txt": "line 1 (staged)\nline 2\n" });
  feature.stage(["staged.txt", "src/edit.txt"]);
  feature.write({
    "src/edit.txt": "line 1 (unstaged)\nline 2\n",
    "src/keep.txt": "kept, and changed\n",
    "docs/copy-src.txt": null,
  });
  feature.git(["rm", "--quiet", "--cached", "--", "tools/run.sh"]);
  feature.rename("rename-back.txt", "renamed-back.txt");
  feature.write({
    "rename-back.txt": "comes back\n",
    "untracked one.txt": "u\n",
    "untracked.bin": BINARY_1,
    "dir/deep/ü.txt": "deep\n",
  });

  // Stale `.git` files: a worktree whose admin folder is gone, and a copied worktree.
  app.staleGitFile("stale/dangling");
  app.staleGitFile("stale/copied", { kind: "copied" });

  // A bare repository with two worktrees, the second made from the first's branch.
  const svc = fx.repo("svc").commit({ "svc.txt": "service\n", "lib/a.txt": "a\n" }).bare();
  const svcMain = svc.worktree("svc-main", { from: "main", branch: "svc-main" });
  svcMain.commit({ "svc.txt": "service v2\n" });
  const svcTopic = svc.worktree("svc-topic", { from: "svc-main", branch: "topic" });
  svcTopic.commit({ "lib/a.txt": null, "lib/b.txt": "b\n" });
  svcTopic.write({ "notes.md": "untracked\n" });

  // A detached main checkout, nested in group folders.
  const solo = fx.repo("group/nested/solo").commit({ "s.txt": "1\n" }).commit({ "s.txt": "2\n" });
  solo.commit({ "s.txt": "3\n" }).detach("HEAD~1");

  // Expired reflogs: no start for the main checkout or its worktree.
  const old = fx.repo("old").commit({ "o.txt": "1\n" });
  const oldFirst = old.head();
  old.commit({ "o.txt": "2\n" });
  old.worktree("old-wt", { from: "main" }).commit({ "w.txt": "w\n" });
  old.write({ "o.txt": "3\n" }).expireReflog();
  plans.set(old.path, { startOverride: oldFirst });

  // No commits yet: a staged file and an untracked one in a subfolder.
  const empty = fx.repo("empty");
  empty.write({ "e.txt": "e\n" }).stage(["e.txt"]);
  empty.write({ "src/f.txt": "f\n" });

  // The walk: a checkout at depth 7 is found, one at depth 8 is not; skip-listed folders
  // and symlinked folders are not entered.
  fx.repo("deep/1/2/3/4/5/at7").commit({ "d.txt": "7\n" });
  fx.repo("deep/1/2/3/4/5/6/at8").commit({ "d.txt": "8\n" });
  fx.repo("node_modules/pkg").commit({ "p.txt": "p\n" });
  fx.repo("build/gen").commit({ "g.txt": "g\n" });
  symlinkSync(app.path, fx.path("link-to-app"));
  mkdirSync(fx.outsidePath("elsewhere/repo"), { recursive: true });
  symlinkSync(fx.outsidePath("elsewhere"), fx.path("work/link-outside"));

  const cases = [
    "`app`: a main checkout and linked worktrees (`work/app feature ü` from `next`, `work/app-hotfix` from the feature worktree's branch, `work/app-parallel` from an older commit, `work/app-detached` with a detached HEAD)",
    "`after` and `parallel` relations; an upstream (`feature` tracks `next`)",
    "renames, a copy, deletions, a mode change, a type change (file to symlink), binary files, no newline at end of file",
    "paths with spaces, non-ASCII characters and a newline; a checkout folder with a space and non-ASCII characters",
    "staged, unstaged and untracked files, a path dropped from the index but kept on disk, a staged rename whose old path is back on disk",
    "stale `.git` files (`stale/dangling`, `stale/copied`)",
    "a bare repository `svc.git` with worktrees `svc-main` and `svc-topic`",
    "a detached main checkout nested in folders (`group/nested/solo`)",
    "expired reflogs (`old`, `old-wt`), and a start override",
    "a repository without commits (`empty`)",
    "the walk: a checkout at depth 7 and one at depth 8, `node_modules` and `build` folders, symlinked folders",
  ];
  return { fx, plans, cases };
}

// ---------------------------------------------------------------------------------------
// The prototype
// ---------------------------------------------------------------------------------------

const ProtoCounts = v.object({ commits: v.number(), files: v.number() });
const ProtoItem = v.object({
  path: v.string(),
  repo: v.string(),
  common: v.string(),
  kind: v.picklist(["main", "linked"]),
  branch: v.string(),
  head: v.string(),
  fullHead: v.string(),
  remote: v.string(),
  upstream: v.string(),
  start: v.string(),
  createdAt: v.string(),
  relative: v.string(),
  counts: v.object({ staged: v.number(), unstaged: v.number(), untracked: v.number() }),
  history: v.nullable(ProtoCounts),
  previous: v.nullable(
    v.object({ path: v.string(), relative: v.string(), head: v.string(), linear: v.boolean() }),
  ),
  incoming: v.nullable(ProtoCounts),
  sincePrevious: v.nullable(ProtoCounts),
});
const ProtoFolder = v.object({
  relative: v.string(),
  name: v.string(),
  parent: v.nullable(v.string()),
  depth: v.number(),
  gitPath: v.nullable(v.string()),
});
const ProtoScan = v.object({
  folder: v.string(),
  items: v.array(ProtoItem),
  folders: v.array(ProtoFolder),
  depthLimit: v.number(),
});
const ProtoEntry = v.object({
  category: v.string(),
  file: v.string(),
  oldFile: v.optional(v.string()),
  status: v.string(),
});
const ProtoComparison = v.object({
  mode: v.string(),
  files: v.array(ProtoEntry),
  left: v.optional(v.string()),
  right: v.optional(v.string()),
  commits: v.optional(v.number()),
  contained: v.optional(v.boolean()),
});
const ProtoError = v.object({ error: v.string() });

type ProtoItem = v.InferOutput<typeof ProtoItem>;
type ProtoScan = v.InferOutput<typeof ProtoScan>;
type ProtoComparison = v.InferOutput<typeof ProtoComparison>;

/** The prototype's server, running. */
interface Prototype {
  base: string;
  scan(folder: string): Promise<ProtoScan>;
  changes(
    path: string,
    mode: string,
    ref?: string,
  ): Promise<{ ok: true; value: ProtoComparison } | { ok: false; error: string }>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function startPrototype(dir: string): Promise<Prototype> {
  const port = await freePort();
  const gitFolder = dirname(testGitPath());
  const env = {
    ...gitTestEnv(),
    PATH: `${gitFolder}${delimiter}${process.env.PATH ?? ""}`,
    TREEPEEK_PORT: String(port),
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const child: ChildProcess = spawn("python3", ["-B", join(dir, "server.py")], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const base = `http://127.0.0.1:${port}`;

  // server.py prints its URL before it binds, so poll until it answers.
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server.py exited early: ${stderr}`);
    try {
      const response = await fetch(`${base}/api/nothing`);
      await response.body?.cancel();
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill("SIGTERM");
        throw new Error(`server.py did not answer on ${base}: ${stderr}`);
      }
      await new Promise((wait) => setTimeout(wait, 50));
    }
  }

  async function get(path: string, query: Record<string, string>): Promise<Response> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return fetch(url);
  }

  return {
    base,
    async scan(folder) {
      const response = await get("/api/scan", { folder });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(`prototype scan failed: ${JSON.stringify(body)}`);
      return v.parse(ProtoScan, body);
    },
    async changes(path, mode, ref) {
      const response = await get("/api/changes", { path, mode, ...(ref ? { ref } : {}) });
      const body: unknown = await response.json();
      if (response.status === 400) return { ok: false, error: v.parse(ProtoError, body).error };
      if (!response.ok) throw new Error(`prototype /api/changes: ${response.status}`);
      return { ok: true, value: v.parse(ProtoComparison, body) };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

// ---------------------------------------------------------------------------------------
// The core service
// ---------------------------------------------------------------------------------------

interface CoreScan {
  folders: FolderNode[];
  checkouts: Checkout[];
  timeline: TimelineEntry[];
  repositories: Repository[];
  /** Order the checkouts arrived in, against when `scan.done` arrived. */
  checkoutsBeforeDone: boolean;
  storeEngine: string;
}

interface CoreService {
  client: Client;
  scan: CoreScan;
  dispose(): void;
}

function unwrap<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} ${result.error.message}`);
  return result.value;
}

async function startCore(root: string): Promise<CoreService> {
  setTestGit();
  const store = tempStore();
  const created = harness(() => store.store);
  const { client } = created.open(1);
  // The prototype lists what its walk finds, as the desktop does.
  unwrap(
    await client.call("session.open", { scanRoots: [root], worktrees: "walked" }),
    "session.open",
  );
  const started = unwrap(
    await client.call<{ roots: { folders: FolderNode[] }[] }>("scan.start", {
      requestId: "parity",
    }),
    "scan.start",
  );
  await client.waitForEvent("scan.done", 1, 60_000);
  const done = client.events<{ timeline: TimelineEntry[]; repositories: Repository[] }>(
    "scan.done",
  )[0];
  if (!done) throw new Error("no scan.done");
  const doneIndex = client.arrivals.findIndex(
    (arrival) => arrival.kind === "event" && arrival.channel === "scan.done",
  );
  const lastCheckout = client.arrivals.findLastIndex(
    (arrival) => arrival.kind === "event" && arrival.channel === "scan.checkout",
  );
  return {
    client,
    scan: {
      folders: started.roots[0]?.folders ?? [],
      checkouts: client.events<Checkout>("scan.checkout"),
      timeline: done.timeline,
      repositories: done.repositories,
      checkoutsBeforeDone: lastCheckout < doneIndex,
      storeEngine: store.store.engine,
    },
    dispose() {
      created.dispose();
      store.dispose();
      resetGitRuntime();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Differences and the changes that explain them
// ---------------------------------------------------------------------------------------

/** Changes the design or the core's documented choices make on purpose. */
const INTENDED = {
  reviewKind:
    "`review` (start → working tree, each path once) is new in the design and the default (domain model, Comparison kinds); the prototype has no such mode.",
  bareName:
    "A bare repository is named after its folder without `.git`; the prototype used the common dir's parent folder, which is wrong for bare repositories (domain model, Repository).",
  unbornCheckout:
    "A repository without commits is a checkout (domain model, Checkout: a `.git` marker, its own top level, in Git's worktree list), with `head: null`; the prototype dropped it because `rev-parse --short HEAD` failed.",
  walkStopsAtMarker:
    "The walk stops at every `.git` marker, valid or not (`src/core/scan/walk.ts`: nested repositories belong to that checkout); the prototype kept walking into folders whose marker it could not read as a checkout.",
  walkBareGitDir:
    "The walk lists a bare repository's Git directory but does not enter it, so its object store does not fill the folder tree (`src/core/scan/walk.ts`).",
  folderMarkedBeforeValidation:
    "The folder tree is sent before validation, so `checkoutPath` marks every folder with a `.git` marker; a folder that gets no `scan.checkout` before `scan.done` turned out not to be a checkout (`FolderNode.checkoutPath`, `src/shared/domain/scan.ts`). The prototype cleared it after validating.",
  statusNoRenames:
    "Working counts come from `status --porcelain=v2 --no-renames` (command catalogue: renames are detected per comparison instead), which counts a staged rename as a deletion and an addition; the prototype's `diff --name-only --cached` detected the rename and counted one path.",
  detachedBranch: "A detached HEAD has `branch: null`; the prototype showed the text `(detached)`.",
  resultHash:
    "Every file carries `resultHash` (blob id, the id `hash-object` gives a working-tree file, or `deleted:<leftOid>`), new in the design (domain model, FileChange).",
  overrideKind:
    "The prototype's `start` mode with a typed ref is `worktree` with `startOverride` (a start for one call, not stored).",
} as const;

type Reason = keyof typeof INTENDED;

interface Difference {
  area: string;
  subject: string;
  detail: string;
  reason?: Reason;
}

class Ledger {
  readonly differences: Difference[] = [];
  readonly compared = new Map<string, number>();
  readonly checks: string[] = [];

  count(area: string, n = 1): void {
    this.compared.set(area, (this.compared.get(area) ?? 0) + n);
  }

  add(area: string, subject: string, detail: string, reason?: Reason): void {
    this.differences.push({ area, subject, detail, ...(reason ? { reason } : {}) });
  }

  check(text: string): void {
    this.checks.push(text);
  }

  unexplained(): Difference[] {
    return this.differences.filter((difference) => difference.reason === undefined);
  }
}

// ---------------------------------------------------------------------------------------
// Comparing scans
// ---------------------------------------------------------------------------------------

function code(text: string): string {
  return `\`${JSON.stringify(text).slice(1, -1).replaceAll("`", "'")}\``;
}

function relativeTo(root: string, path: string): string {
  if (path === root) return ".";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function compareFolders(
  ledger: Ledger,
  root: string,
  proto: ProtoScan,
  core: CoreScan,
  validPaths: ReadonlySet<string>,
): void {
  const area = "Folder tree";
  const protoFolders = new Map(
    proto.folders.map((folder) => [folder.relative === "." ? "" : folder.relative, folder]),
  );
  const coreFolders = new Map(core.folders.map((folder) => [folder.relativePath, folder]));
  const markers = core.folders.filter((folder) => folder.checkoutPath !== null);
  const bareDirs = core.repositories
    .map((repository) => repository.commonDir)
    .filter((commonDir) => !commonDir.endsWith("/.git"))
    .map((commonDir) => relativeTo(root, commonDir));
  const under = (relative: string, folder: string) => relative.startsWith(`${folder}/`);

  const protoOnly: Record<Reason | "none", string[]> = {} as Record<Reason | "none", string[]>;
  for (const [relative] of protoFolders) {
    if (coreFolders.has(relative)) continue;
    let reason: Reason | "none" = "none";
    if (markers.some((folder) => under(relative, folder.relativePath))) {
      reason = "walkStopsAtMarker";
    } else if (bareDirs.some((dir) => under(relative, dir))) {
      reason = "walkBareGitDir";
    }
    protoOnly[reason] ??= [];
    protoOnly[reason].push(relative);
  }
  for (const [reason, folders] of Object.entries(protoOnly)) {
    const parents = summarizeFolders(folders);
    ledger.add(
      area,
      `${folders.length} folders only the prototype lists`,
      `under ${parents.map(code).join(", ")}`,
      reason === "none" ? undefined : (reason as Reason),
    );
  }
  for (const [relative] of coreFolders) {
    if (!protoFolders.has(relative)) {
      ledger.add(area, code(relative || "."), "listed by the core service only");
    }
  }

  for (const [relative, coreFolder] of coreFolders) {
    const protoFolder = protoFolders.get(relative);
    if (!protoFolder) continue;
    ledger.count(area);
    const protoParent = protoFolder.parent === "." ? "" : protoFolder.parent;
    if (protoFolder.depth !== coreFolder.depth || protoParent !== coreFolder.parent) {
      ledger.add(
        area,
        code(relative || "."),
        `depth/parent: prototype ${protoFolder.depth}/${protoParent}, core ${coreFolder.depth}/${coreFolder.parent}`,
      );
    }
    if (protoFolder.name !== coreFolder.name && relative !== "") {
      ledger.add(area, code(relative), `name: ${protoFolder.name} vs ${coreFolder.name}`);
    }
    if (protoFolder.gitPath !== coreFolder.checkoutPath) {
      const core = coreFolder.checkoutPath;
      const reason: Reason | undefined =
        protoFolder.gitPath === null && core !== null
          ? validPaths.has(core)
            ? "unbornCheckout"
            : "folderMarkedBeforeValidation"
          : undefined;
      ledger.add(
        area,
        code(relative || "."),
        `checkout marker: prototype ${protoFolder.gitPath === null ? "none" : "set"}, core ${core === null ? "none" : "set"}`,
        reason,
      );
    }
  }
}

/** The shortest folders that cover `folders` (their topmost ancestors among them). */
function summarizeFolders(folders: readonly string[]): string[] {
  const sorted = [...folders].sort();
  const tops: string[] = [];
  for (const folder of sorted) {
    const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
    if (!tops.some((top) => folder.startsWith(`${top}/`))) tops.push(parent || folder);
  }
  return [...new Set(tops)];
}

interface Pair {
  relative: string;
  proto: ProtoItem;
  core: Checkout;
}

/**
 * `stagedRenames`: staged renames and copies per checkout, from the core's `working` list,
 * which explain a staged count one higher per rename.
 */
function compareCheckouts(
  ledger: Ledger,
  root: string,
  proto: ProtoScan,
  core: CoreScan,
  stagedRenames: ReadonlyMap<string, number>,
): Pair[] {
  const area = "Checkouts";
  const protoByPath = new Map(proto.items.map((item) => [item.path, item]));
  const coreByPath = new Map(core.checkouts.map((checkout) => [checkout.path, checkout]));
  const pairs: Pair[] = [];
  for (const [path, checkout] of coreByPath) {
    const item = protoByPath.get(path);
    if (item) {
      pairs.push({ relative: relativeTo(root, path), proto: item, core: checkout });
      continue;
    }
    ledger.add(
      area,
      code(relativeTo(root, path)),
      "found by the core service only",
      checkout.head === null ? "unbornCheckout" : undefined,
    );
  }
  for (const path of protoByPath.keys()) {
    if (!coreByPath.has(path)) {
      ledger.add(area, code(relativeTo(root, path)), "found by the prototype only");
    }
  }

  const displayNames = new Map<string, string>();
  for (const repository of core.repositories) {
    for (const path of repository.checkouts) displayNames.set(path, repository.displayName);
  }
  for (const { relative, proto: item, core: checkout } of pairs) {
    ledger.count(area);
    const subject = code(relative);
    const field = (name: string, protoValue: unknown, coreValue: unknown, reason?: Reason) => {
      if (protoValue === coreValue) return;
      ledger.add(
        area,
        subject,
        `${name}: prototype ${JSON.stringify(protoValue)}, core ${JSON.stringify(coreValue)}`,
        reason,
      );
    };
    field("kind", item.kind, checkout.kind);
    if (item.branch === "(detached)" && checkout.branch === null) {
      ledger.add(area, subject, "branch: prototype `(detached)`, core `null`", "detachedBranch");
    } else {
      field("branch", item.branch, checkout.branch);
    }
    field("head", item.fullHead, checkout.head);
    field("upstream", item.upstream || null, checkout.upstream?.ref ?? null);
    field("origin", item.remote || null, checkout.originUrl);
    const name = displayNames.get(checkout.path);
    const bare = item.common.endsWith(".git") && !item.common.endsWith("/.git");
    field("repository name", item.repo, name, bare ? "bareName" : undefined);
    field("history", JSON.stringify(item.history), JSON.stringify(checkout.history));
    for (const key of ["staged", "unstaged", "untracked"] as const) {
      const renames = key === "staged" ? (stagedRenames.get(checkout.path) ?? 0) : 0;
      const explained = renames > 0 && checkout.working[key] === item.counts[key] + renames;
      field(
        `working.${key}`,
        item.counts[key],
        checkout.working[key],
        explained ? "statusNoRenames" : undefined,
      );
    }
  }
  return pairs;
}

function compareStarts(ledger: Ledger, pairs: readonly Pair[]): void {
  const area = "Starts";
  for (const { relative, proto: item, core: checkout } of pairs) {
    ledger.count(area);
    const coreStart = checkout.start;
    const protoKnown = item.start !== "";
    if (!protoKnown && coreStart.unknown) continue;
    if (protoKnown && !coreStart.unknown) {
      if (item.start !== coreStart.commit) {
        ledger.add(area, code(relative), `commit: ${item.start} vs ${coreStart.commit}`);
      }
      if (Date.parse(item.createdAt) !== Date.parse(coreStart.observedAt)) {
        ledger.add(
          area,
          code(relative),
          `first observed: ${item.createdAt} vs ${coreStart.observedAt}`,
        );
      }
      if (coreStart.source !== "reflog") {
        ledger.add(area, code(relative), `core start source is ${coreStart.source}`);
      }
      continue;
    }
    ledger.add(
      area,
      code(relative),
      `prototype ${protoKnown ? item.start : "unknown"}, core ${coreStart.unknown ? "unknown" : coreStart.commit}`,
    );
  }
}

function compareTimeline(
  ledger: Ledger,
  root: string,
  pairs: readonly Pair[],
  proto: ProtoScan,
  core: CoreScan,
): void {
  const area = "Timeline";
  const shared = new Set(pairs.map((pair) => pair.core.path));
  const protoOrder = proto.items.map((item) => item.path).filter((path) => shared.has(path));
  const coreOrder = core.timeline
    .map((entry) => entry.checkoutPath)
    .filter((path) => shared.has(path));
  ledger.count(area);
  if (protoOrder.join("\n") !== coreOrder.join("\n")) {
    ledger.add(
      area,
      "order",
      `prototype ${protoOrder.map((p) => relativeTo(root, p)).join(" → ")}; core ${coreOrder.map((p) => relativeTo(root, p)).join(" → ")}`,
    );
  }
  const sequences = core.timeline.map((entry) => entry.sequence);
  if (sequences.some((sequence, index) => sequence !== index + 1)) {
    ledger.add(area, "numbering", `core sequences are ${sequences.join(", ")}`);
  }
  const entries = new Map(core.timeline.map((entry) => [entry.checkoutPath, entry]));
  for (const { relative, proto: item, core: checkout } of pairs) {
    ledger.count(area);
    const entry = entries.get(checkout.path);
    if (!entry) {
      ledger.add(area, code(relative), "missing from the core timeline");
      continue;
    }
    const protoRelation =
      item.previous === null ? "first" : item.previous.linear ? "after" : "parallel";
    const protoPredecessor = item.previous?.path ?? null;
    if (protoPredecessor !== entry.predecessor) {
      ledger.add(
        area,
        code(relative),
        `predecessor: prototype ${protoPredecessor ? relativeTo(root, protoPredecessor) : "none"}, core ${entry.predecessor ? relativeTo(root, entry.predecessor) : "none"}`,
      );
    }
    if (protoRelation !== entry.relation) {
      ledger.add(area, code(relative), `relation: ${protoRelation} vs ${entry.relation}`);
    }
  }
}

/** Things neither side may find: too deep, skip-listed, or behind a symlink. */
function checkWalk(ledger: Ledger, fx: Fixture, proto: ProtoScan, core: CoreScan): void {
  const area = "Folder tree";
  const hidden = [
    "deep/1/2/3/4/5/6/at8",
    "node_modules",
    "build",
    "link-to-app",
    "work/link-outside",
  ];
  const protoPaths = [
    ...proto.items.map((item) => item.path),
    ...proto.folders.map((folder) => fx.path(folder.relative)),
  ];
  const corePaths = [
    ...core.checkouts.map((checkout) => checkout.path),
    ...core.folders.map((folder) => fx.path(folder.relativePath)),
  ];
  for (const relative of hidden) {
    ledger.count(area);
    const target = fx.path(relative);
    const inside = (path: string) => path === target || path.startsWith(`${target}/`);
    if (protoPaths.some(inside)) ledger.add(area, code(relative), "the prototype entered it");
    if (corePaths.some(inside)) ledger.add(area, code(relative), "the core service entered it");
  }
  const deepest = Math.max(...core.folders.map((folder) => folder.depth));
  ledger.check(
    `Neither side listed or entered ${hidden.map(code).join(", ")}; the deepest folder the core lists is at depth ${deepest}, and the prototype reports a depth limit of ${proto.depthLimit}.`,
  );
}

/** Git's own worktree list is the authority on which checkouts exist (both sides). */
function checkWorktreeLists(ledger: Ledger, root: string, proto: ProtoScan, core: CoreScan): void {
  const area = "Checkouts";
  const protoPaths = new Set(proto.items.map((item) => item.path));
  let listed = 0;
  for (const repository of core.repositories) {
    ledger.count(area);
    const fromGit = gitWorktreePaths(repository.commonDir)
      .filter((path) => path.startsWith(`${root}/`))
      .sort();
    listed += fromGit.length;
    const coreList = [...repository.checkouts].sort();
    if (fromGit.join("\n") !== coreList.join("\n")) {
      ledger.add(
        area,
        code(repository.displayName),
        `core checkouts ${coreList.map((p) => relativeTo(root, p)).join(", ")}; git worktree list ${fromGit.map((p) => relativeTo(root, p)).join(", ")}`,
      );
    }
    const missing = fromGit.filter((path) => !protoPaths.has(path));
    for (const path of missing) {
      const unborn = core.checkouts.find((checkout) => checkout.path === path)?.head === null;
      if (!unborn) {
        ledger.add(
          area,
          code(relativeTo(root, path)),
          "in Git's worktree list, not found by the prototype",
        );
      }
    }
  }
  ledger.check(
    `Each repository's checkouts equal \`git worktree list --porcelain -z\` under the root (${listed} checkouts in ${core.repositories.length} repositories); the stale \`.git\` folders are in neither.`,
  );
}

// ---------------------------------------------------------------------------------------
// Comparing comparison lists
// ---------------------------------------------------------------------------------------

interface ListedFile {
  category: string;
  path: string;
  oldPath: string | null;
  status: string;
}

const PROTO_STATUS: Readonly<Record<string, string>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "typeChanged",
  U: "modified",
  X: "modified",
  "?": "untracked",
  renamed: "renamed",
  copied: "copied",
};

function fromProto(entry: v.InferOutput<typeof ProtoEntry>, working: boolean): ListedFile {
  return {
    category: working ? entry.category : "",
    path: entry.file,
    oldPath: entry.oldFile ?? null,
    status: PROTO_STATUS[entry.status] ?? `?${entry.status}`,
  };
}

function fromCore(change: FileChange): ListedFile {
  return {
    category: change.category ?? "",
    path: change.path,
    oldPath: change.oldPath ?? null,
    status: change.status,
  };
}

interface KindPlan {
  label: string;
  protoMode: string;
  protoRef?: string;
  core: { kind: ListableComparisonKind; ref?: string; startOverride?: string };
  reason?: Reason;
}

function kindPlans(plan: CheckoutPlan): KindPlan[] {
  const plans: KindPlan[] = [
    { label: "working", protoMode: "working", core: { kind: "working" } },
    { label: "worktree", protoMode: "start", core: { kind: "worktree" } },
    { label: "incoming", protoMode: "incoming", core: { kind: "incoming" } },
    { label: "sincePrevious", protoMode: "previous", core: { kind: "sincePrevious" } },
    {
      label: "base main",
      protoMode: "base",
      protoRef: "main",
      core: { kind: "base", ref: "main" },
    },
    { label: "upstream", protoMode: "upstream", core: { kind: "upstream" } },
  ];
  if (plan.startOverride) {
    plans.push({
      label: "worktree, start override",
      protoMode: "start",
      protoRef: plan.startOverride,
      core: { kind: "worktree", startOverride: plan.startOverride },
      reason: "overrideKind",
    });
  }
  if (plan.missingBase) {
    plans.push({
      label: `base ${plan.missingBase}`,
      protoMode: "base",
      protoRef: plan.missingBase,
      core: { kind: "base", ref: plan.missingBase },
    });
  }
  return plans;
}

interface KindRow {
  checkout: string;
  label: string;
  outcome: string;
  files: number;
}

async function compareComparisons(
  ledger: Ledger,
  pairs: readonly Pair[],
  prototype: Prototype,
  client: Client,
  plans: ReadonlyMap<string, CheckoutPlan>,
): Promise<KindRow[]> {
  const area = "Comparisons";
  const rows: KindRow[] = [];
  let reviewsListed = 0;
  let reviewsChecked = 0;
  for (const { relative, proto: item, core: checkout } of pairs) {
    // The prototype's `working` and `start` lists, for the `review` cross-check below.
    const listsForReview: ReviewInputs = {};
    for (const plan of kindPlans(plans.get(checkout.path) ?? {})) {
      ledger.count(area);
      const subject = `${code(relative)} ${plan.label}`;
      const protoResult = await prototype.changes(item.path, plan.protoMode, plan.protoRef);
      const coreResult = await client.call<ComparisonResult>("comparison.list", {
        checkoutPath: checkout.path,
        ...plan.core,
      });
      if (plan.reason) {
        ledger.add(area, subject, "requested differently on each side", plan.reason);
      }
      if (!protoResult.ok || !coreResult.ok) {
        const protoText = protoResult.ok ? "available" : `"${protoResult.error}"`;
        const coreText = coreResult.ok
          ? "available"
          : `${coreResult.error.code}${unavailableReason(coreResult.error.detail)}`;
        if (protoResult.ok !== coreResult.ok) {
          ledger.add(area, subject, `prototype ${protoText}, core ${coreText}`);
        }
        rows.push({
          checkout: relative,
          label: plan.label,
          outcome:
            protoResult.ok === coreResult.ok
              ? `both unavailable (core ${coreText}; prototype ${protoText})`
              : `prototype ${protoText}, core ${coreText}`,
          files: 0,
        });
        if (plan.label === "worktree") listsForReview.start = "none";
        continue;
      }
      const protoValue = protoResult.value;
      const coreValue = coreResult.value;
      if (plan.label === "working" || plan.label === "worktree") {
        const files = protoValue.files.map((entry) => fromProto(entry, false));
        if (plan.label === "working") listsForReview.working = files;
        else listsForReview.start = files;
      }
      checkResultHashes(ledger, subject, coreValue.files);
      compareSides(ledger, subject, item, protoValue, coreValue);
      const working = plan.core.kind === "working";
      const mismatches = compareFiles(
        ledger,
        subject,
        protoValue.files.map((entry) => fromProto(entry, working)),
        coreValue.files.map(fromCore),
      );
      rows.push({
        checkout: relative,
        label: plan.label,
        outcome: mismatches === 0 ? "same files" : `${mismatches} file differences`,
        files: coreValue.files.length,
      });
    }

    // `review` is new, so the prototype has no list for it. Where the prototype's lists
    // determine it anyway, it is checked against them: with no uncommitted changes it is the
    // `start` list; with nothing committed since the start (or no start, where it falls back
    // to HEAD) it is the `working` list with each path once.
    const review = await client.call<ComparisonResult>("comparison.list", {
      checkoutPath: checkout.path,
      kind: "review",
    });
    ledger.count(area);
    const reviewSubject = `${code(relative)} review`;
    let outcome = "core only (new kind)";
    if (review.ok) {
      checkResultHashes(ledger, reviewSubject, review.value.files);
      reviewsListed += 1;
      const expected = expectedReview(listsForReview);
      if (expected) {
        const mismatches = compareFiles(
          ledger,
          reviewSubject,
          expected.files,
          review.value.files.map((file) => fromCore(file)),
        );
        reviewsChecked += 1;
        outcome = `new kind; ${mismatches === 0 ? "same files as" : `${mismatches} differences from`} the prototype's ${expected.from}`;
      } else {
        // Committed and uncommitted changes together: no prototype list holds this, but
        // every path it names must come from the prototype's `start` or `working` list.
        const named = (files: readonly ListedFile[]) =>
          files.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path]));
        const protoPaths = new Set(
          named([
            ...(listsForReview.working ?? []),
            ...(Array.isArray(listsForReview.start) ? listsForReview.start : []),
          ]),
        );
        const reviewPaths = new Set(named(review.value.files.map((file) => fromCore(file))));
        const extra = [...reviewPaths].filter((path) => !protoPaths.has(path));
        const absent = [...protoPaths].filter((path) => !reviewPaths.has(path));
        for (const path of extra) {
          ledger.add(area, reviewSubject, `${code(path)} is in no prototype list`);
        }
        for (const path of absent) {
          ledger.add(area, reviewSubject, `${code(path)} from the prototype's lists is missing`);
        }
        outcome = `new kind; committed and uncommitted changes together; ${extra.length + absent.length === 0 ? "names the same paths as" : "differs from"} the prototype's \`start\` and \`working\` lists`;
      }
    } else {
      ledger.add(area, reviewSubject, `core failed: ${review.error.message}`);
    }
    rows.push({
      checkout: relative,
      label: "review",
      outcome,
      files: review.ok ? review.value.files.length : 0,
    });

    // The prototype's scan row carries incoming and since-previous counts; the core service
    // reports them with those comparisons.
    for (const [kind, counts] of [
      ["incoming", item.incoming],
      ["sincePrevious", item.sincePrevious],
    ] as const) {
      if (counts === null) continue;
      ledger.count(area);
      const result = await client.call<ComparisonResult>("comparison.list", {
        checkoutPath: checkout.path,
        kind,
      });
      const coreCounts = result.ok
        ? { commits: result.value.commits, files: result.value.files.length }
        : null;
      if (coreCounts?.commits !== counts.commits || coreCounts.files !== counts.files) {
        ledger.add(
          area,
          `${code(relative)} ${kind} counts`,
          `prototype scan ${JSON.stringify(counts)}, core list ${JSON.stringify(coreCounts)}`,
        );
      }
    }
  }
  ledger.add(
    area,
    `\`review\` on ${reviewsListed} checkouts`,
    `listed by the core only; ${reviewsChecked} cross-checked against the prototype's lists, the rest hold committed and uncommitted changes together`,
    "reviewKind",
  );
  return rows;
}

/** What `review` must list, when the prototype's `working` and `start` lists settle it. */
/** The prototype's lists that settle what `review` holds. */
interface ReviewInputs {
  working?: ListedFile[];
  /** `none` when the start is unknown, so `review` falls back to HEAD. */
  start?: ListedFile[] | "none";
}

/** What `review` must list, when the prototype's `working` and `start` lists settle it. */
function expectedReview(lists: ReviewInputs): { files: ListedFile[]; from: string } | null {
  const { working, start } = lists;
  if (!working || !start) return null;
  if (working.length === 0) {
    return start === "none"
      ? { files: [], from: "lists (no start and no uncommitted changes)" }
      : { files: start, from: "`start` list" };
  }
  const noCommits = start === "none" || start.length === 0;
  if (noCommits && new Set(working.map((file) => file.path)).size === working.length) {
    return {
      files: working,
      from: start === "none" ? "`working` list (no start)" : "`working` list",
    };
  }
  return null;
}

function unavailableReason(detail: unknown): string {
  if (typeof detail === "object" && detail !== null && "unavailable" in detail) {
    return `: ${String((detail as { unavailable: unknown }).unavailable)}`;
  }
  return "";
}

function compareSides(
  ledger: Ledger,
  subject: string,
  item: ProtoItem,
  proto: ProtoComparison,
  core: ComparisonResult,
): void {
  const resolveProto = (side: string | undefined) => (side === "HEAD" ? item.fullHead : side);
  const oid = (side: ComparisonResult["comparison"]["left"]) =>
    side.kind === "commit" ? side.oid : side.kind;
  if (proto.mode === "working") return;
  const pairs: [string, unknown, unknown][] = [
    ["left", resolveProto(proto.left), oid(core.comparison.left)],
    ["right", resolveProto(proto.right), oid(core.comparison.right)],
    ["commits", proto.commits, core.commits],
    ["contained", proto.contained, core.contained],
  ];
  for (const [name, protoValue, coreValue] of pairs) {
    if (protoValue !== coreValue) {
      ledger.add(
        "Comparisons",
        subject,
        `${name}: prototype ${JSON.stringify(protoValue)}, core ${JSON.stringify(coreValue)}`,
      );
    }
  }
}

function compareFiles(
  ledger: Ledger,
  subject: string,
  proto: readonly ListedFile[],
  core: readonly ListedFile[],
): number {
  const key = (file: ListedFile) => `${file.category}\0${file.path}`;
  const protoByKey = new Map(proto.map((file) => [key(file), file]));
  const coreByKey = new Map(core.map((file) => [key(file), file]));
  let mismatches = 0;
  const label = (file: ListedFile) =>
    `${file.category ? `${file.category} ` : ""}${code(file.path)}`;
  for (const [fileKey, file] of protoByKey) {
    const other = coreByKey.get(fileKey);
    if (!other) {
      mismatches += 1;
      ledger.add(
        "Comparisons",
        subject,
        `${label(file)} (${file.status}) listed by the prototype only`,
      );
      continue;
    }
    if (file.status !== other.status || file.oldPath !== other.oldPath) {
      mismatches += 1;
      ledger.add(
        "Comparisons",
        subject,
        `${label(file)}: prototype ${file.status}${file.oldPath ? ` from ${code(file.oldPath)}` : ""}, core ${other.status}${other.oldPath ? ` from ${code(other.oldPath)}` : ""}`,
      );
    }
  }
  for (const [fileKey, file] of coreByKey) {
    if (!protoByKey.has(fileKey)) {
      mismatches += 1;
      ledger.add("Comparisons", subject, `${label(file)} (${file.status}) listed by the core only`);
    }
  }
  if (proto.length !== protoByKey.size || core.length !== coreByKey.size) {
    mismatches += 1;
    ledger.add("Comparisons", subject, "a path is listed twice in one category");
  }
  return mismatches;
}

const OID = /^[0-9a-f]{40,64}$/;
let hashChecks = 0;
let hashFiles = 0;

/** Every file has a `resultHash` of the documented form; working-tree ones match git's. */
function checkResultHashes(ledger: Ledger, subject: string, files: readonly FileChange[]): void {
  for (const file of files) {
    hashFiles += 1;
    const hash = file.resultHash;
    let expected: string | null = null;
    if (file.status === "deleted") expected = `deleted:${file.leftOid ?? "unknown"}`;
    else if (file.right.kind === "commit" || file.right.kind === "index") {
      expected = file.rightOid ?? null;
    }
    if (expected !== null && hash !== expected) {
      ledger.add(
        "Comparisons",
        subject,
        `${code(file.path)}: resultHash ${hash}, expected ${expected}`,
      );
    } else if (!OID.test(hash.replace(/^deleted:/, ""))) {
      ledger.add("Comparisons", subject, `${code(file.path)}: malformed resultHash ${hash}`);
    }
  }
  if (files.length > 0) hashChecks += 1;
}

/** Working-tree `resultHash` values against `git hash-object` run by hand. */
function checkWorkingHashes(
  ledger: Ledger,
  root: string,
  checkoutPath: string,
  files: readonly FileChange[],
): number {
  let checked = 0;
  for (const file of files) {
    if (file.right.kind !== "workingTree" || file.status === "deleted") continue;
    const absolute = join(checkoutPath, file.path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) continue;
    const expected = stat.isSymbolicLink()
      ? gitIn(checkoutPath, ["hash-object", "--stdin"], { input: readlinkSync(absolute) }).trim()
      : gitIn(checkoutPath, ["hash-object", "--", file.path]).trim();
    checked += 1;
    if (expected !== file.resultHash) {
      ledger.add(
        "Comparisons",
        `${code(relativeTo(root, checkoutPath))} review`,
        `${code(file.path)}: resultHash ${file.resultHash}, git hash-object ${expected}`,
      );
    }
  }
  return checked;
}

// ---------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------

function machine(): string {
  const cpu = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" });
  const os = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
  const cpuText = cpu.status === 0 ? cpu.stdout.trim() : arch();
  const osText = os.status === 0 ? `macOS ${os.stdout.trim()}` : `Darwin ${release()}`;
  return `${cpuText}, ${osText} (${arch()})`;
}

function pythonVersion(): string {
  const result = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return (result.stdout || result.stderr).trim();
}

interface ReportInput {
  cases: string[];
  protoCommit: string;
  ledger: Ledger;
  rows: KindRow[];
  core: CoreScan;
  proto: ProtoScan;
  root: string;
}

function report(input: ReportInput): string {
  const { ledger, rows, core, proto, root } = input;
  const lines: string[] = [];
  const unexplained = ledger.unexplained();
  const intended = ledger.differences.filter((difference) => difference.reason !== undefined);
  lines.push("# Prototype parity report", "");
  lines.push(
    `- Run: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")} on ${machine()}`,
    `- Git: ${testGitVersion()} (\`${testGitPath()}\`), global and system config shut out`,
    `- Prototype: \`server.py\` at commit \`${input.protoCommit}\`, run with ${pythonVersion()} on 127.0.0.1`,
    `- Core service: its modules over a session port, local store engine \`${core.storeEngine}\``,
    `- Result: **${unexplained.length === 0 ? "no unexplained differences" : `${unexplained.length} unexplained differences`}**, ${intended.length} intended differences`,
    "",
    "## Fixture",
    "",
    ...input.cases.map((item) => `- ${item}`),
    "",
    "## Summary",
    "",
    "| Area | Items compared | Intended differences | Unexplained |",
    "| --- | --- | --- | --- |",
  );
  for (const area of ["Folder tree", "Checkouts", "Starts", "Timeline", "Comparisons"]) {
    const ofArea = ledger.differences.filter((difference) => difference.area === area);
    lines.push(
      `| ${area} | ${ledger.compared.get(area) ?? 0} | ${ofArea.filter((d) => d.reason).length} | ${ofArea.filter((d) => !d.reason).length} |`,
    );
  }
  lines.push("", "## Checkouts and timeline", "");
  lines.push(
    "| # | Checkout | Repository | Start | Predecessor | Relation | Prototype |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  const names = new Map<string, string>();
  for (const repository of core.repositories) {
    for (const path of repository.checkouts) names.set(path, repository.displayName);
  }
  const protoPaths = new Set(proto.items.map((item) => item.path));
  const byPath = new Map(core.checkouts.map((checkout) => [checkout.path, checkout]));
  for (const entry of core.timeline) {
    const checkout = byPath.get(entry.checkoutPath);
    const start = checkout?.start;
    const startText =
      !start || start.unknown ? "unknown" : `\`${start.commit.slice(0, 10)}\` ${start.observedAt}`;
    lines.push(
      `| ${entry.sequence} | ${code(relativeTo(root, entry.checkoutPath))} | ${names.get(entry.checkoutPath) ?? "?"} | ${startText} | ${entry.predecessor ? code(relativeTo(root, entry.predecessor)) : "–"} | ${entry.relation} | ${protoPaths.has(entry.checkoutPath) ? "found" : "not found"} |`,
    );
  }
  lines.push(
    "",
    `Checkouts reached the window as \`scan.checkout\` ${core.checkoutsBeforeDone ? "before" : "**not** before"} \`scan.done\`. Compared per checkout: kind, branch, HEAD, upstream, origin, repository name, history counts, working counts, start commit and first-observed time.`,
    "",
    ...ledger.checks.map((check) => `- ${check}`),
    "",
    "## Comparison lists",
    "",
    'Each prototype mode against its core kind: `start` → `worktree`, `previous` → `sincePrevious`, the others by name. Compared: the resolved left and right commits, the commit count, "contained", and each file\'s path, category, status and old path. Order is not compared (the core sorts by path).',
    "",
    "| Checkout | Comparison | Outcome | Core files |",
    "| --- | --- | --- | --- |",
  );
  for (const row of rows) {
    lines.push(`| ${code(row.checkout)} | ${row.label} | ${row.outcome} | ${row.files} |`);
  }

  lines.push("", "## Intended differences", "");
  const byReason = new Map<Reason, Difference[]>();
  for (const difference of intended) {
    const reason = difference.reason as Reason;
    byReason.set(reason, [...(byReason.get(reason) ?? []), difference]);
  }
  for (const [reason, differences] of byReason) {
    lines.push(`### ${reason} (${differences.length})`, "", INTENDED[reason], "");
    for (const difference of differences) {
      lines.push(`- ${difference.area}: ${difference.subject}: ${difference.detail}`);
    }
    lines.push("");
  }
  lines.push("## Unexplained differences", "");
  if (unexplained.length === 0) lines.push("None.");
  for (const difference of unexplained) {
    lines.push(`- ${difference.area}: ${difference.subject}: ${difference.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const protoCommit = gitIn(options.prototype, ["rev-parse", "--short", "HEAD"]).trim();
  const { fx, plans, cases } = buildFixture();
  let prototype: Prototype | null = null;
  let core: CoreService | null = null;
  try {
    prototype = await startPrototype(options.prototype);
    const protoScan = await prototype.scan(fx.root);
    core = await startCore(fx.root);

    const ledger = new Ledger();
    const validPaths = new Set(core.scan.checkouts.map((checkout) => checkout.path));
    const stagedRenames = new Map<string, number>();
    for (const checkout of core.scan.checkouts) {
      const working = await core.client.call<ComparisonResult>("comparison.list", {
        checkoutPath: checkout.path,
        kind: "working",
      });
      const renames = working.ok
        ? working.value.files.filter(
            (file) =>
              file.category === "staged" && (file.status === "renamed" || file.status === "copied"),
          ).length
        : 0;
      stagedRenames.set(checkout.path, renames);
    }
    compareFolders(ledger, fx.root, protoScan, core.scan, validPaths);
    checkWalk(ledger, fx, protoScan, core.scan);
    checkWorktreeLists(ledger, fx.root, protoScan, core.scan);
    const sequence = new Map(
      core.scan.timeline.map((entry) => [entry.checkoutPath, entry.sequence]),
    );
    const pairs = compareCheckouts(ledger, fx.root, protoScan, core.scan, stagedRenames).sort(
      (a, b) => (sequence.get(a.core.path) ?? 0) - (sequence.get(b.core.path) ?? 0),
    );
    compareStarts(ledger, pairs);
    compareTimeline(ledger, fx.root, pairs, protoScan, core.scan);
    if (!core.scan.checkoutsBeforeDone) {
      ledger.add("Timeline", "events", "a `scan.checkout` arrived after `scan.done`");
    }
    const rows = await compareComparisons(ledger, pairs, prototype, core.client, plans);

    // Working-tree result hashes against git itself, on every `review` list.
    let workingChecked = 0;
    for (const checkout of core.scan.checkouts) {
      const review = await core.client.call<ComparisonResult>("comparison.list", {
        checkoutPath: checkout.path,
        kind: "review",
      });
      if (review.ok) {
        workingChecked += checkWorkingHashes(ledger, fx.root, checkout.path, review.value.files);
      }
    }
    ledger.add(
      "Comparisons",
      `${hashFiles} files in ${hashChecks} lists`,
      `resultHash set and of the documented form; ${workingChecked} working-tree hashes equal \`git hash-object\``,
      "resultHash",
    );

    const text = report({
      cases,
      protoCommit,
      ledger,
      rows,
      core: core.scan,
      proto: protoScan,
      root: fx.root,
    });
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, text);
    process.stdout.write(`${text}\n`);
    process.stderr.write(`Report written to ${options.out}\n`);
    if (options.keep) process.stderr.write(`Fixture kept at ${fx.root}\n`);
    return ledger.unexplained().length === 0 ? 0 : 1;
  } finally {
    core?.dispose();
    await prototype?.stop();
    if (!options.keep) fx.cleanup();
  }
}

main().then(
  (status) => process.exit(status),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(2);
  },
);
