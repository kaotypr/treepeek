import * as v from "valibot";
import { commandTemplateProblem } from "./command-template";
import { LISTABLE_COMPARISON_KINDS, type ListableComparisonKind } from "./domain/compare";

export const APPEARANCES = ["system", "light", "dark"] as const;
export const AppearanceSchema = v.picklist(APPEARANCES);
export type Appearance = v.InferOutput<typeof AppearanceSchema>;

export type ResolvedTheme = "light" | "dark";

/** An absolute path to a git binary. */
export const GitPathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.startsWith("/", "The git path must be absolute"),
  v.check((path) => !path.includes("\0"), "The git path must not contain NUL"),
);

/** An absolute folder path kept in settings (a recent folder, a window's scan root). */
export const FolderPathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.startsWith("/", "The folder path must be absolute"),
  v.check((path) => !path.includes("\0"), "The folder path must not contain NUL"),
);

/** Entries in File › Open Recent and on the welcome window. */
export const MAX_RECENT_FOLDERS = 10;

/** Scan windows restored on launch; more than this many open at quit are not all brought back. */
export const MAX_RESTORED_WINDOWS = 24;

export const NAVIGATOR_MODES = ["picker", "tree"] as const;
export type NavigatorMode = (typeof NAVIGATOR_MODES)[number];

export const TIMELINE_GROUPINGS = ["all", "repository", "folder"] as const;
export type TimelineGrouping = (typeof TIMELINE_GROUPINGS)[number];

export const TIMELINE_ORDERS = ["oldest", "newest"] as const;
export type TimelineOrder = (typeof TIMELINE_ORDERS)[number];

export const PREVIEW_MODES = ["split", "unified", "result"] as const;
export type PreviewMode = (typeof PREVIEW_MODES)[number];

/** A panel width in CSS pixels, as the window's layout remembers it. */
const PanelWidth = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000));

/**
 * What a scan window remembers about its own layout and view, saved by main per window
 * (`window.state`) and handed back when the window is restored.
 */
export const WindowUiStateSchema = v.strictObject({
  timelineOpen: v.boolean(),
  navigatorMode: v.picklist(NAVIGATOR_MODES),
  timelineGrouping: v.picklist(TIMELINE_GROUPINGS),
  timelineOrder: v.picklist(TIMELINE_ORDERS),
  previewMode: v.picklist(PREVIEW_MODES),
  /** Widths of the timeline and navigator panels; the preview takes the rest. */
  timelineWidth: v.nullable(PanelWidth),
  navigatorWidth: v.nullable(PanelWidth),
  /** The checkout selected when the state was saved, selected again after a restore. */
  selectedCheckout: v.nullable(FolderPathSchema),
});
export type WindowUiState = v.InferOutput<typeof WindowUiStateSchema>;

export const DEFAULT_WINDOW_UI_STATE: WindowUiState = Object.freeze({
  timelineOpen: false,
  navigatorMode: "picker",
  timelineGrouping: "all",
  timelineOrder: "oldest",
  previewMode: "split",
  timelineWidth: null,
  navigatorWidth: null,
  selectedCheckout: null,
});

const Coordinate = v.pipe(v.number(), v.integer(), v.minValue(-100_000), v.maxValue(100_000));
const Extent = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000));

export const WindowBoundsSchema = v.object({
  x: Coordinate,
  y: Coordinate,
  width: Extent,
  height: Extent,
});
export type WindowBounds = v.InferOutput<typeof WindowBoundsSchema>;

/** One scan window, as it was open when the app last saved its windows. */
export const SavedWindowSchema = v.object({
  scanRoot: FolderPathSchema,
  bounds: v.fallback(v.nullable(WindowBoundsSchema), null),
  ui: v.fallback(v.nullable(WindowUiStateSchema), null),
});
export type SavedWindow = v.InferOutput<typeof SavedWindowSchema>;

/**
 * A macOS bundle identifier (`com.microsoft.VSCode`): letters, digits, `.`, `-`, `_`. It is
 * passed to `open -b`, so it can never be read as an option or a path.
 */
export const BundleIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Not a bundle identifier"),
);

/**
 * A custom "Open in…" command: a program and its arguments, with `{path}` (and for the
 * editor `{line}`) where the file or folder goes. It is split into an argument array before
 * anything is substituted and never runs through a shell (`main/open-in/template.ts`).
 */
export const CommandTemplateSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Enter a command"),
  v.maxLength(1000),
  v.check((text) => !text.includes("\0"), "The command must not contain NUL"),
  v.check((text) => text.includes("{path}"), "The command must contain {path}"),
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const problem = commandTemplateProblem(dataset.value);
    if (problem !== null) addIssue({ message: problem });
  }),
);

/**
 * Which app an "Open in…" action uses:
 *
 * - `auto`: the editor is the first installed one in the known list (`main/open-in/editors.ts`);
 *   the terminal is Terminal.
 * - `app`: a detected app, by bundle identifier.
 * - `custom`: a command template.
 */
export const AppChoiceSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("auto") }),
  v.strictObject({ kind: v.literal("app"), bundleId: BundleIdSchema }),
  v.strictObject({ kind: v.literal("custom"), command: CommandTemplateSchema }),
]);
export type AppChoice = v.InferOutput<typeof AppChoiceSchema>;

/** The comparisons a newly selected checkout can start on: every listed kind but `base`, which needs a ref. */
export const DEFAULT_COMPARISON_KINDS: readonly ListableComparisonKind[] = Object.freeze(
  LISTABLE_COMPARISON_KINDS.filter((kind) => kind !== "base"),
);
export const DefaultComparisonSchema = v.picklist(DEFAULT_COMPARISON_KINDS);

/**
 * The settings main keeps in `userData/settings.json` (it adds `version` on disk).
 *
 * - `gitPath` is the user's git binary override, tried before any other candidate; `null`
 *   lets discovery choose.
 * - `recentFolders` is newest first.
 * - `windows` lists the scan windows to restore on launch; `restoreWindows` says whether
 *   they come back.
 * - `editor` and `terminal` are the "Open in…" apps.
 * - `defaultComparison` is the comparison a newly selected checkout starts on.
 * - `hideViewedByDefault` starts every file list with "Hide viewed" on.
 *
 * The two lists and the later additions fall back to their defaults when they do not
 * parse, so a damaged entry costs that entry, never the person's other settings.
 */
export const SettingsSchema = v.object({
  appearance: AppearanceSchema,
  gitPath: v.nullable(GitPathSchema),
  restoreWindows: v.fallback(v.boolean(), true),
  defaultComparison: v.fallback(DefaultComparisonSchema, "review"),
  hideViewedByDefault: v.fallback(v.boolean(), false),
  editor: v.fallback(AppChoiceSchema, () => ({ kind: "auto" as const })),
  terminal: v.fallback(AppChoiceSchema, () => ({ kind: "auto" as const })),
  recentFolders: v.fallback(
    v.pipe(v.array(FolderPathSchema), v.maxLength(MAX_RECENT_FOLDERS)),
    () => [],
  ),
  windows: v.fallback(
    v.pipe(v.array(SavedWindowSchema), v.maxLength(MAX_RESTORED_WINDOWS)),
    () => [],
  ),
});
export type Settings = v.InferOutput<typeof SettingsSchema>;

/**
 * A partial update from the renderer (`settings.set`). Unknown keys are rejected rather
 * than silently dropped.
 *
 * A page may only clear `gitPath` (back to automatic detection): the core service executes
 * that file, so a page must not be able to name it. Main sets it only from its own native
 * file dialog (`git.choose`). The recent folders and saved windows are main's own
 * bookkeeping. `editor` and `terminal` name programs to run as well, so main accepts them
 * only from the Settings window, which never shows repository content.
 */
export const SettingsPatchSchema = v.strictObject({
  appearance: v.optional(AppearanceSchema),
  gitPath: v.optional(v.null()),
  restoreWindows: v.optional(v.boolean()),
  defaultComparison: v.optional(DefaultComparisonSchema),
  hideViewedByDefault: v.optional(v.boolean()),
  editor: v.optional(AppChoiceSchema),
  terminal: v.optional(AppChoiceSchema),
});
export type SettingsPatch = v.InferOutput<typeof SettingsPatchSchema>;

/** A partial update main makes itself; it may change every field. */
export const StoredSettingsPatchSchema = v.strictObject({
  appearance: v.optional(AppearanceSchema),
  gitPath: v.optional(v.nullable(GitPathSchema)),
  restoreWindows: v.optional(v.boolean()),
  defaultComparison: v.optional(DefaultComparisonSchema),
  hideViewedByDefault: v.optional(v.boolean()),
  editor: v.optional(AppChoiceSchema),
  terminal: v.optional(AppChoiceSchema),
  recentFolders: v.optional(v.pipe(v.array(FolderPathSchema), v.maxLength(MAX_RECENT_FOLDERS))),
  windows: v.optional(v.pipe(v.array(SavedWindowSchema), v.maxLength(MAX_RESTORED_WINDOWS))),
});
export type StoredSettingsPatch = v.InferOutput<typeof StoredSettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  appearance: "system",
  gitPath: null,
  restoreWindows: true,
  defaultComparison: "review",
  hideViewedByDefault: false,
  editor: Object.freeze({ kind: "auto" }),
  terminal: Object.freeze({ kind: "auto" }),
  recentFolders: [],
  windows: [],
});
