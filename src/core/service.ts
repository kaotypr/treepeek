/**
 * The core service without a host: every Git and filesystem operation, one session per
 * window or view, all sharing one `CoreState`, one local store and one set of watchers.
 *
 * It runs in plain Node. It loads nothing from Electron, installs no process-wide handlers
 * and never exits the process; the host does all of that. The desktop app's utility
 * process (`index.ts`) is one such host.
 *
 * One service per process: the git it runs (`git/runtime.ts`) is module-global, so a
 * second service would change the first one's git.
 */
import type { GitState } from "../shared/domain/git";
import { coreCalls, ok } from "../shared/ipc";
import { createLogger, type LogSink } from "../shared/log";
import { CoreState } from "./cache/shared-state";
import { type DiscoverOptions, discoverGit } from "./git/discover";
import { rediscoverGit } from "./git/runtime";
import { registerSessionCalls } from "./handlers";
import { validatePaths } from "./handlers/paths";
import { probeSqlite } from "./probe-sqlite";
import { pruneOnStartup } from "./review/prune";
import type { PortLike } from "./rpc";
import { SessionRegistry } from "./sessions/registry";
import type { Session, SessionServices } from "./sessions/session";
import { openReviewStore } from "./store/open-store";
import type { ReviewStore } from "./store/review-store";
// Types only: the host picks the backends, so `@parcel/watcher` never enters this graph.
import type { WatchBackend } from "./watch/backends";
import { LiveRefresh } from "./watch/live";

export interface CoreServiceOptions {
  /** The store lives in `<dataDir>/store/`. */
  dataDir: string;
  logSink: LogSink;
  /** The git binary from settings; tried first. */
  gitPathOverride: string | null;
  /** `PATH` to search for git and to run it with. */
  loginPath: string | null;
  /** Tried in order for each folder. */
  watchBackends: readonly WatchBackend[];
  /** Called after every git discovery. */
  onGitState(state: GitState): void;
  /** Finds git; `discoverGit` by default. */
  discover?: (options: DiscoverOptions) => Promise<GitState>;
}

/** One attached session, as `attachSession` returned it. */
export interface SessionHandle {
  /**
   * Closes this session, and only it: a no-op once a newer session took its id, so a
   * window whose port closes after it re-attached keeps the new one.
   */
  close(): void;
}

export interface CoreService {
  /**
   * Opens a session for `id`, served over `port`, replacing one that id already had. After
   * `dispose`, the port is closed instead.
   */
  attachSession(id: number, port: PortLike): SessionHandle;
  /** Closes the session of `id`, whichever one it is. */
  closeSession(id: number): void;
  /** Changes the git override and runs discovery again; `onGitState` gets the result. */
  setGitPath(path: string | null): void;
  /** Reads every session's checkouts again (the machine woke from sleep). */
  revalidate(): Promise<void>;
  /** For each path, whether some session's scan holds it under the path rule. */
  validatePaths(paths: readonly string[]): Promise<boolean[]>;
  /** Closes every session, the caches and the store, and resolves once every watcher stopped. */
  dispose(): Promise<void>;
}

export function createCoreService(options: CoreServiceOptions): CoreService {
  const log = createLogger({ scope: "core:service", sink: options.logSink });
  const discover = options.discover ?? discoverGit;
  const sqlite = probeSqlite();

  /** Repository caches and batch processes, shared by every session. */
  const state = new CoreState();
  /** `null` when it could not be opened (or after `dispose`). */
  let store: ReviewStore | null = null;
  let disposed = false;
  let disposing: Promise<void> | null = null;

  /** The watchers and the refreshes they start, shared by every session. */
  const live = new LiveRefresh({
    state,
    store: () => store,
    sessions: () => sessions.all(),
    log: log.child("live"),
    backends: options.watchBackends,
  });
  const services: SessionServices = {
    state,
    store: () => store,
    sessions: () => sessions.all(),
    live,
  };

  const electron = process.versions.electron;
  const versions = { node: process.versions.node, ...(electron ? { electron } : {}) };

  function registerHandlers(session: Session): void {
    const { rpc } = session;
    rpc.onCall(coreCalls["app.ping"], () =>
      ok({ process: "core", pid: process.pid, at: Date.now() }),
    );
    rpc.onCall(coreCalls["app.info"], () => ok({ pid: process.pid, versions, sqlite }));
    registerSessionCalls(session, services);
  }

  const sessions = new SessionRegistry(log, services, registerHandlers);

  function openStore(): void {
    try {
      store = openReviewStore(options.dataDir, { log: log.child("store") });
      log.info("local store opened", { engine: store.engine });
    } catch (error) {
      // Scans still run from the reflog alone; start overrides and marks fail until a restart.
      log.error("could not open the local store", error);
      return;
    }
    try {
      const snapshots = pruneOnStartup(store);
      if (snapshots > 0) log.info("pruned review snapshots", { snapshots });
    } catch (error) {
      log.warn("could not prune review snapshots", { error });
    }
  }

  /** What discovery runs with; `setGitPath` changes the override. */
  const discovery: DiscoverOptions = {
    override: options.gitPathOverride,
    loginPath: options.loginPath,
  };

  /** Runs git discovery and reports the result, unless a newer one or `dispose` overtook it. */
  async function discoverAndReport(): Promise<void> {
    const next = await rediscoverGit({ ...discovery }, discover);
    if (next === undefined || disposed) return;
    log.info("git discovery", next);
    try {
      options.onGitState(next);
    } catch (error) {
      log.error("the git state callback failed", error);
    }
  }

  log.info("core service started", {
    pid: process.pid,
    node: process.versions.node,
    electron,
    sqlite,
  });
  openStore();
  void discoverAndReport();

  return {
    attachSession(id, port) {
      if (disposed) {
        port.close();
        return { close: () => {} };
      }
      const session = sessions.open(id, port);
      return {
        close: () => {
          if (sessions.get(id) === session) sessions.close(id);
        },
      };
    },
    closeSession(id) {
      sessions.close(id);
    },
    setGitPath(path) {
      if (disposed) return;
      discovery.override = path;
      void discoverAndReport();
    },
    revalidate() {
      return disposed ? Promise.resolve() : live.revalidate();
    },
    validatePaths(paths) {
      return validatePaths(sessions.all(), paths);
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      const watchers = live.dispose();
      sessions.closeAll();
      state.close();
      try {
        store?.close();
      } catch (error) {
        // The last write failed, as a JSON store's can when another process holds its
        // lock. Its pending changes are lost, but the host is shutting down: disposing
        // still has to finish, and the desktop calls this from its `exit` handler.
        log.error("could not close the local store", error);
      }
      store = null;
      disposing = watchers;
      return disposing;
    },
  };
}
