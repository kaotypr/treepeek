/**
 * What a scan finds: the scan root, its folder tree, the repositories and checkouts beneath
 * it, and the timeline that orders those checkouts.
 *
 * Every path here is a real (symlink-resolved) absolute path unless the field says it is
 * relative. Commit ids are opaque strings: nothing assumes 40 hex characters.
 */

import type { IpcErrorCode } from "../ipc/result";

/** The folder a window scans. One per window. */
export interface ScanRoot {
  /** Real absolute path; the scan root's identity. */
  path: string;
}

/** A folder under the scan root, kept for the folder picker and the tree. */
export interface FolderNode {
  /** The folder's own name (its last path segment). */
  name: string;
  /** Path relative to the scan root, `/`-separated; the node's identity. `""` is the root. */
  relativePath: string;
  /** Depth below the scan root; the root itself is 0. */
  depth: number;
  /** `relativePath` of the parent folder, or `null` for the scan root. */
  parent: string | null;
  /**
   * `path` of the checkout this folder holds (it has a `.git` file or folder), or `null`.
   * The scan sends the folder tree before it validates the candidates, so a folder whose
   * path gets no `scan.checkout` before `scan.done` (a stale `.git` file, say) turned out
   * not to be a checkout.
   */
  checkoutPath: string | null;
}

/** All checkouts sharing one Git common directory. */
export interface Repository {
  /** Real path of the common dir (`git rev-parse --git-common-dir`); the identity. */
  commonDir: string;
  /**
   * The main checkout's folder name. For a bare common dir (`name.git`), its name without
   * `.git`.
   */
  displayName: string;
  /**
   * `path` of each checkout that Git's own worktree list reports and that lies under the
   * scan root. Checkouts outside the root are not listed.
   */
  checkouts: string[];
}

/** `main` when the checkout's git dir equals the common dir, otherwise `linked`. */
export type CheckoutKind = "main" | "linked";

/** The branch's upstream, from `status --porcelain=v2 --branch`. */
export interface Upstream {
  /** The upstream ref, for example `origin/main`. */
  ref: string;
  /** Commits on HEAD that the upstream does not have. */
  ahead: number;
  /** Commits on the upstream that HEAD does not have. */
  behind: number;
}

/** Where a start came from: the HEAD reflog, or the user's override (which wins). */
export type StartSource = "reflog" | "override";

/**
 * A known start: the oldest HEAD reflog entry that is still an ancestor of HEAD, or the
 * user's override. Labelled "first observed", never "created".
 */
export interface KnownStart {
  /** Full commit id. */
  commit: string;
  /** ISO 8601 timestamp of the reflog entry this start was observed in. */
  observedAt: string;
  source: StartSource;
  unknown?: never;
}

/** No start: the reflog expired and there is no override. */
export interface UnknownStart {
  unknown: true;
}

/**
 * The start of a checkout. Unknown is a real value: without a start, history counts and the
 * `worktree`, `incoming` and `sincePrevious` comparisons are unavailable.
 */
export type Start = KnownStart | UnknownStart;

/** Whether a start is known. */
export function isKnownStart(start: Start): start is KnownStart {
  return start.unknown !== true;
}

/** Uncommitted changes in a checkout, from `status --porcelain=v2`. */
export interface WorkingCounts {
  staged: number;
  unstaged: number;
  untracked: number;
}

/** Commits and changed files from the start to HEAD. */
export interface HistoryCounts {
  /** `rev-list --count start..HEAD`. */
  commits: number;
  /** Paths in `diff --name-only start HEAD`. */
  files: number;
}

/** One working tree: the main checkout or a linked worktree. */
export interface Checkout {
  /** Real absolute path of its top level; the identity. */
  path: string;
  kind: CheckoutKind;
  /** Branch name, or `null` when HEAD is detached. */
  branch: string | null;
  /** Full HEAD commit id, or `null` on an unborn branch (a repository without commits). */
  head: string | null;
  /** The upstream and ahead/behind, or `null` when the branch has none. */
  upstream: Upstream | null;
  /** URL of the remote `origin`, or `null` when there is none. */
  originUrl: string | null;
  start: Start;
  working: WorkingCounts;
  /** Commits and files from `start` to HEAD, or `null` when the start is unknown. */
  history: HistoryCounts | null;
}

/**
 * A checkout as a reviewable unit across time. Review marks and start overrides attach to
 * this identity, not to a bare path; its id is a hash of the three fields.
 */
export interface WorktreeIdentity {
  commonDir: string;
  checkoutPath: string;
  /** The start commit, or `null` when the start is unknown (hashed as `∅`). */
  startCommit: string | null;
}

/**
 * How a checkout relates to its predecessor in the same repository.
 *
 * - `first`: no predecessor.
 * - `after`: the predecessor's current HEAD is an ancestor of this checkout's start.
 * - `parallel`: otherwise.
 */
export type Relation = "first" | "after" | "parallel";

/** One checkout's place in the scan's timeline. */
export interface TimelineEntry {
  /** Position `1…n` across the whole scan, ordered by `start.observedAt`. */
  sequence: number;
  /** `path` of the checkout. */
  checkoutPath: string;
  /** `commonDir` of the checkout's repository. */
  commonDir: string;
  /**
   * `path` of the previous checkout of the same repository in timeline order, or `null`
   * when there is none.
   */
  predecessor: string | null;
  relation: Relation;
}

/**
 * Why a window's folder cannot be scanned at all, carried in the `invalidRequest` error of
 * `session.open` and `scan.start` as `detail.scanRoot`:
 *
 * - `missing`: it does not exist (any more);
 * - `notAFolder`: it is a file;
 * - `unreadable`: its entries cannot be listed (permissions, or macOS privacy controls).
 */
export const SCAN_ROOT_PROBLEMS = Object.freeze(["missing", "notAFolder", "unreadable"] as const);
export type ScanRootProblem = (typeof SCAN_ROOT_PROBLEMS)[number];

/**
 * A folder with a `.git` marker that the scan could not read as a checkout for a reason the
 * person should see: Git's `safe.directory` refusal (`dubiousOwnership`), a timeout, or an
 * error. Folders that are simply not checkouts (a stale `.git` file) are not problems.
 */
export interface ScanProblem {
  /** Real absolute path of the folder. */
  path: string;
  code: IpcErrorCode;
  message: string;
}
