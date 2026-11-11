/**
 * What a scan finds: its scan roots, the folder tree under each, the repositories and
 * checkouts found from them, and the timeline that orders those checkouts.
 *
 * Every path here is a real (symlink-resolved) absolute path unless the field says it is
 * relative. Commit ids are opaque strings: nothing assumes 40 hex characters.
 */

import type { IpcErrorCode } from "../ipc/result";

/**
 * One folder a scan walks, with the folder tree the walk found under it. A session scans
 * one or more; none lies inside another.
 */
export interface ScanRoot {
  /** Real absolute path; the root's identity. */
  path: string;
  /** Every folder the walk listed, the root first; `relativePath` is relative to `path`. */
  folders: FolderNode[];
}

/**
 * Which checkouts a scan lists besides the ones its walk finds, chosen when the session
 * opens:
 *
 * - `all` (the default): every checkout its repositories' worktree lists report, wherever
 *   it lies;
 * - `inside`: those under a scan root only, so worktrees elsewhere are left out;
 * - `walked`: only the checkouts the walk itself finds.
 */
export const WORKTREE_CHOICES = Object.freeze(["all", "inside", "walked"] as const);
export type WorktreeChoice = (typeof WORKTREE_CHOICES)[number];

/** A folder under a scan root, kept for the folder picker and the tree. */
export interface FolderNode {
  /** The folder's own name (its last path segment). */
  name: string;
  /**
   * Path relative to its scan root, `/`-separated; the node's identity within that root.
   * `""` is the root.
   */
  relativePath: string;
  /** Depth below its scan root; the root itself is 0. */
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
   * `path` of each checkout of the scan in this repository, in timeline order: every one
   * Git's own worktree list reports, wherever it lies, unless the session's
   * `WorktreeChoice` leaves some out.
   */
  checkouts: string[];
}

/** `main` when the checkout's git dir equals the common dir, otherwise `linked`. */
export type CheckoutKind = "main" | "linked";

/** Whether a checkout lies under one of the scan's roots (`inside`) or not (`outside`). */
export type CheckoutLocation = "inside" | "outside";

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
  /**
   * `inside` when it lies under a scan root, whether or not the walk reached it (a
   * worktree inside another checkout, or deeper than the depth limit); `outside` otherwise.
   */
  location: CheckoutLocation;
  /** Git's worktree list says it is locked (`git worktree lock`). */
  locked: boolean;
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
 * Why a scan root cannot be scanned at all, carried in the `invalidRequest` error of
 * `session.open` and `scan.start` as `detail.scanRoot`, with the root itself as
 * `detail.path`:
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
