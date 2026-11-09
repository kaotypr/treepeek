import {
  type BrowserWindow,
  MessageChannelMain,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import * as v from "valibot";
import { CONTRACT_VERSION, type CoreState, CoreToMainSchema, IPC_CHANNELS } from "../shared/ipc";
import type { MainToCore } from "../shared/ipc/messages";
import type { Logger } from "../shared/log";

export interface CoreSupervisorOptions {
  /** Path of the built core service entry (`out/core/index.js`). */
  entry: string;
  userDataDir: string;
  log: Logger;
  gitPathOverride?: string | null;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  /** Delay before each restart attempt; after the last one the state becomes `failed`. */
  backoffMs?: readonly number[];
  /** How long the service must stay up before the backoff starts over. */
  stableAfterMs?: number;
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
  readonly #options: Required<Omit<CoreSupervisorOptions, "gitPathOverride">> & {
    gitPathOverride: string | null;
  };
  readonly #windows = new Map<number, Attached>();
  readonly #stateListeners = new Set<(state: CoreState) => void>();
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

  constructor(options: CoreSupervisorOptions) {
    this.#options = {
      healthIntervalMs: 5_000,
      healthTimeoutMs: 2_000,
      backoffMs: [1_000, 2_000, 5_000],
      stableAfterMs: 30_000,
      gitPathOverride: null,
      ...options,
    };
  }

  /** The last state announced to windows, or `null` before the first start completes. */
  get state(): CoreState | null {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  start(): void {
    this.#stopping = false;
    this.#spawn();
  }

  stop(): void {
    this.#stopping = true;
    this.#clearTimers();
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
    contents.on("did-start-loading", () => {
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
      gitPathOverride: this.#options.gitPathOverride,
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
    }
  }

  #onExit(child: UtilityProcess, code: number): void {
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
