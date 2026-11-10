import { relative, sep } from "node:path";
import { MAX_SCAN_DEPTH, SKIP_DIRS } from "../../shared/constants";
import { isWithin } from "../sessions/path-rule";

/**
 * What live refresh watches for one scan (live-refresh design, "What is watched"):
 *
 * - `root`: the scan root, for folders and checkouts that appear or disappear;
 * - `common`: each repository's common dir, for branch tips (`refs/`, `packed-refs`) and
 *   worktrees added or removed (`worktrees/`);
 * - `gitDir`: a checkout's own git dir, for `HEAD`, `index` and `logs/HEAD`;
 * - `workingTree`: each checkout's folder, for edits.
 */
export type WatchTargetKind = "root" | "common" | "gitDir" | "workingTree";

/** One folder watched recursively, with what its watcher leaves out. */
export interface WatchTarget {
  readonly kind: WatchTargetKind;
  /** Real absolute path. */
  readonly path: string;
  /** Folders left out together with everything in them (absolute paths). */
  readonly ignorePaths: readonly string[];
  /** Folder names left out, with their contents, wherever they appear below `path`. */
  readonly ignoreNames: readonly string[];
  /** Folder names whose contents (not the folder itself) are left out wherever they appear. */
  readonly ignoreContentsOf: readonly string[];
  /** Entries more than this many levels below `path` are left out. */
  readonly maxDepth: number | null;
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
  readonly scanRoot: string;
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
 * - the scan root, honouring the scan's skip list and depth limit; inside a `.git` folder
 *   nothing counts for it (the repository watches carry those signals);
 * - each common dir, without its object store and other noisy folders;
 * - each checkout's git dir when it lies outside its common dir. A main checkout's git dir
 *   is its common dir and a linked worktree's is `<common>/worktrees/<name>`, so normally
 *   the common dir's watch carries their `HEAD`, `index` and `logs/HEAD` already;
 * - each working tree, without `.git` and skip-listed folders, one stream per checkout.
 */
export function watchTargets(scan: WatchedScan): WatchTarget[] {
  const targets = new Map<string, WatchTarget>();
  const add = (target: WatchTarget) => {
    const key = targetKey(target);
    if (!targets.has(key)) targets.set(key, target);
  };
  add({
    kind: "root",
    path: scan.scanRoot,
    ignorePaths: [],
    ignoreNames: SKIPPED,
    ignoreContentsOf: [".git"],
    // A folder at the depth limit is read, so a `.git` inside it still makes a checkout.
    maxDepth: MAX_SCAN_DEPTH + 1,
  });
  const commonDirs = new Set(scan.checkouts.map((checkout) => checkout.commonDir));
  for (const commonDir of [...commonDirs].sort()) {
    add({
      kind: "common",
      path: commonDir,
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
      ignorePaths: [`${checkout.gitDir}/objects`, `${checkout.gitDir}/logs/refs`],
      ignoreNames: [],
      ignoreContentsOf: [],
      maxDepth: null,
    });
  }
  for (const checkout of scan.checkouts) {
    add({
      kind: "workingTree",
      path: checkout.path,
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

/** Whether a target's watcher leaves out `path` (an absolute path below the target). */
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
