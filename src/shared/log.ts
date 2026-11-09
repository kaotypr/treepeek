/**
 * The logger main and the core service share. File access is injected, so this module
 * stays free of Node imports; `main/log.ts` and `core/log.ts` pass `node:fs`.
 *
 * Repository paths may be logged. File contents and environment values must not be, so
 * data passed to a log call is redacted before it is written.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(scope: string): Logger;
}

/** The slice of `node:fs` the rotating file sink uses. */
export interface LogFs {
  mkdirSync(path: string, options: { recursive: true }): unknown;
  appendFileSync(path: string, data: string): void;
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
}

export interface RotatingFileOptions {
  fs: LogFs;
  /** Joins path segments (`node:path`'s `join`). */
  join: (...parts: string[]) => string;
  dir: string;
  /** Base name: `main` writes `main.log`, rotated to `main.1.log` … `main.4.log`. */
  name: string;
  maxBytes?: number;
  maxFiles?: number;
}

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_MAX_FILES = 5;

export type LogSink = (line: string) => void;

/** Appends lines to `<dir>/<name>.log`, rotating when the next line would pass `maxBytes`. */
export function createRotatingFileSink(options: RotatingFileOptions): LogSink {
  const { fs, join, dir, name } = options;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const maxFiles = options.maxFiles ?? LOG_MAX_FILES;
  const fileAt = (index: number) => join(dir, index === 0 ? `${name}.log` : `${name}.${index}.log`);

  fs.mkdirSync(dir, { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(fileAt(0)).size;
  } catch {
    size = 0;
  }

  const rotate = () => {
    fs.rmSync(fileAt(maxFiles - 1), { force: true });
    for (let index = maxFiles - 2; index >= 0; index--) {
      try {
        fs.renameSync(fileAt(index), fileAt(index + 1));
      } catch {
        // A missing file in the chain is fine.
      }
    }
    size = 0;
  };

  return (line) => {
    const bytes = byteLength(line);
    if (size > 0 && size + bytes > maxBytes) rotate();
    fs.appendFileSync(fileAt(0), line);
    size += bytes;
  };
}

export interface LoggerOptions {
  scope: string;
  sink: LogSink;
  /** Also print to a console (development). */
  echo?: ((level: LogLevel, line: string) => void) | undefined;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const write = (level: LogLevel, message: string, data: unknown) => {
    const suffix = data === undefined ? "" : ` ${safeJson(redact(data))}`;
    const line = `${now().toISOString()} ${level.toUpperCase()} [${options.scope}] ${message}${suffix}\n`;
    try {
      options.sink(line);
    } catch {
      // Logging must never take a process down.
    }
    options.echo?.(level, line);
  };
  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    child: (scope) => createLogger({ ...options, scope: `${options.scope}:${scope}` }),
  };
}

export const REDACTED = "[redacted]";
const ENV_KEY = /^(env|environment)$/i;
const SECRET_KEY =
  /(pass(word|phrase)?|secret|token|api[-_]?key|auth(orization)?|cookie|credential|private[-_]?key)/i;
const MAX_DEPTH = 6;

/**
 * Returns a copy of `value` that is safe to log: every value under an `env` /
 * `environment` key and every value whose key looks like a secret becomes `[redacted]`.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (ENV_KEY.test(key)) {
      out[key] =
        item !== null && typeof item === "object"
          ? Object.fromEntries(Object.keys(item).map((name) => [name, REDACTED]))
          : REDACTED;
    } else if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(item, depth + 1, seen);
    }
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '"[unserializable]"';
  }
}

function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
