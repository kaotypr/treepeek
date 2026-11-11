import { coreEvents } from "../../shared/ipc";
import type { Logger } from "../../shared/log";
import type { CoreState } from "../cache/shared-state";
import type { ScanResult } from "../scan/scan";
import type { Session } from "../sessions/session";
import type { ReviewStore } from "../store/review-store";
import type { WatchBackend } from "./backends";
import { type SubscriptionInfo, WatchManager, type WatchManagerOptions } from "./manager";
import { RefreshRunner } from "./refresh";
import { revalidateAll } from "./revalidate";
import type { WatchedScan } from "./targets";

export interface LiveRefreshOptions {
  state: CoreState;
  store(): ReviewStore | null;
  sessions(): readonly Session[];
  log: Logger;
  backends: readonly WatchBackend[];
  /** Debounce and storm settings; the design's defaults otherwise. */
  timing?: Pick<
    WatchManagerOptions,
    "quietMs" | "maxWaitMs" | "stormThreshold" | "stormWindowMs" | "now"
  >;
}

/** What `test.liveRefresh` reports. */
export interface LiveRefreshInfo {
  /** The name of the backend watching (`WatchManager.backend`). */
  backend: string;
  subscriptions: SubscriptionInfo[];
  /** Folders no backend could watch. */
  unavailable: string[];
}

/**
 * Live refresh in the core service (live-refresh design): one watch manager shared by
 * every window, whose debounced changes the refresh runner turns into `refresh.checkout`,
 * `refresh.timeline` and `review.changed` for each window showing what changed. Each
 * window also hears `refresh.paused` whenever where live refresh is paused changes.
 */
export class LiveRefresh {
  readonly watch: WatchManager;
  readonly runner: RefreshRunner;
  readonly #log: Logger;
  readonly #sessions: () => readonly Session[];
  readonly #announced = new WeakMap<Session, string>();

  constructor(options: LiveRefreshOptions) {
    this.#log = options.log;
    this.#sessions = options.sessions;
    this.runner = new RefreshRunner({
      sessions: options.sessions,
      state: options.state,
      store: options.store,
      log: options.log,
      rewatch: (session) => void this.watchScan(session),
    });
    this.watch = new WatchManager({
      backends: options.backends,
      log: options.log,
      onChange: (change) => this.runner.handle(change),
      onPausedChange: () => this.#announceAll(),
      ...options.timing,
    });
  }

  /** Watches what the session's last scan holds (after a scan, or a refresh that changed it). */
  async watchScan(session: Session): Promise<void> {
    const scan = session.lastScan;
    if (!scan || session.closed) return;
    try {
      await this.watch.watchScan(session.id, watchedScanOf(scan));
    } catch (error) {
      session.log.warn("could not watch the scan", { error });
    }
    if (session.closed) {
      await this.watch.release(session.id);
      return;
    }
    this.#announce(session);
  }

  /** Stops watching for a session (its window closed, or it opened another folder). */
  release(session: Session): void {
    this.#announced.delete(session);
    void this.watch.release(session.id).catch((error: unknown) => {
      this.#log.warn("could not stop watching a scan", { error });
    });
  }

  /** The window's Refresh: what paused for it runs again. */
  async resume(session: Session): Promise<void> {
    await this.watch.resume(session.id);
    this.#announce(session);
  }

  /** The Mac woke from sleep: every window's checkouts are read again. */
  revalidate(): Promise<void> {
    return revalidateAll(this.runner, this.#log);
  }

  info(): LiveRefreshInfo {
    const subscriptions = this.watch.subscriptions();
    return {
      backend: this.watch.backend(),
      subscriptions,
      unavailable: subscriptions
        .filter((subscription) => subscription.backend === null)
        .map((subscription) => subscription.path),
    };
  }

  dispose(): Promise<void> {
    return this.watch.dispose();
  }

  #announceAll(): void {
    for (const session of this.#sessions()) this.#announce(session);
  }

  /** Sends the session's paused list when it differs from what it last heard. */
  #announce(session: Session): void {
    if (session.closed || !this.watch.scanOf(session.id)) return;
    const paused = this.watch.paused(session.id);
    const text = JSON.stringify(paused);
    if (this.#announced.get(session) === text) return;
    this.#announced.set(session, text);
    session.rpc.emit(coreEvents["refresh.paused"], { paused });
  }
}

/** What watching needs of a scan result. */
export function watchedScanOf(scan: ScanResult): WatchedScan {
  return {
    scanRoots: scan.roots.map((root) => root.path),
    checkouts: scan.checkouts.map((item) => ({
      path: item.checkout.path,
      gitDir: item.gitDir,
      commonDir: item.commonDir,
    })),
  };
}
