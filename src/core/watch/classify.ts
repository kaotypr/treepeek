import { dirname, relative, sep } from "node:path";
import { MAX_SCAN_DEPTH, SKIP_DIRS } from "../../shared/constants";
import type { ChangeKind } from "../../shared/domain/change";
import type { WatchedCheckout, WatchedScan } from "./targets";

/** Every path live refresh knows, from the scans of every window. */
export interface WatchIndex {
  /** By working-tree path. */
  readonly checkouts: ReadonlyMap<string, WatchedCheckout>;
  /** Working-tree path by the checkout's git dir. */
  readonly gitDirs: ReadonlyMap<string, string>;
  readonly commonDirs: ReadonlySet<string>;
  readonly scanRoots: ReadonlySet<string>;
}

/** What one filesystem event means. */
export interface Classified {
  kind: ChangeKind;
  /** For `head`, `index`, `reflog` and `workingTree`: the checkout it belongs to. */
  checkoutPath?: string;
  /** For `refs`, and `structure` seen in a repository: the repository's common dir. */
  commonDir?: string;
  /** For `structure` seen in a scan root: the deepest scan root holding the path. */
  scanRoot?: string;
  /** For `refs`: the ref that moved (`refs/heads/x`), when the path names one. */
  ref?: string;
}

export function buildWatchIndex(scans: Iterable<WatchedScan>): WatchIndex {
  const checkouts = new Map<string, WatchedCheckout>();
  const gitDirs = new Map<string, string>();
  const commonDirs = new Set<string>();
  const scanRoots = new Set<string>();
  for (const scan of scans) {
    for (const scanRoot of scan.scanRoots) scanRoots.add(scanRoot);
    for (const checkout of scan.checkouts) {
      checkouts.set(checkout.path, checkout);
      gitDirs.set(checkout.gitDir, checkout.path);
      commonDirs.add(checkout.commonDir);
    }
  }
  return { checkouts, gitDirs, commonDirs, scanRoots };
}

/** The files of a checkout's git dir that carry a signal, by their path in it. */
const GIT_DIR_FILES: Readonly<Record<string, ChangeKind>> = Object.freeze({
  HEAD: "head",
  index: "index",
  "logs/HEAD": "reflog",
});

/**
 * Maps an event's path to the checkout or repository it concerns and what changed there
 * (live-refresh design, "From event to UI", step 1). Returns `null` for paths that carry
 * no signal: lock files, objects, other reflogs, skip-listed folders, and anything outside
 * every scan.
 *
 * Git dirs and common dirs are tried first, because a main checkout's `.git` folder lies
 * inside its working tree.
 */
export function classify(path: string, index: WatchIndex): Classified | null {
  if (path.endsWith(".lock")) return null;

  const gitDir = deepest(index.gitDirs, path);
  if (gitDir !== null && path !== gitDir) {
    const kind = GIT_DIR_FILES[toPosix(relative(gitDir, path))];
    const checkoutPath = index.gitDirs.get(gitDir);
    if (kind && checkoutPath !== undefined) return { kind, checkoutPath };
  }

  const commonDir = deepest(index.commonDirs, path);
  if (commonDir !== null) return inCommonDir(commonDir, path, index);

  const checkoutPath = deepest(index.checkouts, path);
  if (checkoutPath !== null) {
    if (path === checkoutPath) return structureIn(path, index);
    const segments = relative(checkoutPath, path).split(sep);
    if (segments[0] === ".git") return segments.length === 1 ? structureIn(path, index) : null;
    if (segments.some((segment) => SKIP_DIRS.has(segment))) return null;
    return { kind: "workingTree", checkoutPath };
  }

  return structureIn(path, index);
}

function inCommonDir(commonDir: string, path: string, index: WatchIndex): Classified | null {
  if (path === commonDir) return structureIn(path, index) ?? { kind: "structure", commonDir };
  const rel = toPosix(relative(commonDir, path));
  if (rel === "packed-refs" || rel === "refs") return { kind: "refs", commonDir };
  if (rel.startsWith("refs/")) {
    // `refs/heads` alone names a folder, not a ref.
    return rel.split("/").length >= 3
      ? { kind: "refs", commonDir, ref: rel }
      : { kind: "refs", commonDir };
  }
  if (rel === "worktrees") return { kind: "structure", commonDir };
  if (rel.startsWith("worktrees/")) {
    const segments = rel.split("/");
    const admin = `${commonDir}/worktrees/${segments[1] ?? ""}`;
    // A worktree's admin folder appearing, going, or being pointed elsewhere (`gitdir`);
    // inside a known one, only `HEAD`, `index` and `logs/HEAD` count (above).
    if (segments.length === 2 || segments[2] === "gitdir" || !index.gitDirs.has(admin)) {
      return { kind: "structure", commonDir };
    }
  }
  return null;
}

/** A folder or checkout appearing or going inside a scan root, within the walk's reach. */
function structureIn(path: string, index: WatchIndex): Classified | null {
  const scanRoot = deepest(index.scanRoots, path);
  if (scanRoot === null) return null;
  if (path === scanRoot) return { kind: "structure", scanRoot };
  const segments = relative(scanRoot, path).split(sep);
  if (segments.length > MAX_SCAN_DEPTH + 1) return null;
  const last = segments.length - 1;
  for (const [position, segment] of segments.entries()) {
    // The walk never enters a skip-listed folder, nor the inside of a `.git` folder.
    if (segment === ".git" ? position < last : SKIP_DIRS.has(segment)) return null;
  }
  return { kind: "structure", scanRoot };
}

/**
 * The deepest of `folders` that is `path` or holds it. Walks up from `path`, so a storm of
 * events costs a few lookups each however many checkouts are watched.
 */
function deepest(folders: { has(path: string): boolean }, path: string): string | null {
  for (let current = path; ; current = dirname(current)) {
    if (folders.has(current)) return current;
    if (dirname(current) === current) return null;
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
