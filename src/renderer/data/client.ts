/**
 * The renderer's calls, as TanStack Query wants them: a failed `Result` becomes a thrown
 * `IpcFailure`, so queries and mutations carry the core's error code and message.
 */

import type { TreepeekApi } from "../../shared/ipc/api";
import type { IpcError, IpcErrorCode, Result } from "../../shared/ipc/result";

export class IpcFailure extends Error {
  readonly code: IpcErrorCode;
  readonly detail: unknown;

  constructor(error: IpcError) {
    super(error.message);
    this.name = "IpcFailure";
    this.code = error.code;
    this.detail = error.detail;
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new IpcFailure(result.error);
}

export function isIpcFailure(error: unknown, code?: IpcErrorCode): error is IpcFailure {
  return error instanceof IpcFailure && (code === undefined || error.code === code);
}

/** Calls to the core service, over this window's port. */
export function core(): TreepeekApi["core"] {
  return window.treepeek.core;
}

/** Calls to main: native actions and settings. */
export function main(): TreepeekApi["main"] {
  return window.treepeek.main;
}

let requestCounter = 0;

/** A request id for a cancellable call, unique within this window. */
export function newRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestCounter}`;
}
