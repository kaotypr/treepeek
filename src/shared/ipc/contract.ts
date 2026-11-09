import * as v from "valibot";
import { GIT_PROBLEMS } from "../domain/git";
import { AppearanceSchema, SettingsPatchSchema, SettingsSchema } from "../settings";
import { type CallMap, defineCall, defineEvent, type EventMap } from "./define";

/**
 * Bumped whenever a channel's shape changes. Main, the core service and every window come
 * from one build, so a mismatch means something is badly wrong; it is still checked.
 */
export const CONTRACT_VERSION = 2;

const Empty = v.strictObject({});

export const SqliteProbeSchema = v.object({
  available: v.boolean(),
  version: v.optional(v.string()),
  error: v.optional(v.string()),
});
export type SqliteProbe = v.InferOutput<typeof SqliteProbeSchema>;

export const CoreStateSchema = v.picklist(["ready", "restarting", "failed"]);
export type CoreState = v.InferOutput<typeof CoreStateSchema>;

/** The domain's `GitState` (`shared/domain/git.ts`); a test keeps the two identical. */
export const GitStateSchema = v.variant("found", [
  v.object({ found: v.literal(true), path: v.string(), version: v.string() }),
  v.object({
    found: v.literal(false),
    problem: v.picklist(GIT_PROBLEMS),
    detail: v.exactOptional(v.string()),
  }),
]);

// Renderer ↔ main (`ipcRenderer.invoke`)

export const mainCalls = {
  "app.ping": defineCall({
    name: "app.ping",
    request: Empty,
    response: v.object({ process: v.literal("main"), at: v.number() }),
  }),
  "settings.get": defineCall({
    name: "settings.get",
    request: Empty,
    response: SettingsSchema,
  }),
  "settings.set": defineCall({
    name: "settings.set",
    request: SettingsPatchSchema,
    response: SettingsSchema,
  }),
} as const satisfies CallMap;

export const mainEvents = {
  "theme.changed": defineEvent({
    name: "theme.changed",
    payload: v.object({ resolved: v.picklist(["light", "dark"]), source: AppearanceSchema }),
    sticky: true,
  }),
  "core.state": defineEvent({
    name: "core.state",
    payload: v.object({ state: CoreStateSchema }),
    sticky: true,
  }),
  /** The git binary the core service found, or why none is usable (the setup screen). */
  "git.state": defineEvent({
    name: "git.state",
    payload: GitStateSchema,
    sticky: true,
  }),
} as const satisfies EventMap;

// Renderer ↔ core service (the window's MessagePort)

export const coreCalls = {
  "app.ping": defineCall({
    name: "app.ping",
    request: Empty,
    response: v.object({ process: v.literal("core"), pid: v.number(), at: v.number() }),
  }),
  /** Facts about the core service's runtime, including the `node:sqlite` probe. */
  "app.info": defineCall({
    name: "app.info",
    request: Empty,
    response: v.object({
      pid: v.number(),
      versions: v.object({ node: v.string(), electron: v.string() }),
      sqlite: SqliteProbeSchema,
    }),
  }),
  /** Aborts the call that was sent with this `requestId`; it then resolves `cancelled`. */
  "request.cancel": defineCall({
    name: "request.cancel",
    request: v.strictObject({ requestId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)) }),
    response: v.object({}),
  }),
} as const satisfies CallMap;

export const coreEvents = {} as const satisfies EventMap;

export type MainCalls = typeof mainCalls;
export type MainEvents = typeof mainEvents;
export type CoreCalls = typeof coreCalls;
export type CoreEvents = typeof coreEvents;
export type AllEvents = MainEvents & CoreEvents;
