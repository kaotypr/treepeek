import * as v from "valibot";
import { IpcErrorSchema } from "./result";

/** Electron IPC channel names between a window's preload and main. Nothing else is used. */
export const IPC_CHANNELS = Object.freeze({
  /** preload → main: `{ch, p}`; main answers with a `Result`. */
  invoke: "treepeek:invoke",
  /** main → preload: `{ch, p}` for main's events. */
  event: "treepeek:event",
  /** main → preload: carries the window's MessagePort to the core service. */
  corePort: "treepeek:core-port",
});

/** What the preload sends to main through `ipcRenderer.invoke`. */
export const InvokeEnvelopeSchema = v.object({
  ch: v.pipe(v.string(), v.maxLength(128)),
  p: v.unknown(),
});

// Main ↔ core service (the utility process's parent port)

const WindowId = v.pipe(v.number(), v.integer(), v.minValue(1));

export const MainToCoreSchema = v.variant("type", [
  v.object({
    type: v.literal("core.init"),
    contractVersion: v.number(),
    userDataDir: v.pipe(v.string(), v.minLength(1)),
    gitPathOverride: v.nullable(v.string()),
  }),
  v.object({ type: v.literal("core.health"), id: v.number() }),
  /** Carries one MessagePort in the message's `ports`. */
  v.object({ type: v.literal("session.attach"), windowId: WindowId }),
  v.object({ type: v.literal("session.close"), windowId: WindowId }),
]);
export type MainToCore = v.InferOutput<typeof MainToCoreSchema>;

export const CoreToMainSchema = v.variant("type", [
  v.object({ type: v.literal("core.ready"), pid: v.number(), contractVersion: v.number() }),
  v.object({ type: v.literal("core.health"), id: v.number() }),
]);
export type CoreToMain = v.InferOutput<typeof CoreToMainSchema>;

// Renderer (preload) ↔ core service, over the window's MessagePort

export const PortCallSchema = v.object({
  t: v.literal("call"),
  id: v.pipe(v.number(), v.integer()),
  ch: v.pipe(v.string(), v.maxLength(128)),
  p: v.unknown(),
});
export type PortCall = v.InferOutput<typeof PortCallSchema>;

export const PortFromCoreSchema = v.variant("t", [
  v.object({ t: v.literal("hello"), contractVersion: v.number() }),
  v.object({
    t: v.literal("result"),
    id: v.number(),
    r: v.variant("ok", [
      v.object({ ok: v.literal(true), value: v.unknown() }),
      v.object({ ok: v.literal(false), error: IpcErrorSchema }),
    ]),
  }),
  v.object({ t: v.literal("event"), ch: v.string(), p: v.unknown() }),
]);
export type PortFromCore = v.InferOutput<typeof PortFromCoreSchema>;
