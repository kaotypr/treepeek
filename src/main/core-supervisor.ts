import {
  type BrowserWindow,
  MessageChannelMain,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import * as v from "valibot";
import type { GitState } from "../shared/domain/git";
import { CONTRACT_VERSION, type CoreState, CoreToMainSchema, IPC_CHANNELS } from "../shared/ipc";
import { MAX_PATH_LENGTH } from "../shared/ipc/domain-schemas";
import { MAX_VALIDATE_PATHS, type MainToCore } from "../shared/ipc/messages";
import type { Logger } from "../shared/log";

export interface CoreSupervisorOptions {
  /** Path of the built core service entry (`out/core/index.js`). */
  entry: string;
  userDataDir: string;
  log: Logger;
  /** The git binary from settings; change it later with `setGitPathOverride`. */
  gitPathOverride?: string | null;
  /** `PATH` from the login shell (`shell-env.ts`); set it with `setLoginPath` before `start`. */
  loginPath?: string | null;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  /** Delay before each restart attempt; after the last one the state becomes `failed`. */
  backoffMs?: readonly number[];
  /** How long the service must stay up before the backoff starts over. */
  stableAfterMs?: number;
  /** How long `validatePaths` waits for the core service before answering "not in a scan". */
  validateTimeoutMs?: number;
  /** How long `probeGit` waits for the core service. */
  probeTimeoutMs?: number;
}

interface PendingValidation {
  child: UtilityProcess;
  count: number;
  finish(valid: boolean[] | null): void;
}

interface Attached {
  win: BrowserWindow;
  windowId: number;
  /** The page has finished loading, so its preload is listening for a port. */
  loaded: boolean;
}

/**
 * Starts the core service, checks it is alive, restarts it with backoff when it dies or
 * stops answering, and hands every window a fresh MessagePort to it after each start.
 */
export class CoreSupervisor {
  readonly #options: Required<Omit<CoreSupervisorOptions, "gitPathOverride" | "loginPath">>;
  readonly #windows = new Map<number, Attached>();
  readonly #stateListeners = new Set<(state: CoreState) => void>();
  readonly #gitListeners = new Set<(state: GitState) => void>();
  #gitPathOverride: string | null;
  #loginPath: string | null;
  #gitState: GitState | null = null;
  #child: UtilityProcess | null = null;
  #ready = false;
  #state: CoreState | null = null;
  #attempt = 0;
  #stopping = false;
  #healthTimer: NodeJS.Timeout | null = null;
  #healthDeadline: NodeJS.Timeout | null = null;
  #healthId = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #stableTimer: NodeJS.Timeout | null = null;
  #validationId = 0;
  readonly #validations = new Map<number, PendingValidation>();
  #probeId = 0;
  readonly #probes = new Map<
    number,
    { child: UtilityProcess; finish(state: GitState | null): void }
  >();

  constructor(options: CoreSupervisorOptions) {
    this.#options = {
      healthIntervalMs: 5_000,
      healthTimeoutMs: 2_000,
      backoffMs: [1_000, 2_000, 5_000],
      stableAfterMs: 30_000,
      validateTimeoutMs: 5_000,
      probeTimeoutMs: 15_000,
      ...options,
    };
    this.#gitPathOverride = options.gitPathOverride ?? null;
    this.#loginPath = options.loginPath ?? null;
  }

  /** The last state announced to windows, or `null` before the first start completes. */
  get state(): CoreState | null {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** The core service's latest git discovery, or `null` before the first one reports. */
  get gitState(): GitState | null {
    return this.#gitState;
  }

  /** Sets the login `PATH` sent with every later `core.init`. */
  setLoginPath(loginPath: string | null): void {
    this.#loginPath = loginPath;
  }

  /**
   * Changes the git binary override. A running core service re-runs discovery now; a
   * restarted one gets the new value in `core.init`.
   */
  setGitPathOverride(path: string | null): void {
    if (path === this.#gitPathOverride) return;
    this.#gitPathOverride = path;
    // Sent even before `core.ready`: the service handles messages in order, so this lands
    // after the `core.init` that carried the old value.
    this.#child?.postMessage({ type: "settings.gitPath", path } satisfies MainToCore);
  }

  /**
   * Runs discovery again with the same override ("Try again", "Detect again"): git may
   * have been installed since. The result arrives through `onGitState`.
   */
  detectGitAgain(): void {
    this.#child?.postMessage({
      type: "settings.gitPath",
      path: this.#gitPathOverride,
    } satisfies MainToCore);
  }

  /**
   * The Mac woke from sleep: the core service checks every window's checkouts again (live
   * refresh). Dropped while the service is not ready; a restarted one rescans anyway.
   */
  powerResumed(): void {
    this.#post({ type: "power.resume" });
  }

  /**
   * Asks the core service whether one binary is a usable git, without making it the one
   * Treepeek runs. Answers why not when the service is not running or does not answer.
   */
  probeGit(path: string): Promise<GitState> {
    const child = this.#child;
    if (!child || !this.#ready) {
      return Promise.resolve({
        found: false,
        problem: "notFound",
        detail: "The background service is not running; try again in a moment.",
      });
    }
    this.#probeId += 1;
    const id = this.#probeId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#options.log.warn("git.probe timed out", { id });
        finish(null);
      }, this.#options.probeTimeoutMs);
      const finish = (state: GitState | null) => {
        if (!this.#probes.delete(id)) return;
        clearTimeout(timer);
        resolve(
          state ?? {
            found: false,
            problem: "notFound",
            detail: "The background service did not answer.",
          },
        );
      };
      this.#probes.set(id, { child, finish });
      child.postMessage({ type: "git.probe", id, path } satisfies MainToCore);
    });
  }

  /** Called with every git discovery result the core service reports. */
  onGitState(listener: (state: GitState) => void): () => void {
    this.#gitListeners.add(listener);
    return () => this.#gitListeners.delete(listener);
  }

  /**
   * Asks the core service which `paths` lie in some window's scan (the path rule), for the
   * "Open in…" checks. Resolves one boolean per path, in order. Every path counts as not in
   * a scan when the service is not ready, restarts, does not answer in time, or the request
   * is out of bounds (more than `MAX_VALIDATE_PATHS` paths, an empty or overlong path).
   */
  validatePaths(paths: readonly string[]): Promise<boolean[]> {
    const none = () => paths.map(() => false);
    const child = this.#child;
    const inBounds =
      paths.length <= MAX_VALIDATE_PATHS &&
      paths.every((path) => path.length > 0 && path.length <= MAX_PATH_LENGTH);
    if (!child || !this.#ready || paths.length === 0 || !inBounds) {
      return Promise.resolve(none());
    }
    this.#validationId += 1;
    const id = this.#validationId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#options.log.warn("paths.validate timed out", { id });
        finish(null);
      }, this.#options.validateTimeoutMs);
      const finish = (valid: boolean[] | null) => {
        if (!this.#validations.delete(id)) return;
        clearTimeout(timer);
        resolve(valid ?? none());
      };
      this.#validations.set(id, { child, count: paths.length, finish });
      child.postMessage({ type: "paths.validate", id, paths: [...paths] } satisfies MainToCore);
    });
  }

  start(): void {
    this.#stopping = false;
    this.#spawn();
  }

  stop(): void {
    this.#stopping = true;
    this.#clearTimers();
    this.#failValidations(null);
    const child = this.#child;
    this.#child = null;
    this.#ready = false;
    child?.kill();
  }

  onState(listener: (state: CoreState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /**
   * Registers a window. It gets a port to the core service each time its page finishes
   * loading (a reload re-runs the preload) and again after every restart.
   */
  attach(win: BrowserWindow): void {
    const windowId = win.id;
    if (this.#windows.has(windowId)) return;
    const entry: Attached = { win, windowId, loaded: false };
    this.#windows.set(windowId, entry);
    const contents = win.webContents;
    // A committed navigation (a reload) replaces the document and its preload. A blocked
    // navigation never commits, so it must not mark the page as unloaded.
    contents.on("did-navigate", () => {
      entry.loaded = false;
    });
    contents.on("did-finish-load", () => {
      entry.loaded = true;
      this.#attachWindow(windowId);
    });
    win.once("closed", () => {
      this.#windows.delete(windowId);
      this.#post({ type: "session.close", windowId });
    });
  }

  #spawn(): void {
    this.#ready = false;
    const child = utilityProcess.fork(this.#options.entry, [], {
      serviceName: "Treepeek Core",
      stdio: "inherit",
    });
    this.#child = child;
    child.on("spawn", () => {
      this.#options.log.info("core service spawned", { pid: child.pid });
    });
    child.on("message", (message: unknown) => this.#onMessage(child, message));
    child.on("exit", (code) => this.#onExit(child, code));
    child.postMessage({
      type: "core.init",
      contractVersion: CONTRACT_VERSION,
      userDataDir: this.#options.userDataDir,
      gitPathOverride: this.#gitPathOverride,
      loginPath: this.#loginPath,
    } satisfies MainToCore);
  }

  #onMessage(child: UtilityProcess, raw: unknown): void {
    if (child !== this.#child) return;
    const parsed = v.safeParse(CoreToMainSchema, raw);
    if (!parsed.success) {
      this.#options.log.warn("dropped a malformed message from the core service");
      return;
    }
    const message = parsed.output;
    switch (message.type) {
      case "core.ready":
        if (message.contractVersion !== CONTRACT_VERSION) {
          this.#options.log.error("core service contract mismatch", message);
          this.#fail(child, "contract mismatch");
          return;
        }
        this.#ready = true;
        this.#options.log.info("core service ready", { pid: message.pid });
        this.#setState("ready");
        this.#startHealth();
        this.#stableTimer = setTimeout(() => {
          this.#attempt = 0;
        }, this.#options.stableAfterMs);
        for (const windowId of this.#windows.keys()) this.#attachWindow(windowId);
        return;
      case "core.health":
        if (message.id === this.#healthId && this.#healthDeadline) {
          clearTimeout(this.#healthDeadline);
          this.#healthDeadline = null;
        }
        return;
      case "git.state":
        this.#gitState = message.state;
        this.#options.log.info("git discovery", message.state);
        for (const listener of this.#gitListeners) listener(message.state);
        return;
      case "paths.validate": {
        const pending = this.#validations.get(message.id);
        if (!pending || pending.child !== child) return;
        pending.finish(message.valid.length === pending.count ? message.valid : null);
        return;
      }
      case "git.probe": {
        const pending = this.#probes.get(message.id);
        if (pending?.child === child) pending.finish(message.state);
        return;
      }
    }
  }

  /** Answers every pending `validatePaths` (and `probeGit`) sent to `child` with "no". */
  #failValidations(child: UtilityProcess | null): void {
    for (const pending of [...this.#validations.values()]) {
      if (child === null || pending.child === child) pending.finish(null);
    }
    for (const pending of [...this.#probes.values()]) {
      if (child === null || pending.child === child) pending.finish(null);
    }
  }

  #onExit(child: UtilityProcess, code: number): void {
    this.#failValidations(child);
    if (child !== this.#child) return;
    this.#child = null;
    this.#ready = false;
    this.#clearTimers();
    if (this.#stopping) return;
    this.#options.log.warn("core service exited", { code });
    this.#scheduleRestart();
  }

  #fail(child: UtilityProcess, reason: string): void {
    if (child !== this.#child) return;
    this.#failValidations(child);
    this.#options.log.warn("restarting the core service", { reason });
    this.#child = null;
    this.#ready = false;
    this.#clearTimers();
    child.kill();
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    const delay = this.#options.backoffMs[this.#attempt];
    if (delay === undefined) {
      this.#options.log.error("core service failed; giving up after repeated restarts");
      this.#setState("failed");
      return;
    }
    this.#attempt += 1;
    this.#setState("restarting");
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping) this.#spawn();
    }, delay);
  }

  #startHealth(): void {
    this.#healthTimer = setInterval(() => {
      const child = this.#child;
      if (!child || !this.#ready) return;
      if (this.#healthDeadline) return;
      this.#healthId += 1;
      child.postMessage({ type: "core.health", id: this.#healthId } satisfies MainToCore);
      this.#healthDeadline = setTimeout(() => {
        this.#healthDeadline = null;
        this.#fail(child, "missed a health check");
      }, this.#options.healthTimeoutMs);
    }, this.#options.healthIntervalMs);
  }

  #attachWindow(windowId: number): void {
    const entry = this.#windows.get(windowId);
    const child = this.#child;
    if (!entry || !child || !this.#ready) return;
    if (entry.win.isDestroyed() || entry.win.webContents.isDestroyed()) return;
    // A page still loading gets its port from `did-finish-load`, once its preload listens.
    if (!entry.loaded) return;
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ type: "session.attach", windowId } satisfies MainToCore, [port1]);
    entry.win.webContents.postMessage(
      IPC_CHANNELS.corePort,
      { contractVersion: CONTRACT_VERSION },
      [port2],
    );
  }

  #post(message: MainToCore): void {
    if (this.#child && this.#ready) this.#child.postMessage(message);
  }

  #setState(state: CoreState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  #clearTimers(): void {
    for (const timer of [this.#healthTimer, this.#healthDeadline, this.#restartTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#healthTimer = null;
    this.#healthDeadline = null;
    this.#restartTimer = null;
    this.#stableTimer = null;
  }
}
