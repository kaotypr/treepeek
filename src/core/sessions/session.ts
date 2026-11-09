import { join } from "node:path";
import type { Logger } from "../../shared/log";
import type { CheckoutResources, CoreState, RepositoryResources } from "../cache/shared-state";
import { GitError } from "../git/errors";
import type { CoreRpc } from "../rpc";
import type { ScanContext } from "../scan/context";
import { refreshStart, type ScannedCheckout } from "../scan/resolve-checkout";
import { resolveScan, type ScanResult, walkScanRoot } from "../scan/scan";
import type { WalkResult } from "../scan/walk";
import type { ReviewStore } from "../store/review-store";
import { isWithin, realPathOf } from "./path-rule";

/** What every session shares: the core service's repository state and local store. */
export interface SessionServices {
  readonly state: CoreState;
  /** The local store, or `null` when it is not open (scans still run; overrides fail). */
  store(): ReviewStore | null;
}

/** The paths one scan produced, for the path rule. */
interface ScanView {
  /** Real absolute paths of every folder the walk listed, the scan root included. */
  folders: ReadonlySet<string>;
  /** Every checkout resolved so far, by real path. */
  readonly checkouts: Map<string, ScannedCheckout>;
}

/** One scan of a session, started by `Session.startScan`. */
export interface ScanRun {
  /** Aborted by the call's own signal, a newer scan, `session.open` or closing. */
  readonly signal: AbortSignal;
  /** Step 1. Throws a `cancelled` `GitError` once the run is stopped. */
  walk(): Promise<WalkResult>;
  /**
   * Steps 2 to 5, handing each checkout to `onCheckout` as it resolves. Resolves `null`
   * when the run was stopped or replaced before it finished; the session then keeps its
   * previous scan.
   */
  resolve(
    walked: WalkResult,
    onCheckout: (checkout: ScannedCheckout) => void,
  ): Promise<ScanResult | null>;
}

/**
 * A window's session in the core service (architecture design, "Why one shared core
 * service"): its scan root, its scans, and the shared repository resources those scans
 * use. Resources are acquired from `CoreState` with the window id as the holder and
 * released when they leave the session's scan, when the scan root changes, and when the
 * session closes.
 */
export class Session {
  /** The window id; also the holder of everything the session acquires. */
  readonly id: number;
  readonly rpc: CoreRpc;
  readonly log: Logger;
  readonly #services: SessionServices;
  #scanRoot: string | null = null;
  #opened = 0;
  #lastScan: ScanResult | null = null;
  #last: ScanView | null = null;
  #current: ScanView | null = null;
  #scanController: AbortController | null = null;
  readonly #repositories = new Set<string>();
  readonly #checkouts = new Set<string>();
  #closed = false;

  constructor(id: number, rpc: CoreRpc, services: SessionServices, log: Logger) {
    this.id = id;
    this.rpc = rpc;
    this.#services = services;
    this.log = log;
  }

  /** The real path the window scans, or `null` before `session.open`. */
  get scanRoot(): string | null {
    return this.#scanRoot;
  }

  /** The last scan that finished, or `null`. */
  get lastScan(): ScanResult | null {
    return this.#lastScan;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Whether a scan is running. */
  get scanning(): boolean {
    return this.#scanController !== null;
  }

  /**
   * Sets the scan root (a real path to a folder) and returns a new session id. A scan in
   * progress stops. A different root also forgets the previous scans and releases what
   * they held.
   */
  open(scanRoot: string): string {
    this.#assertOpen();
    this.#stopScan();
    if (scanRoot !== this.#scanRoot) {
      this.#releaseAll();
      this.#scanRoot = scanRoot;
      this.#lastScan = null;
      this.#last = null;
      this.#current = null;
    }
    this.#opened += 1;
    return `${this.id}-${this.#opened}`;
  }

  /**
   * Starts a scan of the scan root, stopping the one in progress. `callSignal` is the
   * signal of the call that asked for it, so cancelling that call stops the scan too.
   */
  startScan(callSignal: AbortSignal): ScanRun {
    this.#assertOpen();
    const root = this.#scanRoot;
    if (root === null) throw new GitError("invalidRequest", "The session has no scan root.");
    this.#stopScan();
    const controller = new AbortController();
    this.#scanController = controller;
    const signal = AbortSignal.any([callSignal, controller.signal]);
    const ctx: ScanContext = {
      scanRoot: root,
      signal,
      store: this.#services.store(),
      repository: (commonDir) => this.#acquireRepository(commonDir),
      log: this.log,
    };
    const startedAt = Date.now();
    const view: ScanView = { folders: new Set(), checkouts: new Map() };
    const isCurrent = () => !this.#closed && !signal.aborted && this.#scanController === controller;
    const settle = () => {
      if (this.#scanController === controller) this.#scanController = null;
      if (this.#current === view) this.#current = null;
    };

    return {
      signal,
      walk: async () => {
        try {
          const walked = await walkScanRoot(ctx);
          if (!isCurrent()) throw cancelled();
          view.folders = new Set(walked.folders.map((folder) => join(root, folder.relativePath)));
          this.#current = view;
          return walked;
        } catch (error) {
          settle();
          throw error;
        }
      },
      resolve: async (walked, onCheckout) => {
        try {
          const result = await resolveScan(ctx, walked, startedAt, (checkout) => {
            if (!isCurrent()) return;
            view.checkouts.set(checkout.checkout.path, checkout);
            onCheckout(checkout);
          });
          if (!isCurrent()) return null;
          this.#complete(view, result);
          return result;
        } catch (error) {
          if (signal.aborted || !isCurrent()) return null;
          throw error;
        } finally {
          settle();
        }
      },
    };
  }

  /**
   * The path rule (architecture design, "Security boundary"): after resolving symlinks, the
   * path is one the session's scan produced (the scan root, a folder of the tree, a
   * checkout) or lies inside a scanned checkout. A symlink inside a checkout that points
   * outside it resolves outside, so it fails. Both the last finished scan and the one in
   * progress count.
   */
  async isInScan(path: string): Promise<boolean> {
    if (this.#closed) return false;
    const real = await realPathOf(path);
    if (real === null) return false;
    for (const view of this.#views()) {
      if (view.folders.has(real) || view.checkouts.has(real)) return true;
      for (const checkoutPath of view.checkouts.keys()) {
        if (isWithin(real, checkoutPath)) return true;
      }
    }
    return false;
  }

  /** The scanned checkout whose path `path` resolves to exactly, or `null`. */
  async findCheckout(path: string): Promise<ScannedCheckout | null> {
    if (this.#closed) return null;
    const real = await realPathOf(path);
    if (real === null) return null;
    for (const view of this.#views()) {
      const found = view.checkouts.get(real);
      if (found) return found;
    }
    return null;
  }

  /**
   * The previous checkout of the same repository on the last finished scan's timeline:
   * `null` when it has none, `undefined` when no finished scan has placed `scanned` yet.
   */
  async predecessorOf(scanned: ScannedCheckout): Promise<ScannedCheckout | null | undefined> {
    const entry = this.#lastScan?.timeline.find(
      (item) => item.checkoutPath === scanned.checkout.path,
    );
    if (!entry) return undefined;
    if (entry.predecessor === null) return null;
    return (await this.findCheckout(entry.predecessor)) ?? null;
  }

  /**
   * The shared resources of a scanned checkout and its repository, held by this session
   * until they leave its scan or it closes (a comparison can run before the scan that found
   * the checkout has finished).
   */
  resourcesOf(scanned: ScannedCheckout): {
    repo: RepositoryResources;
    checkout: CheckoutResources;
  } {
    const repo = this.#acquireRepository(scanned.commonDir);
    const checkout = this.#services.state.acquireCheckout(this.id, scanned.checkout.path);
    this.#checkouts.add(scanned.checkout.path);
    return { repo, checkout };
  }

  /**
   * Re-derives a checkout's start and history after its override changed, and keeps the
   * result as the session's view of that checkout.
   */
  async refreshStart(scanned: ScannedCheckout, signal: AbortSignal): Promise<ScannedCheckout> {
    const repo = this.#acquireRepository(scanned.commonDir);
    const updated = await refreshStart(scanned, {
      repo,
      store: this.#services.store(),
      signal,
      log: this.log,
    });
    if (this.#closed) throw cancelled();
    for (const view of this.#views()) {
      if (view.checkouts.has(updated.checkout.path)) {
        view.checkouts.set(updated.checkout.path, updated);
      }
    }
    if (this.#lastScan) {
      this.#lastScan = {
        ...this.#lastScan,
        checkouts: this.#lastScan.checkouts.map((item) =>
          item.checkout.path === updated.checkout.path ? updated : item,
        ),
      };
    }
    return updated;
  }

  /** Stops the scan, closes the port and releases everything the session holds. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopScan();
    this.rpc.close();
    this.#releaseAll();
    this.#current = null;
    this.#last = null;
    this.#lastScan = null;
  }

  #views(): ScanView[] {
    return [this.#current, this.#last].filter((view): view is ScanView => view !== null);
  }

  #complete(view: ScanView, result: ScanResult): void {
    for (const checkout of result.checkouts) view.checkouts.set(checkout.checkout.path, checkout);
    this.#last = view;
    this.#lastScan = result;
    const repositories = new Set(result.checkouts.map((item) => item.commonDir));
    const checkouts = new Set(result.checkouts.map((item) => item.checkout.path));
    for (const path of checkouts) {
      this.#services.state.acquireCheckout(this.id, path);
      this.#checkouts.add(path);
    }
    for (const commonDir of [...this.#repositories]) {
      if (repositories.has(commonDir)) continue;
      this.#services.state.releaseRepository(this.id, commonDir);
      this.#repositories.delete(commonDir);
    }
    for (const path of [...this.#checkouts]) {
      if (checkouts.has(path)) continue;
      this.#services.state.releaseCheckout(this.id, path);
      this.#checkouts.delete(path);
    }
  }

  #acquireRepository(commonDir: string): RepositoryResources {
    if (this.#closed) throw cancelled();
    const resources = this.#services.state.acquireRepository(this.id, commonDir);
    this.#repositories.add(commonDir);
    return resources;
  }

  #stopScan(): void {
    const controller = this.#scanController;
    this.#scanController = null;
    this.#current = null;
    controller?.abort();
  }

  #releaseAll(): void {
    this.#services.state.releaseHolder(this.id);
    this.#repositories.clear();
    this.#checkouts.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw cancelled();
  }
}

function cancelled(): GitError {
  return new GitError("cancelled", "The session is closed.");
}
