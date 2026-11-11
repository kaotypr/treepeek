import * as v from "valibot";
import { CHANGE_KINDS, REFRESH_PAUSE_REASONS } from "../domain/change";
import { COMPARISON_KINDS } from "../domain/compare";
import { FILE_REVIEW_STATES } from "../domain/review";
import { IPC_ERROR_CODES } from "./result";

/**
 * Valibot schemas for the domain types that cross the window's port (`shared/domain`). The
 * core service parses every event payload with them before it leaves, and the preload parses
 * it again on arrival. A test keeps each schema and its domain type in step.
 */

/** Longest path accepted from the renderer; far above macOS's `PATH_MAX` of 1,024. */
export const MAX_PATH_LENGTH = 4096;

/** An absolute path sent by the renderer: not empty, bounded. Handlers check the rest. */
export const PathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_LENGTH));

/** Longest ref accepted from the renderer (a base ref or a start), as the git layer checks. */
export const MAX_REF_LENGTH = 200;

/** A commit-ish typed by a person: not empty, bounded. The git layer checks the rest. */
export const RefSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REF_LENGTH));

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));

export const FolderNodeSchema = v.object({
  name: v.string(),
  relativePath: v.string(),
  depth: Count,
  parent: v.nullable(v.string()),
  checkoutPath: v.nullable(v.string()),
});

export const StartSchema = v.union([
  v.object({
    commit: v.string(),
    observedAt: v.string(),
    source: v.picklist(["reflog", "override"]),
  }),
  v.object({ unknown: v.literal(true) }),
]);

export const ScanRootSchema = v.object({
  path: v.string(),
  folders: v.array(FolderNodeSchema),
});

export const CheckoutSchema = v.object({
  path: v.string(),
  kind: v.picklist(["main", "linked"]),
  location: v.picklist(["inside", "outside"]),
  locked: v.boolean(),
  branch: v.nullable(v.string()),
  head: v.nullable(v.string()),
  upstream: v.nullable(v.object({ ref: v.string(), ahead: Count, behind: Count })),
  originUrl: v.nullable(v.string()),
  start: StartSchema,
  working: v.object({ staged: Count, unstaged: Count, untracked: Count }),
  history: v.nullable(v.object({ commits: Count, files: Count })),
});

export const RepositorySchema = v.object({
  commonDir: v.string(),
  displayName: v.string(),
  checkouts: v.array(v.string()),
});

export const TimelineEntrySchema = v.object({
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
  checkoutPath: v.string(),
  commonDir: v.string(),
  predecessor: v.nullable(v.string()),
  relation: v.picklist(["first", "after", "parallel"]),
});

export const ScanProblemSchema = v.object({
  path: v.string(),
  code: v.picklist(IPC_ERROR_CODES),
  message: v.string(),
});

export const ComparisonKindSchema = v.picklist(COMPARISON_KINDS);

export const ContentSideSchema = v.variant("kind", [
  v.object({ kind: v.literal("commit"), oid: v.string() }),
  v.object({ kind: v.literal("index") }),
  v.object({ kind: v.literal("workingTree") }),
  v.object({ kind: v.literal("empty") }),
]);

export const ComparisonSchema = v.object({
  kind: ComparisonKindSchema,
  left: ContentSideSchema,
  right: ContentSideSchema,
});

export const FileStatusSchema = v.picklist([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typeChanged",
  "untracked",
]);

export const FileCategorySchema = v.picklist(["staged", "unstaged", "untracked"]);

export const FileChangeSchema = v.object({
  path: v.string(),
  oldPath: v.exactOptional(v.string()),
  status: FileStatusSchema,
  category: v.exactOptional(FileCategorySchema),
  left: ContentSideSchema,
  right: ContentSideSchema,
  leftOid: v.exactOptional(v.string()),
  rightOid: v.exactOptional(v.string()),
  resultHash: v.string(),
  binary: v.boolean(),
});

export const ComparisonResultSchema = v.object({
  comparison: ComparisonSchema,
  files: v.array(FileChangeSchema),
  commits: v.exactOptional(Count),
  contained: v.exactOptional(v.boolean()),
  note: v.exactOptional(v.string()),
});

export const HunkLineSchema = v.object({
  kind: v.picklist(["context", "add", "remove", "noNewline"]),
  text: v.string(),
  oldNo: v.nullable(Count),
  newNo: v.nullable(Count),
});

export const HunkSchema = v.object({
  oldStart: Count,
  oldLines: Count,
  newStart: Count,
  newLines: Count,
  header: v.string(),
  lines: v.array(HunkLineSchema),
});

export const FileDiffSchema = v.object({
  path: v.string(),
  oldPath: v.exactOptional(v.string()),
  status: FileStatusSchema,
  binary: v.boolean(),
  hunks: v.array(HunkSchema),
  left: v.nullable(v.string()),
  right: v.nullable(v.string()),
  stats: v.object({ added: Count, removed: Count }),
  limits: v.object({
    patchTruncated: v.boolean(),
    contentOmitted: v.boolean(),
    highlightOff: v.boolean(),
  }),
  resultHash: v.string(),
});

export const FileReviewSchema = v.object({
  path: v.string(),
  state: v.picklist(FILE_REVIEW_STATES),
  viewedHash: v.exactOptional(v.string()),
  earlierAvailable: v.exactOptional(v.boolean()),
});

export const ReviewStatusSchema = v.object({
  checkoutPath: v.string(),
  worktreeId: v.string(),
  total: Count,
  viewed: Count,
  changedSinceViewed: Count,
  partialScope: v.boolean(),
  files: v.array(FileReviewSchema),
});

export const PreviousMarkSchema = v.object({
  path: v.string(),
  resultHash: v.nullable(v.string()),
});

export const ChangeKindSchema = v.picklist(CHANGE_KINDS);

export const RefreshPauseSchema = v.object({
  path: v.string(),
  reason: v.picklist(REFRESH_PAUSE_REASONS),
  since: v.number(),
});
