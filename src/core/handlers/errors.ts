import { err, type Result } from "../../shared/ipc/result";
import { asIpcError } from "../git/errors";

/** The error result for anything a handler caught: a `GitError` keeps its code. */
export function failWith(error: unknown): Result<never> {
  const ipc = asIpcError(error);
  return err(ipc.code, ipc.message, ipc.detail);
}
