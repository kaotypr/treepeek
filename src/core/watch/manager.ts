import { stat } from "node:fs/promises";
import type { ChangeKind, RefreshPause } from "../../shared/domain/change";
import type { Logger } from "../../shared/log";
import { isWithin } from "../sessions/path-rule";
import type { WatchBackend, WatchEvent, WatchSubscription } from "./backends";
import { buildWatchIndex, type Classified, classify, type WatchIndex } from "./classify";
import { CheckoutDebouncer } from "./debounce";
import { StormGuard } from "./storm";
import {
  targetKey,
  type WatchedScan,
  type WatchLayout,
  type WatchTarget,
  watchTargets,
} from "./targets";

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
  /**
   * Tried in order for each folder; the next one only when the one before cannot watch it.
   * When every one of them can watch a folder without its subfolders, the repositories get
   * narrow targets (`watchTargets`).
   */
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
  /** The name of the backend watching it; `null` when none does (yet). */
  backend: string | null;
  holders: number;
}

interface Subscription {
  readonly key: string;
  readonly target: WatchTarget;
  readonly holders: Set<number>;
  backend: string | null;
  handle: WatchSubscription | null;
  /** Settles once a backend watches the folder or every backend has failed. */
  ready: Promise<void>;
  closed: boolean;
  /** When every backend failed; `null` while it is watched (or still subscribing). */
  unavailableSince: number | null;
  /**
   * An optional folder every backend refused because it is not there: nothing watches it,
   * nothing is paused, and the next scan that wants it tries again.
   */
  absent: boolean;
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
 * person's Refresh) tries such a folder once more. An optional folder that is missing is
 * not unavailable but absent, and the next scan that wants it tries again.
 */
export class WatchManager {
  readonly #backends: readonly WatchBackend[];
  readonly #layout: WatchLayout;
  readonly #log: Logger;
  readonly #onChange: (change: WatchChange) => void;
  readonly #onPausedChange: () => void;
  readonly #now: () => number;
  readonly #scans = new Map<number, WatchedScan>();
  readonly #subscriptions = new Map<string, Subscription>();
  /** Watches being stopped, so `dispose` can wait for every one of them. */
  readonly #closing = new Set<Promise<void>>();
  readonly #debouncer: CheckoutDebouncer<Gathered>;
  readonly #storm: StormGuard;
  #index: WatchIndex = buildWatchIndex([]);
  #suspended = false;
  #disposed = false;

  constructor(options: WatchManagerOptions) {
    this.#backends = options.backends;
    // A list that mixes in a backend needing recursion keeps every target recursive, so a
    // fallback never gets a target it cannot watch.
    this.#layout = {
      narrow:
        options.backends.length > 0 &&
        options.backends.every((backend) => backend.nonRecursive === true),
    };
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
    const wanted = new Map(
      watchTargets(scan, this.#layout).map((target) => [targetKey(target), target]),
    );
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

  /**
   * The backend watching: the one furthest down the list that any folder uses (a folder
   * fell back to it), else the first one.
   */
  backend(): string {
    const used = new Set(
      [...this.#subscriptions.values()].map((subscription) => subscription.backend),
    );
    const last = this.#backends.findLast((backend) => used.has(backend.name));
    return last?.name ?? this.#backends[0]?.name ?? "none";
  }

  /**
   * Every subscription, for `test.liveRefresh` and the measurements; an absent optional
   * folder is none, since nothing watches it.
   */
  subscriptions(): SubscriptionInfo[] {
    return [...this.#subscriptions.values()]
      .filter((subscription) => !subscription.absent)
      .map((subscription) => ({
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

  /**
   * Stops every watcher (the core service shutting down) and resolves once each one has,
   * including those a release had started to stop.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#debouncer.dispose();
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    this.#scans.clear();
    for (const subscription of subscriptions) void this.#close(subscription);
    while (this.#closing.size > 0) await Promise.all([...this.#closing]);
  }

  #acquire(key: string, target: WatchTarget, holder: number): Promise<void> {
    const existing = this.#subscriptions.get(key);
    if (existing) {
      existing.holders.add(holder);
      if (existing.absent) {
        // A folder that was missing may be there now.
        existing.absent = false;
        existing.ready = this.#subscribe(existing);
      }
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
      absent: false,
    };
    this.#subscriptions.set(key, subscription);
    subscription.ready = this.#subscribe(subscription);
    return subscription.ready;
  }

  /**
   * Tries each backend once, in order. An optional folder's failures are only logged once
   * it turns out to be there: a repository without linked worktrees is no trouble.
   */
  async #subscribe(subscription: Subscription): Promise<void> {
    const { target } = subscription;
    const failures: { backend: string; error: unknown }[] = [];
    const report = () => {
      for (const { backend, error } of failures.splice(0)) {
        this.#log.warn("could not watch a folder", {
          path: target.path,
          kind: target.kind,
          backend,
          error,
        });
      }
    };
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
        report();
        return;
      } catch (error) {
        failures.push({ backend: backend.name, error });
        if (!target.optional) report();
        if (subscription.closed) return;
      }
    }
    if (target.optional && (await isMissing(target.path))) {
      if (subscription.closed) return;
      subscription.absent = true;
      this.#log.debug("an optional folder is not there to watch", {
        path: target.path,
        kind: target.kind,
      });
      return;
    }
    report();
    if (subscription.closed) return;
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

  #close(subscription: Subscription): Promise<void> {
    subscription.closed = true;
    const closing = (async () => {
      await subscription.ready;
      const handle = subscription.handle;
      subscription.handle = null;
      if (!handle) return;
      try {
        await handle.close();
      } catch (error) {
        this.#log.warn("could not stop watching a folder", {
          path: subscription.target.path,
          error,
        });
      }
    })();
    this.#closing.add(closing);
    void closing.finally(() => this.#closing.delete(closing));
    return closing;
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
   *
   * Refs count from the common dir's own targets. Worktrees added, removed or moved count
   * from those too, and from a git dir's own target inside that common dir: with narrow
   * targets, only a linked worktree's own watch sees its `gitdir` file change.
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
        } else if (kind === "refs" && target.kind === "common" && commonDir === target.owner) {
          const ref: Gathered = classified.ref ? `ref:${classified.ref}` : ANY_REF;
          this.#debouncer.add(repositoryKey(commonDir), ["refs", ref]);
        } else if (
          kind === "structure" &&
          commonDir !== undefined &&
          (target.kind === "common"
            ? commonDir === target.owner
            : isWithin(target.owner, commonDir))
        ) {
          this.#debouncer.add(repositoryKey(commonDir), ["structure"]);
        }
        return;
    }
  }

  /**
   * After trouble a watch reports, everything it covers is read again: events may have been
   * lost. What it covers is what its owner speaks for, so a narrow target re-reads as much
   * as the whole folder's watch would. A watch that stopped is reported unavailable, and
   * not restarted.
   */
  #onError(subscription: Subscription, backend: string, error: Error, fatal: boolean): void {
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
    const { kind, owner } = subscription.target;
    if (kind === "root") this.#debouncer.add(rootKey(owner), ["structure"]);
    if (kind === "workingTree" && !this.#storm.isPaused(owner)) {
      this.#debouncer.add(checkoutKey(owner), ["workingTree"]);
    }
    if (kind === "common") {
      this.#debouncer.add(repositoryKey(owner), ["refs", ANY_REF, "structure"]);
    }
    if (kind === "common" || kind === "gitDir") {
      for (const checkout of this.#index.checkouts.values()) {
        if (checkout.commonDir === owner || checkout.gitDir === owner) {
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

/** Whether nothing is at `path` (a folder there that cannot be read is not missing). */
async function isMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}
