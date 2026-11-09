import type { IpcError, IpcErrorCode } from "../../shared/ipc/result";

/** Stderr kept on an error: enough for the message Git printed, never unbounded. */
const STDERR_DETAIL_CHARS = 2_000;

/**
 * How a git process ended badly: its exit code, or what stopped it.
 *
 * - `timeout`: it ran past its time limit and was killed.
 * - `outputTooLarge`: its output passed the byte cap and it was killed.
 * - `cancelled`: its `AbortSignal` fired and it was killed.
 * - `signal`: something else killed it.
 * - `spawn`: it could not be started (the binary is missing or not executable).
 */
export type GitFailure = number | "timeout" | "outputTooLarge" | "cancelled" | "signal" | "spawn";

export interface GitErrorDetail {
  /** The process's exit code, or `null` when it did not exit by itself. */
  exitCode: number | null;
  /** The start of what Git printed to stderr (`LC_ALL=C`, so stable English). */
  stderr: string;
}

/**
 * Every failure of the git layer. `code` is the IPC error code a handler returns for it,
 * so `asIpcError` can turn any of them into an `IpcError` without guessing.
 */
export class GitError extends Error {
  readonly code: IpcErrorCode;
  readonly detail: GitErrorDetail;

  constructor(code: IpcErrorCode, message: string, detail: Partial<GitErrorDetail> = {}) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.detail = {
      exitCode: detail.exitCode ?? null,
      stderr: (detail.stderr ?? "").slice(0, STDERR_DETAIL_CHARS),
    };
  }

  toIpcError(): IpcError {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/** Git printed output this layer does not understand; a bug or an unsupported Git. */
export class GitParseError extends GitError {
  constructor(what: string, reason: string) {
    super("internal", `Could not read the output of ${what}: ${reason}`);
    this.name = "GitParseError";
  }
}

const DUBIOUS_OWNERSHIP = [
  /detected dubious ownership in repository/i,
  // Git 2.35.2 to 2.35.x, before the wording changed.
  /unsafe repository \('.*' is owned by someone else\)/i,
];

const NOT_A_REPOSITORY = [
  /not a git repository/i,
  /cannot change to '/i,
  /this operation must be run in a work tree/i,
];

const REF_NOT_FOUND = [
  /unknown revision or path not in the working tree/i,
  /bad revision '/i,
  /fatal: bad object /i,
  /not a valid object name/i,
  /invalid object name/i,
  /needed a single revision/i,
  /no upstream configured for branch/i,
  /no such branch/i,
];

/** The IPC error code for a git failure, from how it ended and what it printed. */
export function classifyGitFailure(failure: GitFailure, stderr: string): IpcErrorCode {
  switch (failure) {
    case "timeout":
    case "outputTooLarge":
    case "cancelled":
      return failure;
    case "spawn":
      return "gitNotFound";
    case "signal":
      return "internal";
  }
  if (DUBIOUS_OWNERSHIP.some((pattern) => pattern.test(stderr))) return "dubiousOwnership";
  if (NOT_A_REPOSITORY.some((pattern) => pattern.test(stderr))) return "notARepository";
  if (REF_NOT_FOUND.some((pattern) => pattern.test(stderr))) return "refNotFound";
  return "internal";
}

const MESSAGES: Partial<Record<IpcErrorCode, string>> = {
  dubiousOwnership:
    "Git refuses to open this repository because it is owned by another user (safe.directory). Treepeek does not override that.",
  notARepository: "This folder is not a Git repository.",
  refNotFound: "Git could not find that commit or ref.",
  timeout: "Git took too long and was stopped.",
  outputTooLarge: "Git's output was too large and was stopped.",
  cancelled: "The Git command was cancelled.",
  gitNotFound: "Git could not be started.",
};

/** Builds the IPC error for a git failure (exit code or stop reason) and its stderr. */
export function toIpcError(failure: GitFailure, stderr: string): IpcError {
  const code = classifyGitFailure(failure, stderr);
  const exitCode = typeof failure === "number" ? failure : null;
  const message =
    MESSAGES[code] ??
    (exitCode === null ? `Git stopped (${failure}).` : `Git failed with exit code ${exitCode}.`);
  return {
    code,
    message,
    detail: { exitCode, stderr: stderr.slice(0, STDERR_DETAIL_CHARS) } satisfies GitErrorDetail,
  };
}

/** The `GitError` for a failure, carrying the mapped code and message. */
export function gitFailure(failure: GitFailure, stderr: string): GitError {
  const ipc = toIpcError(failure, stderr);
  return new GitError(ipc.code, ipc.message, {
    exitCode: typeof failure === "number" ? failure : null,
    stderr,
  });
}

/**
 * Turns anything a git operation threw into the IPC error a handler returns: a `GitError`
 * keeps its code, an abort becomes `cancelled`, anything else is `internal`.
 */
export function asIpcError(error: unknown): IpcError {
  if (error instanceof GitError) return error.toIpcError();
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "cancelled", message: MESSAGES.cancelled ?? "Cancelled" };
  }
  return { code: "internal", message: "An internal error occurred while running Git." };
}
