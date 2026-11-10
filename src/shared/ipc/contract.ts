import * as v from "valibot";
import { CHECKABLE_COMMAND_IDS, COMMAND_IDS } from "../commands";
import { COMPARISON_KINDS, LISTABLE_COMPARISON_KINDS } from "../domain/compare";
import { GIT_PROBLEMS } from "../domain/git";
import {
  AppearanceSchema,
  BundleIdSchema,
  SettingsPatchSchema,
  SettingsSchema,
  WindowUiStateSchema,
} from "../settings";
import { type CallMap, defineCall, defineEvent, type EventMap } from "./define";
import {
  ChangeKindSchema,
  CheckoutSchema,
  ComparisonResultSchema,
  FileCategorySchema,
  FileDiffSchema,
  FolderNodeSchema,
  PathSchema,
  PreviousMarkSchema,
  RefreshPauseSchema,
  RefSchema,
  RepositorySchema,
  ReviewStatusSchema,
  ScanProblemSchema,
  TimelineEntrySchema,
} from "./domain-schemas";

/**
 * Bumped whenever a channel's shape changes. Main, the core service and every window come
 * from one build, so a mismatch means something is badly wrong; it is still checked.
 */
export const CONTRACT_VERSION = 9;

const Empty = v.strictObject({});

const RequestId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

/** Checkouts one `review.status` call may ask about. */
export const MAX_STATUS_CHECKOUTS = 1_000;

/** Paths one `review.mark` call may carry (an undo replays a whole worktree's marks). */
export const MAX_MARK_PATHS = 50_000;

/** A `resultHash` sent back by the renderer (an undo): bounded, checked by the core service. */
const ResultHashSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

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

/** What a window shows; main tells each page in `window.scanRoot`. */
export const WINDOW_KINDS = ["welcome", "scan", "settings", "about"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

/** The sections of the Settings window, in order. */
export const SETTINGS_SECTIONS = [
  "general",
  "review",
  "integrations",
  "git",
  "updates",
  "advanced",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** An installed app Treepeek can open things in ("Open in…"), as detection found it. */
export const DetectedAppSchema = v.object({
  bundleId: BundleIdSchema,
  name: v.string(),
  /** Where the `.app` bundle is. */
  path: v.string(),
  /** The editor can open a file at a line. */
  opensAtLine: v.boolean(),
});
export type DetectedApp = v.InferOutput<typeof DetectedAppSchema>;

/** What `clipboard.copy` puts on the clipboard. */
export const COPY_KINDS = ["path", "branch", "commit", "command"] as const;

const LocalPath = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.startsWith("/", "The path must be absolute"),
  v.check((path) => !path.includes("\0"), "The path must not contain NUL"),
);

const CommandIdSchema = v.picklist(COMMAND_IDS);

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
   * its own window, or focuses the window already showing it; `null` when cancelled. With
   * `replace`, a scan window that could not scan its folder closes once another one opens.
   */
  "folder.choose": defineCall({
    name: "folder.choose",
    request: v.strictObject({ replace: v.exactOptional(v.boolean()) }),
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
  /**
   * Which of the calling window's commands are enabled and which are checked now. Main
   * enables and checks the menu items of the focused window from it.
   */
  "window.commands": defineCall({
    name: "window.commands",
    request: v.strictObject({
      enabled: v.pipe(v.array(CommandIdSchema), v.maxLength(COMMAND_IDS.length)),
      checked: v.pipe(
        v.array(v.picklist(CHECKABLE_COMMAND_IDS)),
        v.maxLength(CHECKABLE_COMMAND_IDS.length),
      ),
    }),
    response: v.object({}),
  }),
  /** Opens the Settings window, or brings it forward, at `section` when given. */
  "settings.open": defineCall({
    name: "settings.open",
    request: v.strictObject({ section: v.exactOptional(v.picklist(SETTINGS_SECTIONS)) }),
    response: v.object({}),
  }),
  /**
   * "Open in…": shows a checkout folder (or a file) selected in Finder. Every `openIn.*`
   * path must lie in some window's scan (main asks the core service); `notInScan` otherwise.
   */
  "openIn.finder": defineCall({
    name: "openIn.finder",
    request: v.strictObject({ path: LocalPath }),
    response: v.object({}),
  }),
  /** Opens a file or folder in the configured editor, at `line` where the editor can. */
  "openIn.editor": defineCall({
    name: "openIn.editor",
    request: v.strictObject({
      path: LocalPath,
      line: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000))),
    }),
    response: v.object({}),
  }),
  /** Opens the configured terminal at a checkout folder. */
  "openIn.terminal": defineCall({
    name: "openIn.terminal",
    request: v.strictObject({ path: LocalPath }),
    response: v.object({}),
  }),
  /** Puts text on the clipboard: a checkout path, a branch name, a full commit id, a command. */
  "clipboard.copy": defineCall({
    name: "clipboard.copy",
    request: v.strictObject({
      text: v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
      kind: v.picklist(COPY_KINDS),
    }),
    response: v.object({}),
  }),
  /**
   * The installed editors and terminals Treepeek knows. Detected once per session and
   * cached; `refresh` looks again.
   */
  "integrations.detect": defineCall({
    name: "integrations.detect",
    request: v.strictObject({ refresh: v.exactOptional(v.boolean()) }),
    response: v.object({
      editors: v.array(DetectedAppSchema),
      terminals: v.array(DetectedAppSchema),
    }),
  }),
  /**
   * Lets the person pick a git binary in a native file dialog. The core service checks it;
   * a usable one becomes the override (`settings.gitPath`) and discovery runs again. The
   * answer carries what the check found, so a git that is too old is named where it was
   * picked; `null` when the dialog was cancelled.
   */
  "git.choose": defineCall({
    name: "git.choose",
    request: Empty,
    response: v.nullable(v.object({ path: v.string(), state: GitStateSchema })),
  }),
  /** Runs git discovery again ("Try again", "Detect again"); the result arrives as `git.state`. */
  "git.detect": defineCall({
    name: "git.detect",
    request: Empty,
    response: v.object({}),
  }),
  /**
   * Test-only (refused unless the app runs with `NODE_ENV=test`): does what the Mac waking
   * from sleep does, so an end-to-end test can check live refresh catches up after it.
   */
  "test.powerResume": defineCall({
    name: "test.powerResume",
    request: Empty,
    response: v.object({}),
  }),
  /** Shows the logs folder in Finder. */
  "logs.open": defineCall({
    name: "logs.open",
    request: Empty,
    response: v.object({}),
  }),
  /** What the About window shows: version, license, copyright and the bundled notices. */
  "about.info": defineCall({
    name: "about.info",
    request: Empty,
    response: v.object({
      name: v.string(),
      version: v.string(),
      license: v.string(),
      copyright: v.string(),
      /** The `NOTICE` file, when this build carries it. */
      notice: v.nullable(v.string()),
      /** `THIRD_PARTY_NOTICES`, when this build carries it. */
      thirdPartyNotices: v.nullable(v.string()),
      versions: v.object({ electron: v.string(), chrome: v.string(), node: v.string() }),
    }),
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
      kind: v.picklist(WINDOW_KINDS),
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
  /** The settings now, sent when a page loads and after every change. */
  "settings.changed": defineEvent({
    name: "settings.changed",
    payload: SettingsSchema,
    sticky: true,
  }),
  /**
   * A native menu item asks the focused window to run one of its commands; the page runs
   * it through its command registry, exactly as its shortcut would.
   */
  "command.run": defineEvent({
    name: "command.run",
    payload: v.object({ id: CommandIdSchema }),
  }),
  /** The Settings window should show this section (it was asked for by `settings.open`). */
  "settings.section": defineEvent({
    name: "settings.section",
    payload: v.object({ section: v.picklist(SETTINGS_SECTIONS) }),
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
   * `sinceViewed` is one file's comparison and takes neither `ref` nor `startOverride`:
   * the version of a review-scope file its mark says was viewed (a snapshot, or the blob
   * from Git) against the file now. It fails `invalidRequest` with `detail.notInComparison`
   * for a file without a mark, and `refNotFound` with `detail.unavailable` set to
   * `noEarlierVersion` when the viewed version is kept nowhere any more.
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
        kind: v.picklist(COMPARISON_KINDS),
        ref: v.exactOptional(RefSchema),
        startOverride: v.exactOptional(RefSchema),
      }),
      path: PathSchema,
      category: v.exactOptional(FileCategorySchema),
    }),
    response: FileDiffSchema,
  }),
  /**
   * Review progress of scanned checkouts, in the order asked: every file of each one's
   * review scope (`review` comparison) with its state, and the counts. `notInScan` when
   * any path is not a checkout of this window's scan.
   */
  "review.status": defineCall({
    name: "review.status",
    request: v.strictObject({
      checkoutPaths: v.pipe(v.array(PathSchema), v.minLength(1), v.maxLength(MAX_STATUS_CHECKOUTS)),
    }),
    response: v.array(ReviewStatusSchema),
  }),
  /**
   * Marks files Viewed (their current version) or not, and answers the checkout's status.
   * Marking a path outside the review scope fails `invalidRequest`. `resultHashes`, one per
   * path and only with `viewed`, restores those exact versions instead (an undo); the
   * paths then need only be repository-relative. Every window showing the checkout hears
   * `review.changed`.
   */
  "review.mark": defineCall({
    name: "review.mark",
    request: v.strictObject({
      checkoutPath: PathSchema,
      paths: v.pipe(v.array(PathSchema), v.minLength(1), v.maxLength(MAX_MARK_PATHS)),
      viewed: v.boolean(),
      resultHashes: v.exactOptional(
        v.pipe(v.array(ResultHashSchema), v.minLength(1), v.maxLength(MAX_MARK_PATHS)),
      ),
    }),
    response: ReviewStatusSchema,
  }),
  /**
   * "Mark all as reviewed" (`viewed: true`): every file of the review scope, at its current
   * version. "Unmark all" (`viewed: false`): every mark of the worktree. Answers the status
   * and each changed path's mark before the action, so the window can undo it.
   */
  "review.markAll": defineCall({
    name: "review.markAll",
    request: v.strictObject({ checkoutPath: PathSchema, viewed: v.boolean() }),
    response: v.object({ status: ReviewStatusSchema, previous: v.array(PreviousMarkSchema) }),
  }),
  /**
   * Lets live refresh run again where it paused: a checkout's working tree after an event
   * storm, and (once more) a folder no watcher could watch. The window then rescans (⌘R),
   * which reads everything the pause may have missed.
   */
  "refresh.resume": defineCall({
    name: "refresh.resume",
    request: Empty,
    response: v.object({}),
  }),
  /**
   * Test-only (refused unless the app runs with `NODE_ENV=test`): what live refresh is
   * doing, for end-to-end checks: the watcher backend in use, every subscription, the
   * folders no watcher could watch, the core service's memory, and how many of each call
   * this window made. `suspend` stops (or restarts) delivering filesystem events, as if
   * they were lost while the Mac slept.
   */
  "test.liveRefresh": defineCall({
    name: "test.liveRefresh",
    request: v.strictObject({ suspend: v.exactOptional(v.boolean()) }),
    response: v.object({
      backend: v.picklist(["fsevents", "fs.watch"]),
      subscriptions: v.array(
        v.object({
          kind: v.string(),
          path: v.string(),
          backend: v.nullable(v.picklist(["fsevents", "fs.watch"])),
          holders: v.number(),
        }),
      ),
      unavailable: v.array(v.string()),
      rssBytes: v.number(),
      calls: v.record(v.string(), v.number()),
    }),
  }),
  /** What the snapshot store holds (Settings › Advanced). */
  "review.storeUsage": defineCall({
    name: "review.storeUsage",
    request: Empty,
    response: v.object({
      count: v.pipe(v.number(), v.integer(), v.minValue(0)),
      bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  }),
  /**
   * "Clear review data…": deletes every mark and snapshot (start overrides stay). Every
   * window hears `review.changed` for each checkout it shows.
   */
  "review.clearAll": defineCall({
    name: "review.clearAll",
    request: Empty,
    response: v.object({}),
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
  /**
   * A checkout's review status, new or changed: computed after each scan for every checkout
   * of it (in the background), and sent to every window showing a checkout whose marks
   * changed (in any window).
   */
  "review.changed": defineEvent({
    name: "review.changed",
    payload: ReviewStatusSchema,
  }),
  /**
   * Live refresh: a checkout of this window's scan changed on disk or in Git, and this is
   * the checkout as it is now. `changed` says what moved (the renderer maps each kind to
   * the queries it fetches again). `structure` announces a checkout that appeared;
   * `removed` one that disappeared, carrying the checkout as it was last seen.
   */
  "refresh.checkout": defineEvent({
    name: "refresh.checkout",
    payload: v.object({
      checkoutPath: v.string(),
      checkout: CheckoutSchema,
      changed: v.pipe(v.array(ChangeKindSchema), v.minLength(1)),
    }),
  }),
  /**
   * Live refresh: the timeline changed (a start or a HEAD moved its order or relations) or
   * the set of checkouts did (a worktree added or removed): the whole timeline, the
   * repositories, the folder tree and the folders that could not be read, as `scan.done`
   * carries them.
   */
  "refresh.timeline": defineEvent({
    name: "refresh.timeline",
    payload: v.object({
      timeline: v.array(TimelineEntrySchema),
      repositories: v.array(RepositorySchema),
      folders: v.array(FolderNodeSchema),
      problems: v.array(ScanProblemSchema),
    }),
  }),
  /**
   * Where live refresh is not running for this window now: checkouts whose working-tree
   * refresh paused after an event storm, and folders no watcher could watch. Sent whenever
   * that changes; empty once everything is live again.
   */
  "refresh.paused": defineEvent({
    name: "refresh.paused",
    payload: v.object({ paused: v.array(RefreshPauseSchema) }),
    sticky: true,
  }),
} as const satisfies EventMap;

export type MainCalls = typeof mainCalls;
export type MainEvents = typeof mainEvents;
export type CoreCalls = typeof coreCalls;
export type CoreEvents = typeof coreEvents;
export type AllEvents = MainEvents & CoreEvents;
