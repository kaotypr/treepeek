import { GIT_TIMEOUT_MS } from "../../shared/constants";
import { GitError, gitFailure } from "./errors";
import { killProcessGroup, type PipedProcess, startProcess } from "./process";
import type { GitPriority } from "./queue";
import { gitArgs, gitQueue, repositoryEnv } from "./run";
import { type GitBinary, requireGit } from "./runtime";

/** A batch process with no request for this long is closed; the next request restarts it. */
export const BATCH_IDLE_MS = 60_000;

/** Stderr kept per process; only for the message of a failure. */
const STDERR_CAP = 16 * 1024;

/** After closing stdin, how long a process may take to exit before it is killed. */
const CLOSE_GRACE_MS = 2_000;

export interface BatchProcessOptions {
  /** Absolute folder git runs in (`-C`). */
  cwd: string;
  /** The subcommand and its arguments, checked by the guard like every git call. */
  args: readonly string[];
  /** Idle time before the process closes. Default `BATCH_IDLE_MS`. */
  idleMs?: number;
  /** Time limit for one request; past it the process is killed. Default `GIT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface BatchRequestOptions {
  /** Aborting a waiting request drops it; aborting a running one kills the process. */
  signal: AbortSignal;
  /** Queue lane for the request. Default `normal`. */
  priority?: GitPriority;
}

/** What a request may do with the process while it holds it. */
export interface BatchIo {
  /** Writes to the process's stdin. */
  write(data: string): void;
  /** The next line of stdout, without its LF. */
  readLine(): Promise<Buffer>;
  /** The next `count` bytes of stdout. */
  readBytes(count: number): Promise<Buffer>;
}

/**
 * One long-lived git process fed requests over stdin (`cat-file --batch-command`,
 * `hash-object --stdin-paths`). It starts on the first request, serves one request at a
 * time, closes after `idleMs` without requests, and starts again after a crash.
 *
 * **The git queue.** Each request takes a slot in the git queue while it runs, so a batch
 * process doing work counts against `GIT_CONCURRENCY` like any other git process. An idle
 * batch process holds no slot: holding one for its whole life would let a few idle
 * processes starve every scan. Idle processes are bounded by the repositories and
 * checkouts in use, and close after `idleMs`.
 *
 * A request that fails part-way (cancelled, timed out, or throwing) kills the process,
 * because it may hold a half-read answer; the next request starts a fresh one.
 *
 * **Repository config.** The process starts with the overrides that switch off the
 * repository's own filter drivers, like every `runGit` call (`repositoryEnv`). Git reads
 * config once at start, so a running process keeps the drivers it started with; each
 * request still checks the overrides (a few `stat` calls while nothing changed) and starts
 * a fresh process when they differ from the running one's.
 */
export class BatchProcess {
  readonly cwd: string;
  readonly #argv: string[];
  readonly #idleMs: number;
  readonly #timeoutMs: number;
  #child: BatchChild | null = null;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #idleTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #bytesRead = 0;

  constructor(options: BatchProcessOptions) {
    this.cwd = options.cwd;
    // Built once, so a command the guard refuses fails here rather than on first use.
    this.#argv = gitArgs(options.cwd, options.args);
    this.#idleMs = options.idleMs ?? BATCH_IDLE_MS;
    this.#timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  }

  /** The running process's pid, or `null` when none is running. */
  get pid(): number | null {
    const child = this.#child;
    return child && !child.failed ? child.pid : null;
  }

  /** Bytes read from stdout across every process this batch has run. */
  get bytesRead(): number {
    return this.#bytesRead;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Runs `exchange` with sole use of the process: requests run one at a time, in order.
   * An exchange that wants to report an ordinary answer (a missing object) returns it; a
   * throw means the process can no longer be trusted, and it is killed.
   */
  async request<T>(
    exchange: (io: BatchIo) => Promise<T>,
    options: BatchRequestOptions,
  ): Promise<T> {
    const { signal } = options;
    if (this.#closed) throw closedError();
    if (signal.aborted) throw cancelledError();
    this.#pending += 1;
    this.#clearIdle();
    const previous = this.#tail;
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chained on `previous`, so a request that gives up early does not let the next one
    // overtake a request still running.
    this.#tail = previous.then(() => mine);
    try {
      await untilOrAbort(previous, signal);
      const priority = options.priority ?? "normal";
      // Before taking a queue slot: listing the config takes one of its own.
      const git = await requireGit();
      const env = await repositoryEnv(this.cwd, git, {
        signal,
        timeoutMs: this.#timeoutMs,
        priority,
      });
      return await gitQueue().run(
        () => this.#exchange(exchange, signal, git, env),
        priority,
        signal,
      );
    } finally {
      release();
      this.#pending -= 1;
      if (this.#pending === 0) this.#scheduleIdle();
    }
  }

  /** Stops the process and refuses every later request with `cancelled`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearIdle();
    const child = this.#child;
    this.#child = null;
    child?.fail(closedError());
  }

  async #exchange<T>(
    exchange: (io: BatchIo) => Promise<T>,
    signal: AbortSignal,
    git: GitBinary,
    env: NodeJS.ProcessEnv,
  ): Promise<T> {
    if (this.#closed) throw closedError();
    if (signal.aborted) throw cancelledError();
    const child = this.#ensureChild(git, env);
    const onAbort = () => child.fail(gitFailure("cancelled", child.stderr));
    const timer = setTimeout(
      () => child.fail(gitFailure("timeout", child.stderr)),
      this.#timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await exchange(child);
    } catch (error) {
      child.fail(error instanceof GitError ? error : new GitError("internal", String(error)));
      if (this.#child === child) this.#child = null;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  #ensureChild(git: GitBinary, env: NodeJS.ProcessEnv): BatchChild {
    const current = this.#child;
    const started = { path: git.path, env: envKey(env) };
    if (current && !current.failed) {
      if (current.started.path === started.path && current.started.env === started.env) {
        return current;
      }
      // The git or the repository's overrides changed since this process started.
      this.#child = null;
      current.shutdown();
    }
    if (this.#closed) throw closedError();
    const child = new BatchChild(startProcess(git.path, this.#argv, env), started, (count) => {
      this.#bytesRead += count;
    });
    this.#child = child;
    void child.exited.then(() => {
      if (this.#child === child) this.#child = null;
    });
    return child;
  }

  #scheduleIdle(): void {
    this.#clearIdle();
    if (this.#closed || !this.#child) return;
    const timer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#pending > 0) return;
      const child = this.#child;
      this.#child = null;
      child?.shutdown();
    }, this.#idleMs);
    timer.unref?.();
    this.#idleTimer = timer;
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}

type Waiter =
  | { kind: "line"; resolve: (line: Buffer) => void; reject: (error: GitError) => void }
  | {
      kind: "bytes";
      count: number;
      resolve: (bytes: Buffer) => void;
      reject: (error: GitError) => void;
    };

/** What a batch process was started with, to tell when it must start again. */
interface StartedWith {
  path: string;
  env: string;
}

/** The environment as a comparable string: names sorted, so order does not matter. */
function envKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** One running batch process: its stdout as a byte stream, and how it ended. */
class BatchChild implements BatchIo {
  readonly pid: number;
  readonly started: StartedWith;
  /** Resolves once the process has exited and its streams are closed. */
  readonly exited: Promise<void>;
  readonly #process: PipedProcess;
  readonly #onBytes: (count: number) => void;
  #chunks: Buffer[] = [];
  #size = 0;
  #waiter: Waiter | null = null;
  #failure: GitError | null = null;
  /** The process exited by itself, so output it wrote before exiting may still be read. */
  #exitedOnItsOwn = false;
  #stderr = "";

  constructor(process: PipedProcess, started: StartedWith, onBytes: (count: number) => void) {
    this.#process = process;
    this.started = started;
    this.#onBytes = onBytes;
    // `startProcess` throws when there is no pid.
    this.pid = process.pid ?? -1;
    process.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (text: string) => {
      if (this.#stderr.length < STDERR_CAP) {
        this.#stderr += text.slice(0, STDERR_CAP - this.#stderr.length);
      }
    });
    this.exited = new Promise<void>((resolve) => {
      process.on("close", (code) => {
        if (!this.#failure) this.#exitedOnItsOwn = true;
        this.#setFailure(
          code === null || code !== 0
            ? gitFailure(code ?? "signal", this.#stderr)
            : new GitError("internal", "The Git batch process exited.", { exitCode: 0 }),
        );
        resolve();
      });
    });
  }

  /** The process has failed, exited or been stopped; it takes no more requests. */
  get failed(): boolean {
    return this.#failure !== null;
  }

  get stderr(): string {
    return this.#stderr;
  }

  write(data: string): void {
    if (this.#failure) throw this.#failure;
    this.#process.stdin.write(data);
  }

  readLine(): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.#wait({ kind: "line", resolve, reject });
    });
  }

  readBytes(count: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.#wait({ kind: "bytes", count, resolve, reject });
    });
  }

  /** Kills the process; the request waiting on it, if any, fails with `error`. */
  fail(error: GitError): void {
    if (this.#failure) return;
    this.#setFailure(error);
    killProcessGroup(this.#process);
  }

  /** Closes stdin so git exits by itself; kills it if it has not exited after a grace period. */
  shutdown(): void {
    if (this.#failure) return;
    this.#setFailure(new GitError("cancelled", "The Git batch process was closed."));
    this.#process.stdin.end();
    const grace = setTimeout(() => killProcessGroup(this.#process), CLOSE_GRACE_MS);
    grace.unref?.();
    void this.exited.then(() => clearTimeout(grace));
  }

  #setFailure(error: GitError): void {
    if (this.#failure) return;
    this.#failure = error;
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(error);
  }

  #wait(waiter: Waiter): void {
    if (this.#waiter) {
      waiter.reject(new GitError("internal", "A batch request read out of turn."));
      return;
    }
    if (this.#failure && !this.#exitedOnItsOwn) {
      waiter.reject(this.#failure);
      return;
    }
    this.#waiter = waiter;
    this.#pump();
    // After an exit, buffered output is still served; past its end the read fails.
    if (this.#waiter === waiter && this.#failure) {
      this.#waiter = null;
      waiter.reject(this.#failure);
    }
  }

  #onData(chunk: Buffer): void {
    this.#onBytes(chunk.length);
    if (this.#failure && !this.#exitedOnItsOwn) return;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    this.#pump();
  }

  #pump(): void {
    const waiter = this.#waiter;
    if (!waiter) return;
    if (waiter.kind === "bytes") {
      if (this.#size < waiter.count) return;
      this.#waiter = null;
      waiter.resolve(this.#take(waiter.count));
      return;
    }
    const at = this.#indexOfNewline();
    if (at === -1) return;
    this.#waiter = null;
    waiter.resolve(this.#take(at + 1).subarray(0, at));
  }

  #indexOfNewline(): number {
    let offset = 0;
    for (const chunk of this.#chunks) {
      const at = chunk.indexOf(0x0a);
      if (at !== -1) return offset + at;
      offset += chunk.length;
    }
    return -1;
  }

  /** Removes and returns the first `count` buffered bytes. */
  #take(count: number): Buffer {
    const first = this.#chunks[0];
    if (first && first.length >= count) {
      const head = first.subarray(0, count);
      if (first.length === count) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(count);
      this.#size -= count;
      return head;
    }
    const all = Buffer.concat(this.#chunks, this.#size);
    const head = all.subarray(0, count);
    const rest = all.subarray(count);
    this.#chunks = rest.length > 0 ? [rest] : [];
    this.#size = rest.length;
    return head;
  }
}

/** Resolves when `promise` does, or rejects with `cancelled` as soon as `signal` aborts. */
function untilOrAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function cancelledError(): GitError {
  return new GitError("cancelled", "The Git command was cancelled.");
}

function closedError(): GitError {
  return new GitError("cancelled", "The Git batch process was closed.");
}
