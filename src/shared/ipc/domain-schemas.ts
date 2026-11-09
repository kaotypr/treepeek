import * as v from "valibot";
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

export const CheckoutSchema = v.object({
  path: v.string(),
  kind: v.picklist(["main", "linked"]),
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
