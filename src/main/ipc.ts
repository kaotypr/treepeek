import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import {
  type CallDef,
  type EventDef,
  type EventPayload,
  err,
  IPC_CHANNELS,
  parseEvent,
} from "../shared/ipc";
import type { Logger } from "../shared/log";
import { type MainHandler, MainRouter } from "./router";

let router: MainRouter | null = null;

export interface MainIpcOptions {
  log: Logger;
  /** True when the event comes from the top frame of one of the app's own windows. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
}

/** Installs the one invoke channel every main call travels through. */
export function installMainIpc(options: MainIpcOptions): void {
  const active = new MainRouter(options.log);
  router = active;
  ipcMain.handle(IPC_CHANNELS.invoke, (event, envelope: unknown) => {
    if (!options.isTrustedSender(event)) {
      options.log.warn("rejected a call from an untrusted frame", {
        url: event.senderFrame?.url,
      });
      return err("invalidRequest", "Untrusted sender");
    }
    return active.dispatch(envelope, { windowId: event.sender.id });
  });
}

/** Registers main's handler for one contract call; payloads are validated before it runs. */
export function handleMain<C extends CallDef>(call: C, handler: MainHandler<C>): void {
  if (!router) throw new Error("installMainIpc() must run before handleMain()");
  router.handle(call, handler);
}

export function emitToWindow<E extends EventDef>(
  win: BrowserWindow,
  event: E,
  payload: EventPayload<E>,
  log?: Logger,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const parsed = parseEvent(event, payload);
  if (!parsed.ok) {
    log?.error("refusing to emit an invalid event payload", parsed.error);
    return;
  }
  win.webContents.send(IPC_CHANNELS.event, { ch: event.name, p: parsed.value });
}
