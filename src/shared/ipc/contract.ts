import * as v from "valibot";
import { LISTABLE_COMPARISON_KINDS } from "../domain/compare";
import { GIT_PROBLEMS } from "../domain/git";
import {
  AppearanceSchema,
  SettingsPatchSchema,
  SettingsSchema,
  WindowUiStateSchema,
} from "../settings";
import { type CallMap, defineCall, defineEvent, type EventMap } from "./define";
import {
  CheckoutSchema,
  ComparisonResultSchema,
  FileCategorySchema,
  FileDiffSchema,
  FolderNodeSchema,
  PathSchema,
  RefSchema,
  RepositorySchema,
  ScanProblemSchema,
  TimelineEntrySchema,
} from "./domain-schemas";

/**
 * Bumped whenever a channel's shape changes. Main, the core service and every window come
 * from one build, so a mismatch means something is badly wrong; it is still checked.
 */
export const CONTRACT_VERSION = 6;

const Empty = v.strictObject({});

const RequestId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

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
  /**
   * Shows the native folder dialog attached to the calling window. A chosen folder opens in
   * its own window, or focuses the window already showing it; `null` when cancelled.
   */
  "folder.choose": defineCall({
    name: "folder.choose",
    request: Empty,
    response: v.nullable(v.object({ path: v.string() })),
  }),
  /**
   * Opens one of the recent folders (`settings.recentFolders`). A path that is not on that
   * list fails `invalidRequest`; one that no longer exists is dropped from it.
   */
  "folder.openRecent": defineCall({
    name: "folder.openRecent",
    request: v.strictObject({ path: PathSchema }),
    response: v.object({}),
  }),
  /**
   * Opens a folder dropped on a window (the preload reads the dropped file's path). Opening
   * a folder only scans it, which `session.open` allows for any folder already; anything
   * that is not an existing folder fails `invalidRequest`.
   */
  "folder.open": defineCall({
    name: "folder.open",
    request: v.strictObject({ path: PathSchema }),
    response: v.object({}),
  }),
  /** Saves the calling scan window's layout and view, restored with the window on launch. */
  "window.state": defineCall({
    name: "window.state",
    request: v.strictObject({ ui: WindowUiStateSchema }),
    response: v.object({}),
  }),
} as const satisfies CallMap;

export const mainEvents = {
  /**
   * What this window shows: a scan root (a scan window) or `null` (the welcome window),
   * the layout it saved last time, and whether the side panels sit on vibrancy.
   */
  "window.scanRoot": defineEvent({
    name: "window.scanRoot",
    payload: v.object({
      scanRoot: v.nullable(v.string()),
      ui: v.nullable(WindowUiStateSchema),
      vibrancy: v.boolean(),
    }),
    sticky: true,
  }),
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
  /**
   * Aborts the call that was sent with this `requestId`; it then resolves `cancelled`. Work
   * a call goes on with after answering (a scan streaming checkouts) stops too.
   */
  "request.cancel": defineCall({
    name: "request.cancel",
    request: v.strictObject({ requestId: RequestId }),
    response: v.object({}),
  }),
  /**
   * Sets the folder this window scans: an absolute path to an existing folder, kept as its
   * real path. Opening again replaces the scan root and stops a scan in progress. Fails
   * `gitNotFound` or `gitTooOld` while no usable git is found.
   */
  "session.open": defineCall({
    name: "session.open",
    request: v.strictObject({ scanRoot: PathSchema }),
    response: v.object({ sessionId: v.string(), gitVersion: v.string() }),
  }),
  /**
   * Scans the session's root. Answers with the folder tree as soon as the walk finishes;
   * then each checkout arrives as `scan.checkout` the moment it resolves, and `scan.done`
   * ends the scan. `request.cancel` with the same `requestId`, a newer `scan.start`, or
   * the window closing stops it and its git processes.
   */
  "scan.start": defineCall({
    name: "scan.start",
    request: v.strictObject({ requestId: RequestId }),
    response: v.object({
      scanRoot: v.string(),
      folders: v.array(FolderNodeSchema),
      depthLimit: v.number(),
    }),
  }),
  /**
   * Sets (a commit-ish) or clears (`null`) a checkout's start, stored locally per worktree
   * identity, and answers with the checkout as it is now: its start is the override, or the
   * reflog start again once cleared. `refNotFound` when the commit-ish names no commit.
   */
  "start.override": defineCall({
    name: "start.override",
    request: v.strictObject({
      checkoutPath: PathSchema,
      commit: v.nullable(RefSchema),
    }),
    response: CheckoutSchema,
  }),
  /**
   * A checkout's file list for one comparison kind (every kind but `sinceViewed`), with the
   * sides it compares, commit count, "contained" and a note. `ref` is the base for `base`
   * and is required there. `startOverride` is a start for this call alone (not stored),
   * used by `review`, `worktree`, `incoming` and `sincePrevious`. A kind the checkout
   * cannot have (no start, no HEAD, no direct previous checkout, no upstream, no common
   * ancestor) fails `refNotFound` with `detail.unavailable` naming why; a malformed or
   * missing `ref` fails `invalidRequest`.
   */
  "comparison.list": defineCall({
    name: "comparison.list",
    request: v.strictObject({
      checkoutPath: PathSchema,
      kind: v.picklist(LISTABLE_COMPARISON_KINDS),
      ref: v.exactOptional(RefSchema),
      startOverride: v.exactOptional(RefSchema),
    }),
    response: ComparisonResultSchema,
  }),
  /**
   * One file's diff in a comparison: Git's patch parsed into hunks, plus the full texts
   * within the diff pipeline's size limits. `comparison` names the comparison exactly as
   * `comparison.list` takes it (kind, `ref`, `startOverride`); the core service resolves
   * its sides again and takes the file's status, old path, blob ids and `resultHash` from
   * that comparison's list, never from the request. `path` is repository-relative (as
   * listed); `category` is required for `working` and refused for every other kind.
   *
   * Fails `notInScan` for a checkout outside the scan, or a path that is absolute, has a
   * `..` segment or resolves outside the checkout; `invalidRequest` with
   * `detail.notInComparison` for a path the comparison's list does not hold; and like
   * `comparison.list` for a kind the checkout cannot have. `request.cancel` with the same
   * `requestId` stops it and its git processes.
   */
  "diff.file": defineCall({
    name: "diff.file",
    request: v.strictObject({
      requestId: RequestId,
      checkoutPath: PathSchema,
      comparison: v.strictObject({
        kind: v.picklist(LISTABLE_COMPARISON_KINDS),
        ref: v.exactOptional(RefSchema),
        startOverride: v.exactOptional(RefSchema),
      }),
      path: PathSchema,
      category: v.exactOptional(FileCategorySchema),
    }),
    response: FileDiffSchema,
  }),
} as const satisfies CallMap;

export const coreEvents = {
  /** One checkout of the running scan, sent the moment it resolves. */
  "scan.checkout": defineEvent({
    name: "scan.checkout",
    payload: CheckoutSchema,
  }),
  /**
   * The running scan finished. `problems` lists folders that could not be read as checkouts
   * for a reason the person should see (Git's `safe.directory` refusal, a timeout).
   */
  "scan.done": defineEvent({
    name: "scan.done",
    payload: v.object({
      timeline: v.array(TimelineEntrySchema),
      repositories: v.array(RepositorySchema),
      durationMs: v.number(),
      problems: v.array(ScanProblemSchema),
    }),
  }),
} as const satisfies EventMap;

export type MainCalls = typeof mainCalls;
export type MainEvents = typeof mainEvents;
export type CoreCalls = typeof coreCalls;
export type CoreEvents = typeof coreEvents;
export type AllEvents = MainEvents & CoreEvents;
