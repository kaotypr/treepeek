/**
 * Limits and fixed values shared by every process. Sizes are in bytes; 1 MB here is
 * 1,048,576 bytes.
 */

const MB = 1024 * 1024;

/** The scan walk stops going deeper below this depth (the scan root is depth 0). */
export const MAX_SCAN_DEPTH = 7;

/** Folder names the scan walk never enters. A constant for now; it may become a setting. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  ".open-next",
  ".wrangler",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
]);

/** The diff pipeline's size limits, confirmed by the viewer trial (docs/decisions/diff-viewer.md). */
export const DIFF_LIMITS = Object.freeze({
  /** Patch bytes read; beyond this the patch is truncated at a hunk boundary. */
  patchBytes: 5 * MB,
  /** Full content per side, by size; beyond this `left`/`right` are omitted. */
  contentBytes: 2 * MB,
  /** Full content per side, by lines; beyond this `left`/`right` are omitted. */
  contentLines: 50_000,
  /** Syntax highlighting per side, by size; beyond this highlighting is off. */
  highlightBytes: 1 * MB,
  /** Syntax highlighting per side, by lines; beyond this highlighting is off. */
  highlightLines: 20_000,
  /** An untracked file is binary when this many leading bytes contain a NUL byte. */
  binarySniffBytes: 8 * 1024,
});

/** At most this many git processes run at once, across every session. */
export const GIT_CONCURRENCY = 6;

/** Time limit for one git call, unless the caller sets its own. */
export const GIT_TIMEOUT_MS = 20_000;

/** Time limit for each git call a scan makes. */
export const GIT_SCAN_TIMEOUT_MS = 10_000;

/**
 * Bytes read from one git call's output, unless the caller sets its own (diffs use
 * `DIFF_LIMITS`). Past it the process is killed and the call fails with `outputTooLarge`.
 */
export const GIT_MAX_OUTPUT_BYTES = 8 * MB;
