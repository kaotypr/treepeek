import { relative, sep } from "node:path";
import { MAX_SCAN_DEPTH, SKIP_DIRS } from "../../shared/constants";
import { isWithin } from "../sessions/path-rule";

/**
 * What live refresh watches for one scan (live-refresh design, "What is watched"):
 *
 * - `root`: each scan root, for folders and checkouts that appear or disappear;
 * - `common`: each repository's common dir (or, narrow, its own files, `logs/`, `refs/` and
 *   `worktrees/`), for branch tips (`refs/`, `packed-refs`) and worktrees added or removed
 *   (`worktrees/`);
 * - `gitDir`: a checkout's own git dir (narrow: its own files and `logs/`), for `HEAD`,
 *   `index` and `logs/HEAD`;
 * - `workingTree`: each checkout's folder, for edits, wherever it lies (a worktree outside
 *   every root is watched like one inside).
 */
export type WatchTargetKind = "root" | "common" | "gitDir" | "workingTree";

/** One folder to watch, with what its watcher leaves out. */
export interface WatchTarget {
  readonly kind: WatchTargetKind;
  /** Real absolute path. */
  readonly path: string;
  /**
   * What the target speaks for: the common dir of a `common` target, the git dir of a
   * `gitDir` one, else `path`. Several narrow targets share one owner.
   */
  readonly owner: string;
  /** Whether everything below `path` is watched, or only its direct entries. */
  readonly recursive: boolean;
  /**
   * The folder may not exist yet (a repository with no linked worktree has no
   * `worktrees/`): when it cannot be watched because it is missing, that is no failure.
   */
  readonly optional: boolean;
  /** Folders left out together with everything in them (absolute paths). */
  readonly ignorePaths: readonly string[];
  /** Folder names left out, with their contents, wherever they appear below `path`. */
  readonly ignoreNames: readonly string[];
  /** Folder names whose contents (not the folder itself) are left out wherever they appear. */
  readonly ignoreContentsOf: readonly string[];
  /** Entries more than this many levels below `path` are left out (1 when not recursive). */
  readonly maxDepth: number | null;
}

/** How `watchTargets` lays the watches out. */
export interface WatchLayout {
  /**
   * Watch each git dir's own files without recursion, and `refs/` with it, instead of each
   * common dir as a whole. Only for backends that can all watch a folder on its own.
   */
  readonly narrow?: boolean;
}

/** What watching needs of one checkout of a scan. */
export interface WatchedCheckout {
  /** Real path of the working tree. */
  readonly path: string;
  /** Real path of the checkout's own git dir. */
  readonly gitDir: string;
  /** Real path of the repository's common dir. */
  readonly commonDir: string;
}

/** What watching needs of a scan. */
export interface WatchedScan {
  /** Real paths of the scan's roots (none inside another). */
  readonly scanRoots: readonly string[];
  readonly checkouts: readonly WatchedCheckout[];
}

/**
 * FSEvents leaves out at most 8 paths in the kernel (`FSEventStreamSetExclusionPaths`); past
 * that it leaves out none and the watcher filters every event itself.
 */
const MAX_EXCLUDED_PATHS = 8;

/** A repository's folders that never carry a signal, and change a lot (objects on commit). */
const COMMON_DIR_NOISE = ["objects", "logs/refs", "hooks", "info", "lfs", "modules", "rr-cache"];

/** Skip-list names other than `.git`, in the order the list gives them. */
const SKIPPED = [...SKIP_DIRS].filter((name) => name !== ".git");

/** The subscription key: two scans wanting the same folder for the same reason share one. */
export function targetKey(target: Pick<WatchTarget, "kind" | "path">): string {
  return `${target.kind}:${target.path}`;
}

/**
 * The folders to watch for a scan:
 *
 * - each scan root, honouring the scan's skip list and depth limit; inside a `.git` folder
 *   nothing counts for it (the repository watches carry those signals);
 * - each common dir, without its object store and other noisy folders;
 * - each checkout's git dir when it lies outside its common dir. A main checkout's git dir
 *   is its common dir and a linked worktree's is `<common>/worktrees/<name>`, so normally
 *   the common dir's watch carries their `HEAD`, `index` and `logs/HEAD` already;
 * - each working tree, without `.git` and skip-listed folders, one stream per checkout. A
 *   checkout outside every root needs nothing more: its git dir lies in its repository's
 *   common dir, which is watched already.
 *
 * `narrow` replaces the repository watches with folders watched on their own (see
 * `narrowRepository`). The roots and working trees stay as they are.
 */
export function watchTargets(scan: WatchedScan, layout: WatchLayout = {}): WatchTarget[] {
  const targets = new Map<string, WatchTarget>();
  const add = (target: WatchTarget) => {
    const key = targetKey(target);
    if (!targets.has(key)) targets.set(key, target);
  };
  for (const scanRoot of scan.scanRoots) {
    add({
      kind: "root",
      path: scanRoot,
      owner: scanRoot,
      recursive: true,
      optional: false,
      ignorePaths: [],
      ignoreNames: SKIPPED,
      ignoreContentsOf: [".git"],
      // A folder at the depth limit is read, so a `.git` inside it still makes a checkout.
      maxDepth: MAX_SCAN_DEPTH + 1,
    });
  }
  if (layout.narrow) {
    for (const target of narrowRepository(scan)) add(target);
  } else {
    const commonDirs = new Set(scan.checkouts.map((checkout) => checkout.commonDir));
    for (const commonDir of [...commonDirs].sort()) {
      add({
        kind: "common",
        path: commonDir,
        owner: commonDir,
        recursive: true,
        optional: false,
        ignorePaths: COMMON_DIR_NOISE.map((folder) => `${commonDir}/${folder}`),
        ignoreNames: [],
        ignoreContentsOf: [],
        maxDepth: null,
      });
    }
    for (const checkout of scan.checkouts) {
      if (isWithin(checkout.gitDir, checkout.commonDir)) continue;
      add({
        kind: "gitDir",
        path: checkout.gitDir,
        owner: checkout.gitDir,
        recursive: true,
        optional: false,
        ignorePaths: [`${checkout.gitDir}/objects`, `${checkout.gitDir}/logs/refs`],
        ignoreNames: [],
        ignoreContentsOf: [],
        maxDepth: null,
      });
    }
  }
  for (const checkout of scan.checkouts) {
    add({
      kind: "workingTree",
      path: checkout.path,
      owner: checkout.path,
      recursive: true,
      optional: false,
      ignorePaths: [".git", ...SKIPPED]
        .slice(0, MAX_EXCLUDED_PATHS)
        .map((name) => `${checkout.path}/${name}`),
      ignoreNames: [...SKIP_DIRS],
      ignoreContentsOf: [],
      maxDepth: null,
    });
  }
  return [...targets.values()];
}

/**
 * The repository watches when no backend needs recursion to watch a folder: only the files
 * that carry a signal, so nothing watches an object store at all.
 *
 * For each common dir C:
 * - C itself, without recursion: `HEAD`, `index`, `packed-refs`, and `worktrees/` appearing;
 * - `C/logs`, without recursion: `logs/HEAD` (a bare or new repository may have none);
 * - `C/refs`, recursive, since a branch name can hold `/`;
 * - `C/worktrees`, without recursion: worktrees added or removed (absent until the first).
 *
 * For each checkout whose git dir G is not its common dir (a linked worktree's
 * `C/worktrees/<name>`): G without recursion (`HEAD`, `index`, and `gitdir`, which tells
 * the worktree moved), and `G/logs` without recursion.
 */
function narrowRepository(scan: WatchedScan): WatchTarget[] {
  const targets: WatchTarget[] = [];
  const commonDirs = new Set(scan.checkouts.map((checkout) => checkout.commonDir));
  for (const commonDir of [...commonDirs].sort()) {
    const noise = COMMON_DIR_NOISE.filter((folder) => !folder.includes("/"));
    targets.push(
      flat("common", commonDir, commonDir, {
        ignorePaths: noise.map((folder) => `${commonDir}/${folder}`),
      }),
      flat("common", `${commonDir}/logs`, commonDir, { optional: true }),
      {
        kind: "common",
        path: `${commonDir}/refs`,
        owner: commonDir,
        recursive: true,
        optional: false,
        ignorePaths: [],
        ignoreNames: [],
        ignoreContentsOf: [],
        maxDepth: null,
      },
      flat("common", `${commonDir}/worktrees`, commonDir, { optional: true }),
    );
  }
  for (const checkout of scan.checkouts) {
    if (checkout.gitDir === checkout.commonDir) continue;
    targets.push(
      flat("gitDir", checkout.gitDir, checkout.gitDir),
      flat("gitDir", `${checkout.gitDir}/logs`, checkout.gitDir, { optional: true }),
    );
  }
  return targets;
}

/** A folder watched without recursion: its direct entries only. */
function flat(
  kind: WatchTargetKind,
  path: string,
  owner: string,
  options: { optional?: boolean; ignorePaths?: readonly string[] } = {},
): WatchTarget {
  return {
    kind,
    path,
    owner,
    recursive: false,
    optional: options.optional ?? false,
    ignorePaths: options.ignorePaths ?? [],
    ignoreNames: [],
    ignoreContentsOf: [],
    maxDepth: 1,
  };
}

/**
 * Whether a target's watcher leaves out `path` (an absolute path below the target). The
 * core's `fs.watch` backend filters with it, and a host's backend does the same (the
 * service entry exports it), so both drop what `@parcel/watcher`'s globs drop.
 */
export function isIgnored(target: WatchTarget, path: string): boolean {
  if (!isWithin(path, target.path) || path === target.path) return false;
  if (target.ignorePaths.some((ignored) => isWithin(path, ignored))) return true;
  const segments = relative(target.path, path).split(sep);
  if (target.maxDepth !== null && segments.length > target.maxDepth) return true;
  const last = segments.length - 1;
  return segments.some(
    (segment, index) =>
      target.ignoreNames.includes(segment) ||
      (index < last && target.ignoreContentsOf.includes(segment)),
  );
}

/**
 * The target's ignore list in `@parcel/watcher`'s terms: absolute paths (which FSEvents
 * also excludes in the kernel, up to 8) and globs matched against paths relative to the
 * watched folder.
 */
export function parcelIgnore(target: WatchTarget): string[] {
  const ignore: string[] = [...target.ignorePaths];
  const names = target.ignoreNames;
  if (names.length > 0) {
    const group = names.length === 1 ? (names[0] ?? "") : `{${names.join(",")}}`;
    ignore.push(`**/${group}`, `**/${group}/**`);
  }
  for (const name of target.ignoreContentsOf) ignore.push(`**/${name}/**`);
  if (target.maxDepth !== null) {
    // More than `maxDepth` segments.
    ignore.push(`${Array.from({ length: target.maxDepth + 1 }, () => "*").join("/")}/**`);
  }
  return ignore;
}
