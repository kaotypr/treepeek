import { type ChildProcess, spawn } from "node:child_process";
import { type GitFailure, gitFailure } from "./errors";

/** Stderr kept per process; git's messages are short, so this only stops runaways. */
const STDERR_CAP = 64 * 1024;

/** After a kill, how long to wait for the process to close before giving up on it. */
const CLOSE_GRACE_MS = 2_000;

export interface ProcessOptions {
  env: NodeJS.ProcessEnv;
  /** Kills the process (and its process group) when it aborts; the call fails `cancelled`. */
  signal?: AbortSignal | undefined;
  /** Kills the process past this many milliseconds; the call fails `timeout`. */
  timeoutMs: number;
  /** Kills the process once stdout passes this many bytes; the call fails `outputTooLarge`. */
  maxBytes: number;
  /** Written to stdin, which is then closed. Without it stdin is `/dev/null`. */
  stdin?: string | Uint8Array | undefined;
  /** Exit codes that count as success. Default `[0]`. */
  okExitCodes?: readonly number[] | undefined;
}

export interface ProcessOutput {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export interface SpawnEvent {
  type: "spawn" | "exit";
  pid: number;
  file: string;
  args: readonly string[];
}

const observers = new Set<(event: SpawnEvent) => void>();
let spawned = 0;

/**
 * Reports every process this module starts and when it exits. Tests count spawns and
 * concurrency with it, and the benchmarks count git processes per scan.
 */
export function observeSpawns(listener: (event: SpawnEvent) => void): () => void {
  observers.add(listener);
  return () => observers.delete(listener);
}

/** How many processes this module has started since the core service began. */
export function spawnCount(): number {
  return spawned;
}

function notify(event: SpawnEvent): void {
  for (const listener of observers) listener(event);
}

/**
 * Runs a program with an argument array (never a shell) and collects its output, within a
 * time limit and a byte cap, cancellable through `signal`. The child leads its own process
 * group, so stopping it also stops anything it started.
 *
 * Resolves when the process exits with an accepted code; otherwise rejects with a
 * `GitError` whose code says why (`errors.ts`).
 */
export function runProcess(
  file: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessOutput> {
  if (options.signal?.aborted) return Promise.reject(gitFailure("cancelled", ""));
  return new Promise<ProcessOutput>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        env: options.env,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      reject(gitFailure("spawn", error instanceof Error ? error.message : String(error)));
      return;
    }

    const pid = child.pid;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let stopped: GitFailure | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;

    if (pid !== undefined) {
      spawned += 1;
      notify({ type: "spawn", pid, file, args });
    }

    const finish = (outcome: { ok: ProcessOutput } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      options.signal?.removeEventListener("abort", onAbort);
      if ("ok" in outcome) resolve(outcome.ok);
      else reject(outcome.error);
    };

    const stop = (reason: GitFailure) => {
      if (stopped !== null || settled) return;
      stopped = reason;
      killGroup(child);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ error: gitFailure(reason, stderr) });
      }, CLOSE_GRACE_MS);
    };

    const onAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped !== null) return;
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        stop("outputTooLarge");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      if (stderr.length < STDERR_CAP) stderr += text.slice(0, STDERR_CAP - stderr.length);
    });

    child.on("error", (error) => {
      // Only a failed start reaches here without a pid; a running child reports through `close`.
      if (pid === undefined) finish({ error: gitFailure("spawn", error.message) });
    });

    child.on("close", (code) => {
      if (pid !== undefined) notify({ type: "exit", pid, file, args });
      if (stopped !== null) {
        finish({ error: gitFailure(stopped, stderr) });
      } else if (code === null) {
        finish({ error: gitFailure("signal", stderr) });
      } else if (!(options.okExitCodes ?? [0]).includes(code)) {
        finish({ error: gitFailure(code, stderr) });
      } else {
        finish({ ok: { stdout: Buffer.concat(chunks, bytes), stderr, code } });
      }
    });

    if (options.stdin !== undefined && child.stdin) {
      // A child that exits without reading its input makes the write fail with EPIPE;
      // its exit code says what happened.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }
  });
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
