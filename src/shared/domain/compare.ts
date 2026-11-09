/**
 * Comparisons: two content sides, and the files that differ between them.
 */

/**
 * The comparison kinds.
 *
 * | Kind | Left → right |
 * | --- | --- |
 * | `review` (default) | start → working tree |
 * | `worktree` | start or override → HEAD |
 * | `working` | HEAD → working tree, split into staged, unstaged and untracked |
 * | `incoming` | predecessor HEAD → start |
 * | `sincePrevious` | predecessor HEAD → HEAD |
 * | `base` | merge-base(ref, HEAD) → HEAD |
 * | `upstream` | merge-base(upstream, HEAD) → HEAD |
 * | `sinceViewed` | the file's viewed content → its current content |
 */
export type ComparisonKind =
  | "review"
  | "worktree"
  | "working"
  | "incoming"
  | "sincePrevious"
  | "base"
  | "upstream"
  | "sinceViewed";

/** Every comparison kind, in the order the design lists them. */
export const COMPARISON_KINDS: readonly ComparisonKind[] = Object.freeze([
  "review",
  "worktree",
  "working",
  "incoming",
  "sincePrevious",
  "base",
  "upstream",
  "sinceViewed",
]);

/** The kinds `comparison.list` answers; `sinceViewed` is one file's comparison (review marks). */
export type ListableComparisonKind = Exclude<ComparisonKind, "sinceViewed">;

export const LISTABLE_COMPARISON_KINDS: readonly ListableComparisonKind[] = Object.freeze(
  COMPARISON_KINDS.filter((kind): kind is ListableComparisonKind => kind !== "sinceViewed"),
);

/**
 * One side of a comparison.
 *
 * - `commit`: a tree in the object database
 * - `index`: the staging area
 * - `workingTree`: files on disk, including untracked ones
 * - `empty`: nothing (the left side of an added or untracked file)
 */
export type ContentSide =
  | { kind: "commit"; oid: string }
  | { kind: "index" }
  | { kind: "workingTree" }
  | { kind: "empty" };

/** A pair of content sides to diff, identified by its kind plus the resolved sides. */
export interface Comparison {
  kind: ComparisonKind;
  left: ContentSide;
  right: ContentSide;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked";

/** Which part of the `working` comparison a file belongs to. */
export type FileCategory = "staged" | "unstaged" | "untracked";

/** One changed path within a comparison, identified by `(comparison, path)`. */
export interface FileChange {
  /** Path on the right side: repository-relative, `/`-separated. */
  path: string;
  /** Path on the left side, for renames and copies. */
  oldPath?: string;
  status: FileStatus;
  /** Only in the `working` comparison. */
  category?: FileCategory;
  left: ContentSide;
  right: ContentSide;
  /** Blob id on the left, when that side is a commit or the index. */
  leftOid?: string;
  /** Blob id on the right, when that side is a commit or the index. */
  rightOid?: string;
  /**
   * Identity of the right-side content: the blob id (commit or index side), the blob id Git
   * would give the file (working tree side), or `deleted:<leftOid>` for a deletion.
   */
  resultHash: string;
  /**
   * Detected from the patch or a NUL byte. A comparison list reads no blobs: it sniffs
   * working-tree content (the first `DIFF_LIMITS.binarySniffBytes`) and leaves blob sides
   * `false` until `diff.file` reads their patch.
   */
  binary: boolean;
}

/**
 * A comparison's file list, as `comparison.list` returns it.
 *
 * - `files`: one entry per path (in `working`, per path and category), sorted by path; in
 *   `working`, staged first, then unstaged, then untracked.
 * - `commits`: commits from the left commit to HEAD (to the start for `incoming`); every
 *   kind but `working` reports it once its left side is a commit.
 * - `contained`: whether HEAD is an ancestor of the compared ref (the start, the previous
 *   checkout's HEAD, the base ref or the upstream).
 * - `note`: a sentence for the person, such as why the list is partial.
 */
export interface ComparisonResult {
  comparison: Comparison;
  files: FileChange[];
  commits?: number;
  contained?: boolean;
  note?: string;
}
