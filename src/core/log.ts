import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createRotatingFileSink,
  createLogger as createSharedLogger,
  type Logger,
  type LogSink,
} from "../shared/log";

const MAX_BUFFERED = 1000;
let sink: LogSink | null = null;
const buffered: string[] = [];

/**
 * Points the core service's log at `<userDataDir>/logs/core.log`. Main sends the folder in
 * `core.init`; lines logged before that are buffered and written now.
 */
export function initCoreLog(userDataDir: string): void {
  if (sink) return;
  sink = createRotatingFileSink({
    fs: { appendFileSync, mkdirSync, renameSync, rmSync, statSync },
    join,
    dir: join(userDataDir, "logs"),
    name: "core",
  });
  for (const line of buffered.splice(0)) sink(line);
}

export function createLogger(scope: string): Logger {
  return createSharedLogger({
    scope: `core:${scope}`,
    sink: (line) => {
      if (sink) sink(line);
      else if (buffered.length < MAX_BUFFERED) buffered.push(line);
    },
  });
}
