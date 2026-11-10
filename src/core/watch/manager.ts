import type { ChangeKind, RefreshPause } from "../../shared/domain/change";
import type { Logger } from "../../shared/log";
import type { BackendName, WatchBackend, WatchEvent, WatchSubscription } from "./backends";
import { buildWatchIndex, type Classified, classify, type WatchIndex } from "./classify";
import { CheckoutDebouncer } from "./debounce";
import { StormGuard } from "./storm";
import { targetKey, type WatchedScan, type WatchTarget, watchTargets } from "./targets";

/** A change, once the events for it have gone quiet. */
export type WatchChange =
  | { scope: "checkout"; checkoutPath: string; kinds: ChangeKind[] }
  | {
      scope: "repository";
      commonDir: string;
      kinds: ChangeKind[];
      /** The refs that moved (`refs/heads/x`); `null` when any may have (`packed-refs`). */
      refs: string[] | null;
    }
  | { scope: "root"; scanRoot: string; kinds: ChangeKind[] };

export interface WatchManagerOptions {
  /** Tried in order for each folder; the next one only when the one before cannot watch it. */
  backends: readonly WatchBackend[];
  log: Logger;
  /** A change, debounced. */
  onChange(change: WatchChange): void;
  /** An event storm paused a checkout, or a folder could not be watched, or that ended. */
  onPausedChange(): void;
  quietMs?: number;
  maxWaitMs?: number;
  stormThreshold?: number;
  stormWindowMs?: number;
  now?: () => number;
}

/** What `test.liveRefresh` reports of one subscription. */
export interface SubscriptionInfo {
  kind: WatchTarget["kind"];
  path: string;
  backend: BackendName | null;
  holders: number;
}

interface Subscription {
  readonly key: string;
  readonly target: WatchTarget;
  readonly holders: Set<number>;
  backend: BackendName | null;
  handle: WatchSubscription | null;
  /** Settles once a backend watches the folder or every backend has failed. */
  ready: Promise<void>;
  closed: boolean;
  /** When every backend failed; `null` while it is watched (or still subscribing). */
  unavailableSince: number | null;
}

/** What the debouncer gathers: change kinds, and the refs a repository change names. */
type Gathered = ChangeKind | `ref:${string}`;

const ANY_REF = "ref:*";
const SEPARATOR = "\0";

/**
 * The watchers of the core service, shared by every window (live-refresh design, "What is
 * watched"). Each scan asks for its targets (`watchTargets`); a folder two scans need is
 * watched once, and stops being watched when the last scan holding it lets go.
 *
 * Events are classified by path, counted against the storm guard (working-tree events
 * only) and debounced per checkout, repository or scan root before they reach `onChange`.
 *
 * A folder the first backend cannot watch falls back to the next one; when none can, it is
 * reported as unavailable and left alone. Nothing is retried in a loop: only `resume` (the
 * person's Refresh) tries such a folder once more.
 */
export class WatchManager {
  readonly #backends: readonly WatchBackend[];
  readonly #log: Logger;
  readonly #onChange: (change: WatchChange) => void;
  readonly #onPausedChange: () => void;
  readonly #now: () => number;
  readonly #scans = new Map<number, WatchedScan>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #debouncer: CheckoutDebouncer<Gathered>;
  readonly #storm: StormGuard;
  #index: WatchIndex = buildWatchIndex([]);
  #suspended = false;
  #disposed = false;

  constructor(options: WatchManagerOptions) {
    this.#backends = options.backends;
    this.#log = options.log;
    this.#onChange = options.onChange;
    this.#onPausedChange = options.onPausedChange;
    this.#now = options.now ?? Date.now;
    this.#debouncer = new CheckoutDebouncer<Gathered>(
      (key, items) => this.#flush(key, items),
      options.quietMs,
      options.maxWaitMs,
      this.#now,
    );
    this.#storm = new StormGuard(options.stormThreshold, options.stormWindowMs, this.#now);
  }

  /**
   * Watches what `scan` needs for `holder` (a session), in place of what that holder's
   * previous scan needed. Resolves once every folder is watched or known to be unwatchable.
   */
  async watchScan(holder: number, scan: WatchedScan): Promise<void> {
    if (this.#disposed) return;
    this.#scans.set(holder, scan);
    this.#index = buildWatchIndex(this.#scans.values());
    const wanted = new Map(watchTargets(scan).map((target) => [targetKey(target), target]));
    const work: Promise<void>[] = [];
    for (const subscription of [...this.#subscriptions.values()]) {
      if (subscription.holders.has(holder) && !wanted.has(subscription.key)) {
        work.push(this.#releaseFrom(subscription, holder));
      }
    }
    for (const [key, target] of wanted) work.push(this.#acquire(key, target, holder));
    await Promise.all(work);
    this.#forgetUnwatched();
  }

  /** Stops watching for `holder` (its window closed or changed folder). */
  async release(holder: number): Promise<void> {
    if (!this.#scans.delete(holder)) return;
    this.#index = buildWatchIndex(this.#scans.values());
    await Promise.all(
      [...this.#subscriptions.values()]
        .filter((subscription) => subscription.holders.has(holder))
        .map((subscription) => this.#releaseFrom(subscription, holder)),
    );
    this.#forgetUnwatched();
  }

  /** The backend watching: `fs.watch` once any folder had to fall back to it. */
  backend(): BackendName {
    const used = [...this.#subscriptions.values()].map((subscription) => subscription.backend);
    if (used.includes("fs.watch")) return "fs.watch";
    if (used.includes("fsevents")) return "fsevents";
    return this.#backends[0]?.name ?? "fsevents";
  }

  /** Every subscription, for `test.liveRefresh` and the measurements. */
  subscriptions(): SubscriptionInfo[] {
    return [...this.#subscriptions.values()].map((subscription) => ({
      kind: subscription.target.kind,
      path: subscription.target.path,
      backend: subscription.backend,
      holders: subscription.holders.size,
    }));
  }

  /** The scan `holder` watches, if any. */
  scanOf(holder: number): WatchedScan | undefined {
    return this.#scans.get(holder);
  }

  /** Where live refresh is not running for `holder`'s scan. */
  paused(holder: number): RefreshPause[] {
    const scan = this.#scans.get(holder);
    if (!scan) return [];
    const paused: RefreshPause[] = [];
    for (const checkout of scan.checkouts) {
      const since = this.#storm.paused().get(checkout.path);
      if (since !== undefined) paused.push({ path: checkout.path, reason: "eventStorm", since });
    }
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.unavailableSince === null || !subscription.holders.has(holder)) continue;
      paused.push({
        path: subscription.target.path,
        reason: "watcherError",
        since: subscription.unavailableSince,
      });
    }
    return paused;
  }

  /**
   * The person's Refresh: working-tree refresh runs again in `holder`'s checkouts after a
   * storm, and each folder no backend could watch is tried once more.
   */
  async resume(holder: number): Promise<void> {
    const scan = this.#scans.get(holder);
    if (!scan) return;
    let changed = false;
    for (const checkout of scan.checkouts) changed = this.#storm.resume(checkout.path) || changed;
    const retries: Promise<void>[] = [];
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.unavailableSince === null || !subscription.holders.has(holder)) continue;
      subscription.unavailableSince = null;
      changed = true;
      subscription.ready = this.#subscribe(subscription);
      retries.push(subscription.ready);
    }
    if (changed) this.#onPausedChange();
    await Promise.all(retries);
  }

  /** Test-only: drops every event while `true`, as if they were lost while the Mac slept. */
  suspend(suspended: boolean): void {
    this.#suspended = suspended;
  }

  /** Stops every watcher (the core service shutting down). */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#debouncer.dispose();
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    this.#scans.clear();
    await Promise.all(subscriptions.map((subscription) => this.#close(subscription)));
  }

  #acquire(key: string, target: WatchTarget, holder: number): Promise<void> {
    const existing = this.#subscriptions.get(key);
    if (existing) {
      existing.holders.add(holder);
      return existing.ready;
    }
    const subscription: Subscription = {
      key,
      target,
      holders: new Set([holder]),
      backend: null,
      handle: null,
      ready: Promise.resolve(),
      closed: false,
      unavailableSince: null,
    };
    this.#subscriptions.set(key, subscription);
    subscription.ready = this.#subscribe(subscription);
    return subscription.ready;
  }

  /** Tries each backend once, in order. */
  async #subscribe(subscription: Subscription): Promise<void> {
    const { target } = subscription;
    for (const backend of this.#backends) {
      try {
        const handle = await backend.subscribe(
          target,
          (events) => this.#onEvents(subscription, events),
          (error, fatal) => this.#onError(subscription, backend.name, error, fatal),
        );
        if (subscription.closed) {
          await handle.close().catch(() => undefined);
          return;
        }
        subscription.handle = handle;
        subscription.backend = backend.name;
        return;
      } catch (error) {
        this.#log.warn("could not watch a folder", {
          path: target.path,
          kind: target.kind,
          backend: backend.name,
          error,
        });
        if (subscription.closed) return;
      }
    }
    subscription.unavailableSince = this.#now();
    this.#log.error("live refresh unavailable for a folder", {
      path: target.path,
      kind: target.kind,
    });
    this.#onPausedChange();
  }

  async #releaseFrom(subscription: Subscription, holder: number): Promise<void> {
    subscription.holders.delete(holder);
    if (subscription.holders.size > 0) return;
    this.#subscriptions.delete(subscription.key);
    const wasUnavailable = subscription.unavailableSince !== null;
    await this.#close(subscription);
    if (wasUnavailable) this.#onPausedChange();
  }

  async #close(subscription: Subscription): Promise<void> {
    subscription.closed = true;
    await subscription.ready;
    const handle = subscription.handle;
    subscription.handle = null;
    if (!handle) return;
    try {
      await handle.close();
    } catch (error) {
      this.#log.warn("could not stop watching a folder", { path: subscription.target.path, error });
    }
  }

  /** Storm state of checkouts no scan watches any more is forgotten. */
  #forgetUnwatched(): void {
    let changed = false;
    for (const checkoutPath of [...this.#storm.paused().keys()]) {
      if (this.#index.checkouts.has(checkoutPath)) continue;
      this.#storm.forget(checkoutPath);
      changed = true;
    }
    if (changed) this.#onPausedChange();
  }

  #onEvents(subscription: Subscription, events: readonly WatchEvent[]): void {
    if (this.#suspended || subscription.closed) return;
    const working = new Map<string, number>();
    for (const event of events) {
      const classified = classify(event.path, this.#index);
      if (classified) this.#route(subscription.target, classified, event, working);
    }
    for (const [checkoutPath, count] of working) {
      if (this.#storm.isPaused(checkoutPath)) continue;
      if (this.#storm.record(checkoutPath, count)) {
        this.#debouncer.drop(checkoutKey(checkoutPath), "workingTree");
        this.#log.warn("event storm; working-tree refresh paused", { checkoutPath });
        this.#onPausedChange();
        continue;
      }
      this.#debouncer.add(checkoutKey(checkoutPath), ["workingTree"]);
    }
  }

  /**
   * Each kind of target speaks for its own signals only: the scan root for folders that
   * appear or go, a working tree for edits, a repository for its git dirs, refs and
   * worktrees. The same file seen by two overlapping watches therefore counts once.
   */
  #route(
    target: WatchTarget,
    classified: Classified,
    event: WatchEvent,
    working: Map<string, number>,
  ): void {
    const { kind, checkoutPath, commonDir } = classified;
    switch (target.kind) {
      case "root":
        // A file written in a plain folder changes nothing the walk sees.
        if (kind === "structure" && event.type !== "update") {
          this.#debouncer.add(rootKey(target.path), ["structure"]);
        }
        return;
      case "workingTree":
        if (kind === "workingTree" && checkoutPath === target.path) {
          working.set(checkoutPath, (working.get(checkoutPath) ?? 0) + 1);
        }
        return;
      case "common":
      case "gitDir":
        if ((kind === "head" || kind === "index" || kind === "reflog") && checkoutPath) {
          this.#debouncer.add(checkoutKey(checkoutPath), [kind]);
        } else if (kind === "refs" && commonDir === target.path) {
          const ref: Gathered = classified.ref ? `ref:${classified.ref}` : ANY_REF;
          this.#debouncer.add(repositoryKey(commonDir), ["refs", ref]);
        } else if (kind === "structure" && commonDir === target.path) {
          this.#debouncer.add(repositoryKey(commonDir), ["structure"]);
        }
        return;
    }
  }

  /**
   * After trouble a watch reports, everything it covers is read again: events may have been
   * lost. A watch that stopped is reported unavailable, and not restarted.
   */
  #onError(subscription: Subscription, backend: BackendName, error: Error, fatal: boolean): void {
    if (subscription.closed) return;
    this.#log.warn("a watcher reported trouble", {
      path: subscription.target.path,
      backend,
      fatal,
      error: error.message,
    });
    if (fatal) {
      const handle = subscription.handle;
      subscription.handle = null;
      subscription.backend = null;
      subscription.unavailableSince = this.#now();
      void handle?.close().catch(() => undefined);
      this.#onPausedChange();
    }
    if (this.#suspended) return;
    const { kind, path } = subscription.target;
    if (kind === "root") this.#debouncer.add(rootKey(path), ["structure"]);
    if (kind === "workingTree" && !this.#storm.isPaused(path)) {
      this.#debouncer.add(checkoutKey(path), ["workingTree"]);
    }
    if (kind === "common") {
      this.#debouncer.add(repositoryKey(path), ["refs", ANY_REF, "structure"]);
    }
    if (kind === "common" || kind === "gitDir") {
      for (const checkout of this.#index.checkouts.values()) {
        if (checkout.commonDir === path || checkout.gitDir === path) {
          this.#debouncer.add(checkoutKey(checkout.path), ["head", "index", "reflog"]);
        }
      }
    }
  }

  #flush(key: string, items: Gathered[]): void {
    const separator = key.indexOf(SEPARATOR);
    const scope = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const kinds = items.filter((item): item is ChangeKind => !item.startsWith("ref:"));
    if (kinds.length === 0) return;
    if (scope === "checkout") {
      this.#onChange({ scope: "checkout", checkoutPath: id, kinds });
    } else if (scope === "repository") {
      const refs = items.filter((item) => item.startsWith("ref:"));
      this.#onChange({
        scope: "repository",
        commonDir: id,
        kinds,
        refs: refs.includes(ANY_REF) ? null : refs.map((ref) => ref.slice("ref:".length)),
      });
    } else {
      this.#onChange({ scope: "root", scanRoot: id, kinds });
    }
  }
}

function checkoutKey(checkoutPath: string): string {
  return `checkout${SEPARATOR}${checkoutPath}`;
}

function repositoryKey(commonDir: string): string {
  return `repository${SEPARATOR}${commonDir}`;
}

function rootKey(scanRoot: string): string {
  return `root${SEPARATOR}${scanRoot}`;
}
