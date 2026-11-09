/**
 * The core service: one Electron utility process for the whole app. It owns every Git and
 * filesystem operation (later plans) and serves each window over its own MessagePort.
 */
import type { MessagePortMain } from "electron";
import * as v from "valibot";
import { CONTRACT_VERSION, type CoreToMain, coreCalls, MainToCoreSchema, ok } from "../shared/ipc";
import type { DiscoverOptions } from "./git/discover";
import { rediscoverGit } from "./git/runtime";
import { createLogger, initCoreLog } from "./log";
import { probeSqlite } from "./probe-sqlite";
import type { CoreRpc, PortLike } from "./rpc";
import { SessionRegistry } from "./sessions/registry";

const log = createLogger("service");
const parentPort = process.parentPort;
const sqlite = probeSqlite();

function send(message: CoreToMain): void {
  parentPort.postMessage(message);
}

/** What discovery runs with; `core.init` sets both, `settings.gitPath` changes the override. */
const discovery: DiscoverOptions = { override: null, loginPath: null };

/** Runs git discovery and reports the result to main, which forwards it to every window. */
async function discoverAndReport(): Promise<void> {
  const state = await rediscoverGit({ ...discovery });
  // A newer discovery started meanwhile; it reports instead.
  if (state === undefined) return;
  log.info("git discovery", state);
  send({ type: "git.state", state });
}

function registerHandlers(rpc: CoreRpc): void {
  rpc.onCall(coreCalls["app.ping"], () =>
    ok({ process: "core", pid: process.pid, at: Date.now() }),
  );
  rpc.onCall(coreCalls["app.info"], () =>
    ok({
      pid: process.pid,
      versions: { node: process.versions.node, electron: process.versions.electron ?? "" },
      sqlite,
    }),
  );
}

const sessions = new SessionRegistry(log, registerHandlers);

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
      log.info("core service started", {
        pid: process.pid,
        node: process.versions.node,
        electron: process.versions.electron,
        sqlite,
      });
      send({ type: "core.ready", pid: process.pid, contractVersion: CONTRACT_VERSION });
      discovery.override = message.gitPathOverride;
      discovery.loginPath = message.loginPath;
      void discoverAndReport();
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
      const session = sessions.open(message.windowId, adaptPort(port));
      port.on("close", () => {
        if (sessions.get(message.windowId) === session) sessions.close(message.windowId);
      });
      return;
    }
    case "session.close":
      sessions.close(message.windowId);
      return;
    case "settings.gitPath":
      discovery.override = message.path;
      void discoverAndReport();
      return;
  }
});

process.on("uncaughtException", (error) => {
  log.error("uncaught exception", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason);
});
