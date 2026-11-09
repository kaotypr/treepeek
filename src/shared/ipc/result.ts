import * as v from "valibot";

/** Error codes every IPC call can return (architecture/ipc.md, "Conventions"). */
export const IPC_ERROR_CODES = [
  "invalidRequest",
  "notInScan",
  "gitNotFound",
  "gitTooOld",
  "notARepository",
  /** Git's `safe.directory` refusal: shown to the user and never overridden. */
  "dubiousOwnership",
  "refNotFound",
  "timeout",
  "outputTooLarge",
  "cancelled",
  "coreUnavailable",
  "internal",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  detail?: unknown;
}

/** Errors are values: no call ever throws across a process boundary. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(code: IpcErrorCode, message: string, detail?: unknown): Result<T> {
  const error: IpcError = detail === undefined ? { code, message } : { code, message, detail };
  return { ok: false, error };
}

export const IpcErrorSchema = v.object({
  code: v.picklist(IPC_ERROR_CODES),
  message: v.string(),
  detail: v.optional(v.unknown()),
});
