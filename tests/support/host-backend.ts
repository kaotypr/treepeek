/**
 * A watch backend shaped like a host's (the editor extension's): it watches a folder
 * without its subfolders when the target asks for that, filters with the `isIgnored` the
 * service entry exports, batches events, and refuses a folder that is not there. Tests read
 * what it was asked to watch, and can lose events on purpose.
 */
import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import {
  isIgnored,
  type WatchBackend,
  type WatchEvent,
  type WatchSubscription,
  type WatchTarget,
} from "../../src/core/service";

/** One subscription the backend opened. */
export interface HostSubscription {
  readonly target: WatchTarget;
  readonly path: string;
  readonly recursive: boolean;
  closed: boolean;
  /** The core's handler for trouble. */
  readonly onError: (error: Error, fatal: boolean) => void;
}

export class HostBackend implements WatchBackend {
  readonly name = "host";
  readonly nonRecursive = true;
  /** Every subscription opened, closed ones included, in order. */
  readonly subscriptions: HostSubscription[] = [];
  /** Folders whose events are dropped, as if the host never saw them. */
  readonly muted = new Set<string>();
  /** Folders refused because they were missing. */
  readonly refused: string[] = [];

  async subscribe(
    target: WatchTarget,
    onEvents: (events: WatchEvent[]) => void,
    onError: (error: Error, fatal: boolean) => void,
  ): Promise<WatchSubscription> {
    if (!existsSync(target.path)) {
      this.refused.push(target.path);
      throw new Error(`${target.path} does not exist`);
    }
    let batch: WatchEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const events = batch;
      batch = [];
      if (events.length > 0) onEvents(events);
    };
    const watcher: FSWatcher = watch(
      target.path,
      { recursive: target.recursive, persistent: false },
      (type, name) => {
        if (name === null || this.muted.has(target.path)) return;
        const path = join(target.path, name.toString());
        if (isIgnored(target, path)) return;
        batch.push({ path, type: type === "rename" ? "create" : "update" });
        timer ??= setTimeout(flush, 50);
      },
    );
    const subscription: HostSubscription = {
      target,
      path: target.path,
      recursive: target.recursive,
      closed: false,
      onError,
    };
    this.subscriptions.push(subscription);
    watcher.on("error", (error) => onError(error, true));
    return {
      close: async () => {
        subscription.closed = true;
        if (timer) clearTimeout(timer);
        watcher.close();
      },
    };
  }

  /** The subscriptions still open. */
  open(): HostSubscription[] {
    return this.subscriptions.filter((subscription) => !subscription.closed);
  }

  /** Tells the core that events of every open watch of `path` were lost. */
  lose(path: string): void {
    const watches = this.open().filter((subscription) => subscription.path === path);
    if (watches.length === 0) throw new Error(`nothing watches ${path}`);
    for (const subscription of watches) {
      subscription.onError(new Error("the host dropped events"), false);
    }
  }
}
