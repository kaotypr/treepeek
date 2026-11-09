import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
  createRotatingFileSink,
  createLogger as createSharedLogger,
  type Logger,
  type LogSink,
} from "../shared/log";

let sink: LogSink | null = null;

/** The logs folder: `userData/logs`, shared with the core service's `core.log`. */
export function logsDir(): string {
  return join(app.getPath("userData"), "logs");
}

function mainSink(): LogSink {
  sink ??= createRotatingFileSink({
    fs: { appendFileSync, mkdirSync, renameSync, rmSync, statSync },
    join,
    dir: logsDir(),
    name: "main",
  });
  return sink;
}

/** A logger writing to `userData/logs/main.log` (5 files × 5 MB), echoed to stdout in dev. */
export function createLogger(scope: string): Logger {
  return createSharedLogger({
    scope,
    sink: (line) => mainSink()(line),
    echo: app.isPackaged
      ? undefined
      : (level, line) => (level === "error" ? process.stderr : process.stdout).write(line),
  });
}
