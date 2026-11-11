/**
 * Core-service sessions over real MessagePorts for unit tests: a `SessionRegistry` with the
 * session handlers installed, and a renderer-side client that records every result and
 * event in the order they arrive.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { CoreState } from "../../src/core/cache/shared-state";
import { registerSessionCalls } from "../../src/core/handlers";
import type { PortLike } from "../../src/core/rpc";
import { SessionRegistry } from "../../src/core/sessions/registry";
import type { Session, SessionServices } from "../../src/core/sessions/session";
import type { ReviewStore } from "../../src/core/store/review-store";
import { defaultBackends } from "../../src/core/watch/backends";
import { LiveRefresh, type LiveRefreshOptions } from "../../src/core/watch/live";
import type { PortFromCore, Result } from "../../src/shared/ipc";
import { quietLogger } from "./core-scan";
import { testGitPath } from "./git";

export type Arrival =
  | { kind: "result"; id: number; result: Result<unknown> }
  | { kind: "event"; channel: string; payload: unknown };

export interface Client {
  /** Every result and event, in arrival order. */
  readonly arrivals: Arrival[];
  call<T = unknown>(channel: string, payload: unknown): Promise<Result<T>>;
  /** The payloads of one event, in order. */
  events<T = unknown>(channel: string): T[];
  /** Resolves once `count` events of `channel` have arrived. */
  waitForEvent(channel: string, count?: number, timeoutMs?: number): Promise<void>;
}

/** A `node:worker_threads` port as the core service's side of a session. */
export function adapt(port: MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on("message", listener),
    close: () => port.close(),
  };
}

/** The renderer's side of a session, over the other end of the channel. */
export function client(port: MessagePort): Client {
  let nextId = 1;
  const waiting = new Map<number, (result: Result<unknown>) => void>();
  const arrivals: Arrival[] = [];
  const watchers = new Set<() => void>();
  port.on("message", (message: PortFromCore) => {
    if (message.t === "result") {
      const result = message.r as Result<unknown>;
      arrivals.push({ kind: "result", id: message.id, result });
      waiting.get(message.id)?.(result);
    } else if (message.t === "event") {
      arrivals.push({ kind: "event", channel: message.ch, payload: message.p });
    }
    for (const watcher of watchers) watcher();
  });
  const events = <T>(channel: string): T[] =>
    arrivals.flatMap((arrival) =>
      arrival.kind === "event" && arrival.channel === channel ? [arrival.payload as T] : [],
    );
  return {
    arrivals,
    call<T>(channel: string, payload: unknown): Promise<Result<T>> {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve as (result: Result<unknown>) => void);
        port.postMessage({ t: "call", id, ch: channel, p: payload });
      });
    },
    events,
    waitForEvent(channel, count = 1, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (events(channel).length < count) return;
          watchers.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(new Error(`timed out waiting for ${count} ${channel}`));
        }, timeoutMs);
        watchers.add(check);
        check();
      });
    },
  };
}

export interface Harness {
  readonly state: CoreState;
  readonly services: SessionServices;
  /** Live refresh, when the harness was asked for it. */
  readonly live: LiveRefresh | null;
  readonly registry: SessionRegistry;
  /** Opens a window's session; returns it with its client. */
  open(windowId: number): { session: Session; client: Client };
  /** Closes every session and the shared state. */
  dispose(): void;
  /**
   * Closes everything and resolves once every watcher has stopped. Folders a test deletes
   * afterwards are no longer watched: `@parcel/watcher` stops a stream itself when its
   * folder goes, and doing that while an unsubscribe of the same stream runs corrupts
   * memory.
   */
  disposeAndWait(): Promise<void>;
}

/** What live refresh runs with in a harness; real watchers unless `backends` says otherwise. */
export type HarnessLive = Partial<Pick<LiveRefreshOptions, "backends" | "timing">>;

/**
 * Sessions sharing one `CoreState` and the given store (`null`: none), with live refresh
 * when `live` is given.
 */
export function harness(store: () => ReviewStore | null = () => null, live?: HarnessLive): Harness {
  const state = new CoreState();
  const refresh = live
    ? new LiveRefresh({
        state,
        store,
        sessions: () => registry.all(),
        log: quietLogger(),
        backends: live.backends ?? defaultBackends(),
        ...(live.timing ? { timing: live.timing } : {}),
      })
    : null;
  const services: SessionServices = {
    state,
    store,
    sessions: () => registry.all(),
    ...(refresh ? { live: refresh } : {}),
  };
  const registry: SessionRegistry = new SessionRegistry(quietLogger(), services, (session) =>
    registerSessionCalls(session, services),
  );
  const ports: MessagePort[] = [];
  return {
    state,
    services,
    live: refresh,
    registry,
    open(windowId) {
      const { port1, port2 } = new MessageChannel();
      ports.push(port1, port2);
      const session = registry.open(windowId, adapt(port1));
      return { session, client: client(port2) };
    },
    dispose() {
      registry.closeAll();
      void refresh?.dispose();
      state.close();
      for (const port of ports) port.close();
    },
    async disposeAndWait() {
      registry.closeAll();
      await refresh?.dispose();
      state.close();
      for (const port of ports) port.close();
    },
  };
}

/**
 * Writes a script that waits `seconds` and then runs the tests' git with the same
 * arguments (`exec`, so the pid stays the one the core service started). Real git still
 * does the work; the delay only makes a scan slow enough to stop half way.
 */
export function slowGit(path: string, seconds: number): string {
  const git = testGitPath().replaceAll("'", "'\\''");
  writeFileSync(path, `#!/bin/sh\nsleep ${seconds}\nexec '${git}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Whether a process is still running. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
