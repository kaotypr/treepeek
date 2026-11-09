/**
 * Builds `window.treepeek` from the IPC contract and exposes it, frozen, through the
 * context bridge. The renderer gets no `ipcRenderer`, no Node and no arbitrary channels.
 */
import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron";
import * as v from "valibot";
import {
  type CallMap,
  CONTRACT_VERSION,
  coreCalls,
  coreEvents,
  type EventDef,
  err,
  IPC_CHANNELS,
  mainCalls,
  mainEvents,
  type PortCall,
  PortFromCoreSchema,
  type Result,
} from "../shared/ipc";
import type { TreepeekApi } from "../shared/ipc/api";

const THEME_ARGUMENT = "--treepeek-theme=";
const events: Readonly<Record<string, EventDef>> = { ...mainEvents, ...coreEvents };

// Theme class: set before React renders, so the first frame already has the right colors.

function applyThemeClass(theme: string): void {
  const apply = (root: HTMLElement) => {
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme === "dark" ? "dark" : "light";
  };
  if (document.documentElement) {
    apply(document.documentElement);
    return;
  }
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    apply(document.documentElement);
  });
  observer.observe(document, { childList: true });
}

const initialTheme = process.argv
  .find((arg) => arg.startsWith(THEME_ARGUMENT))
  ?.slice(THEME_ARGUMENT.length);
if (initialTheme) applyThemeClass(initialTheme);

// Events

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const latest = new Map<string, unknown>();

function deliver(channel: string, payload: unknown): void {
  const event = events[channel];
  if (!event) return;
  const parsed = v.safeParse(event.payload, payload);
  if (!parsed.success) return;
  if (event.sticky) latest.set(channel, parsed.output);
  if (channel === "theme.changed") {
    applyThemeClass((parsed.output as { resolved: string }).resolved);
  }
  if (channel === "core.state" && (parsed.output as { state: string }).state !== "ready") {
    // The port's other end is gone. Fail what was sent and queue new calls until main
    // hands over a port to the restarted service.
    failInFlight("The core service is restarting");
    port?.close();
    port = null;
  }
  for (const listener of listeners.get(channel) ?? []) {
    try {
      listener(parsed.output);
    } catch (error) {
      console.error(`treepeek: a ${channel} listener threw`, error);
    }
  }
}

ipcRenderer.on(IPC_CHANNELS.event, (_event, envelope: { ch?: unknown; p?: unknown }) => {
  if (typeof envelope?.ch === "string") deliver(envelope.ch, envelope.p);
});

// Calls to main

async function callMain(channel: string, payload: unknown): Promise<Result<unknown>> {
  try {
    return (await ipcRenderer.invoke(IPC_CHANNELS.invoke, {
      ch: channel,
      p: payload,
    })) as Result<unknown>;
  } catch {
    return err("internal", `${channel} could not reach the main process`);
  }
}

// Folders dropped on a window. A page cannot read a dropped file's path, so the preload
// does, and asks main to open it (main checks it is an existing folder).

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

window.addEventListener(
  "dragover",
  (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  },
  true,
);

window.addEventListener(
  "drop",
  (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    const path = webUtils.getPathForFile(file);
    if (path) void callMain(mainCalls["folder.open"].name, { path });
  },
  true,
);

// Calls to the core service, over the MessagePort main hands this window

let port: MessagePort | null = null;
let contractOk = true;
let nextId = 1;
const queued: PortCall[] = [];
const inFlight = new Map<number, (result: Result<unknown>) => void>();
const waiting = new Map<number, (result: Result<unknown>) => void>();

function failInFlight(message: string): void {
  for (const resolve of inFlight.values()) resolve(err("coreUnavailable", message));
  inFlight.clear();
}

function send(call: PortCall): void {
  const resolve = waiting.get(call.id);
  if (!resolve || !port) return;
  waiting.delete(call.id);
  inFlight.set(call.id, resolve);
  port.postMessage(call);
}

function callCore(channel: string, payload: unknown): Promise<Result<unknown>> {
  if (!contractOk) {
    return Promise.resolve(err("internal", "Contract version mismatch with the core service"));
  }
  return new Promise((resolve) => {
    const call: PortCall = { t: "call", id: nextId++, ch: channel, p: payload };
    waiting.set(call.id, resolve);
    if (port) send(call);
    else queued.push(call);
  });
}

function onPortMessage(data: unknown): void {
  const parsed = v.safeParse(PortFromCoreSchema, data);
  if (!parsed.success) return;
  const message = parsed.output;
  switch (message.t) {
    case "hello":
      if (message.contractVersion !== CONTRACT_VERSION) {
        contractOk = false;
        console.error("treepeek: contract version mismatch with the core service");
        failInFlight("Contract version mismatch");
      }
      return;
    case "result": {
      const resolve = inFlight.get(message.id);
      if (!resolve) return;
      inFlight.delete(message.id);
      resolve(message.r as Result<unknown>);
      return;
    }
    case "event":
      deliver(message.ch, message.p);
      return;
  }
}

ipcRenderer.on(
  IPC_CHANNELS.corePort,
  (event: IpcRendererEvent, info: { contractVersion?: unknown }) => {
    const next = event.ports[0];
    if (!next) return;
    if (info?.contractVersion !== CONTRACT_VERSION) {
      contractOk = false;
      console.error("treepeek: contract version mismatch with the main process");
    }
    // Calls sent on the previous port went to a core service that is gone.
    failInFlight("The core service restarted");
    port?.close();
    port = next;
    port.onmessage = (message) => onPortMessage(message.data);
    for (const call of queued.splice(0)) send(call);
  },
);

// The API

function nest(
  calls: CallMap,
  invoke: (channel: string, payload: unknown) => Promise<Result<unknown>>,
): Record<string, Record<string, (request?: unknown) => Promise<Result<unknown>>>> {
  const api: Record<string, Record<string, (request?: unknown) => Promise<Result<unknown>>>> = {};
  for (const channel of Object.keys(calls)) {
    const dot = channel.indexOf(".");
    const head = channel.slice(0, dot);
    const tail = channel.slice(dot + 1);
    api[head] ??= {};
    api[head][tail] = (request?: unknown) => invoke(channel, request ?? {});
  }
  return api;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

const api = deepFreeze({
  main: nest(mainCalls, callMain),
  core: nest(coreCalls, callCore),
  on(event: string, listener: Listener): () => void {
    if (!Object.hasOwn(events, event)) throw new TypeError(`Unknown event: ${event}`);
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
    if (latest.has(event)) {
      const value = latest.get(event);
      queueMicrotask(() => {
        if (set.has(listener)) listener(value);
      });
    }
    return () => {
      set.delete(listener);
    };
  },
  off(event: string, listener: Listener): void {
    listeners.get(event)?.delete(listener);
  },
}) as unknown as TreepeekApi;

contextBridge.exposeInMainWorld("treepeek", api);
