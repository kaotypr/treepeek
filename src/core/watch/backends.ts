import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { isIgnored, parcelIgnore, type WatchTarget } from "./targets";

/** The core's own watcher backends (the desktop's), in the order it tries them. */
export type BackendName = "fsevents" | "fs.watch";

/** One filesystem event: an absolute path and what happened to it. */
export interface WatchEvent {
  path: string;
  type: "create" | "update" | "delete";
}

export interface WatchSubscription {
  close(): Promise<void>;
}

/**
 * Something that watches folders: the core's own backends, or one a host passes to the
 * core service (its editor's watcher, say).
 */
export interface WatchBackend {
  /** Shown by `test.liveRefresh` and in the logs. */
  readonly name: string;
  /**
   * Whether it can watch a folder without its subfolders. Only when every backend can does
   * live refresh ask for such watches (`watchTargets`, `narrow`); otherwise every target is
   * recursive, so a backend further down the list never gets one it cannot watch.
   */
  readonly nonRecursive?: boolean;
  /**
   * Watches `target`, with everything below it when `target.recursive`, else only its
   * direct entries. Rejects when the folder cannot be watched, a missing one included.
   * `onError` reports trouble after that: `fatal` when the watch has stopped, otherwise
   * events may have been lost and whatever it covers should be read again.
   */
  subscribe(
    target: WatchTarget,
    onEvents: (events: WatchEvent[]) => void,
    onError: (error: Error, fatal: boolean) => void,
  ): Promise<WatchSubscription>;
}

/**
 * One of the core's own backends. Neither declares `nonRecursive`, so every target they get
 * is recursive.
 */
type OwnBackend = WatchBackend & { readonly name: BackendName };

type ParcelModule = typeof import("@parcel/watcher");

let parcel: Promise<ParcelModule> | null = null;

/** Loaded on first use, so a native module that will not load only costs this backend. */
function loadParcel(): Promise<ParcelModule> {
  parcel ??= import("@parcel/watcher").then(
    (loaded) => (loaded as ParcelModule & { default?: ParcelModule }).default ?? loaded,
  );
  return parcel;
}

/**
 * `@parcel/watcher` with its FSEvents backend named outright: left to choose, it would
 * prefer Watchman when that is installed, and nothing here would know.
 */
export const parcelBackend: OwnBackend = {
  name: "fsevents",
  async subscribe(target, onEvents, onError) {
    const watcher = await loadParcel();
    const subscription = await watcher.subscribe(
      target.path,
      (error, events) => {
        if (error) onError(error, false);
        if (events.length > 0) onEvents(events);
      },
      { backend: "fs-events", ignore: parcelIgnore(target) },
    );
    return { close: () => subscription.unsubscribe() };
  },
};

/**
 * Node's recursive `fs.watch`, which uses FSEvents on macOS too, with no native module of
 * its own. It neither batches nor filters, so this does both.
 */
export const fsWatchBackend: OwnBackend = {
  name: "fs.watch",
  subscribe(target, onEvents, onError) {
    let batch: WatchEvent[] = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const events = batch;
      batch = [];
      if (events.length > 0) onEvents(events);
    };
    return new Promise((resolve, reject) => {
      let watcher: FSWatcher;
      try {
        watcher = watch(target.path, { recursive: true, persistent: false }, (type, name) => {
          if (name === null) return;
          const path = join(target.path, name.toString());
          if (isIgnored(target, path)) return;
          // A rename is something appearing or going; which one does not matter here.
          batch.push({ path, type: type === "rename" ? "create" : "update" });
          if (!scheduled) {
            scheduled = true;
            setTimeout(flush, 20);
          }
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      watcher.on("error", (error) => onError(error, true));
      resolve({
        close: async () => {
          watcher.close();
        },
      });
    });
  },
};

/**
 * The backends, FSEvents through `@parcel/watcher` first. `faults` (test-only) names
 * backends that fail every subscription, as a broken native module or a refused stream
 * would.
 */
export function defaultBackends(faults: ReadonlySet<BackendName> = new Set()): WatchBackend[] {
  const own: OwnBackend[] = [parcelBackend, fsWatchBackend];
  return own.map((backend) => (faults.has(backend.name) ? failing(backend.name) : backend));
}

function failing(name: BackendName): WatchBackend {
  return {
    name,
    subscribe: () => Promise.reject(new Error(`${name} is switched off for this test run`)),
  };
}

/** Parses the test-only fault list (`TREEPEEK_E2E_WATCHER_FAULT`, comma-separated). */
export function parseFaults(raw: string | undefined): Set<BackendName> {
  const faults = new Set<BackendName>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim();
    if (name === "fsevents" || name === "fs.watch") faults.add(name);
  }
  return faults;
}
