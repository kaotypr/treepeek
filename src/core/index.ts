/**
 * The desktop's core service: one Electron utility process for the whole app. This file
 * is its adapter to Electron. It speaks main's messages over the parent port, checks the
 * contract version, answers health checks and installs the process handlers; everything
 * else is the host-free service (`service.ts`), with one session per window.
 */
import type { MessagePortMain } from "electron";
import * as v from "valibot";
import { CONTRACT_VERSION, type CoreToMain, MainToCoreSchema } from "../shared/ipc";
import { type DiscoverOptions, discoverGit, probeGit } from "./git/discover";
import { coreLogSink, createLogger, initCoreLog } from "./log";
import type { PortLike } from "./rpc";
import { type CoreService, createCoreService } from "./service";
import { defaultBackends, parseFaults } from "./watch/backends";

const log = createLogger("service");
const parentPort = process.parentPort;

/** Created by `core.init`, which carries the user data folder; `null` until then. */
let service: CoreService | null = null;
/** The login `PATH` from `core.init`, which `git.probe` runs with. */
let loginPath: string | null = null;

/**
 * Test-only (honoured only with `NODE_ENV=test`): watcher backends that fail every
 * subscription, comma-separated (`fsevents`, `fs.watch`), so end-to-end tests reach the
 * `fs.watch` fallback and "Live refresh unavailable".
 */
const WATCHER_FAULT_ENV = "TREEPEEK_E2E_WATCHER_FAULT";
const watcherFaults = parseFaults(
  process.env.NODE_ENV === "test" ? process.env[WATCHER_FAULT_ENV] : undefined,
);

/**
 * Test-only (honoured only with `NODE_ENV=test`): discovery tries the override alone, as on
 * a Mac with no git anywhere else, so end-to-end tests can reach the git setup screen.
 */
const OVERRIDE_ONLY_ENV = "TREEPEEK_E2E_GIT_OVERRIDE_ONLY";
const overrideOnly = process.env.NODE_ENV === "test" && process.env[OVERRIDE_ONLY_ENV] === "1";
const NOWHERE = "/nonexistent/treepeek-e2e/git";

function discoverOverrideOnly(options: DiscoverOptions) {
  return discoverGit(
    { override: options.override, loginPath: null },
    { knownLocations: [], systemGit: NOWHERE },
  );
}

function send(message: CoreToMain): void {
  parentPort.postMessage(message);
}

function adaptPort(port: MessagePortMain): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on("message", (event) => listener(event.data));
      port.start();
    },
    close: () => port.close(),
  };
}

parentPort.on("message", (event) => {
  const parsed = v.safeParse(MainToCoreSchema, event.data);
  if (!parsed.success) {
    log.warn("dropped a malformed message from main", { issues: v.flatten(parsed.issues) });
    return;
  }
  const message = parsed.output;
  switch (message.type) {
    case "core.init": {
      initCoreLog(message.userDataDir);
      if (message.contractVersion !== CONTRACT_VERSION) {
        log.error("contract version mismatch with main", {
          main: message.contractVersion,
          core: CONTRACT_VERSION,
        });
        process.exit(1);
      }
      if (service) {
        log.warn("dropped a second core.init");
        return;
      }
      loginPath = message.loginPath;
      service = createCoreService({
        dataDir: message.userDataDir,
        logSink: coreLogSink,
        gitPathOverride: message.gitPathOverride,
        loginPath: message.loginPath,
        watchBackends: defaultBackends(watcherFaults),
        // Discovery reports only after an await, so main hears `core.ready` first.
        onGitState: (state) => send({ type: "git.state", state }),
        ...(overrideOnly ? { discover: discoverOverrideOnly } : {}),
      });
      if (watcherFaults.size > 0) {
        log.info("watcher backends switched off", { watcherFaults: [...watcherFaults] });
      }
      send({ type: "core.ready", pid: process.pid, contractVersion: CONTRACT_VERSION });
      return;
    }
    case "core.health":
      send({ type: "core.health", id: message.id });
      return;
    case "session.attach": {
      const port = event.ports[0];
      if (!port) {
        log.warn("session.attach arrived without a port", { windowId: message.windowId });
        return;
      }
      if (!service) {
        // Main attaches windows only after `core.ready`; this is a safety net.
        log.warn("session.attach arrived before core.init", { windowId: message.windowId });
        port.close();
        return;
      }
      const session = service.attachSession(message.windowId, adaptPort(port));
      port.on("close", () => session.close());
      return;
    }
    case "session.close":
      service?.closeSession(message.windowId);
      return;
    case "settings.gitPath":
      if (!service) {
        log.warn("settings.gitPath arrived before core.init");
        return;
      }
      service.setGitPath(message.path);
      return;
    case "power.resume":
      void service?.revalidate().catch((error: unknown) => {
        log.error("revalidating after sleep failed", error);
      });
      return;
    case "git.probe": {
      const { id, path } = message;
      probeGit(
        path,
        overrideOnly ? null : loginPath,
        overrideOnly ? { systemGit: NOWHERE } : {},
      ).then(
        (state) => send({ type: "git.probe", id, state }),
        (error: unknown) => {
          log.error("git.probe failed", error);
          send({ type: "git.probe", id, state: { found: false, problem: "notFound" } });
        },
      );
      return;
    }
    case "paths.validate": {
      const { id, paths } = message;
      const none = () => paths.map(() => false);
      if (!service) {
        send({ type: "paths.validate", id, valid: none() });
        return;
      }
      service.validatePaths(paths).then(
        (valid) => send({ type: "paths.validate", id, valid }),
        (error: unknown) => {
          log.error("paths.validate failed", error);
          send({ type: "paths.validate", id, valid: none() });
        },
      );
      return;
    }
  }
});

process.on("exit", () => {
  // Only the synchronous part runs here: sessions, caches and the store close at once.
  void service?.dispose();
});

process.on("uncaughtException", (error) => {
  log.error("uncaught exception", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason);
});
