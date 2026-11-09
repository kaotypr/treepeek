import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type { Logger } from "../shared/log";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FALLBACK_SHELL = "/bin/zsh";

export interface LoginEnvOptions {
  /** The login shell. Default: the user's shell from the system, then `$SHELL`, then zsh. */
  shell?: string;
  /** How long the shell may take before the app's own environment is used. Default 5 s. */
  timeoutMs?: number;
  /** The environment the shell starts from, and the fallback. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  log?: Logger;
}

/**
 * Reads the environment of the user's login shell, once, at startup. An app opened from
 * Finder inherits launchd's short `PATH`, which misses Homebrew and anything a profile
 * adds, so the core service looks for git on this one instead.
 *
 * The shell runs as a non-interactive login shell (`-l -c`) with stdin closed, so profile
 * files run but nothing waits for input, and it is killed after `timeoutMs`. Its output is
 * read between two random markers, so a profile that prints a banner does not confuse it,
 * and `env -0` separates variables with NUL, so values containing newlines survive.
 *
 * Any failure (no shell, a timeout, unreadable output) returns the app's own environment
 * and logs a warning. Values are never logged.
 */
export async function loadLoginEnv(options: LoginEnvOptions = {}): Promise<Record<string, string>> {
  const base = options.env ?? process.env;
  const shell = options.shell ?? defaultShell(base);
  const started = Date.now();
  try {
    const env = await readShellEnv(shell, base, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    options.log?.info("read the login shell environment", {
      shell,
      ms: Date.now() - started,
      variables: Object.keys(env).length,
    });
    return env;
  } catch (error) {
    options.log?.warn("could not read the login shell environment; using the app's own", {
      shell,
      reason: error instanceof Error ? error.message : String(error),
    });
    return stringsOnly(base);
  }
}

function defaultShell(base: NodeJS.ProcessEnv): string {
  try {
    const shell = userInfo().shell;
    if (shell && isAbsolute(shell)) return shell;
  } catch {
    // No passwd entry; fall through.
  }
  const fromEnv = base.SHELL;
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : FALLBACK_SHELL;
}

function readShellEnv(
  shell: string,
  base: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Record<string, string>> {
  if (!isAbsolute(shell)) return Promise.reject(new Error("the shell path is not absolute"));
  const marker = `__TREEPEEK_ENV_${randomUUID().replaceAll("-", "")}__`;
  const command = `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`;

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-l", "-c", command], {
      env: base,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;

    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => stop(new Error(`the shell took longer than ${timeoutMs} ms`)),
      timeoutMs,
    );

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop(new Error("the shell printed too much"));
      else chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`the shell exited with ${code}`));
      const env = parseMarkedEnv(Buffer.concat(chunks).toString("utf8"), marker);
      if (!env) return reject(new Error("the shell's output had no environment block"));
      resolve(env);
    });
  });
}

/**
 * Reads the `env -0` block printed between two copies of `marker`. Returns `null` when the
 * markers are missing or the block has no `PATH`.
 */
export function parseMarkedEnv(output: string, marker: string): Record<string, string> | null {
  const start = output.indexOf(marker);
  const end = output.lastIndexOf(marker);
  if (start === -1 || end <= start) return null;
  const block = output.slice(start + marker.length, end);
  const env: Record<string, string> = {};
  for (const entry of block.split("\0")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return typeof env.PATH === "string" ? env : null;
}

function stringsOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}
