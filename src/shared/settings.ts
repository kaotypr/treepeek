import * as v from "valibot";

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

/**
 * The settings main keeps in `userData/settings.json` (it adds `version` on disk). Later
 * plans add fields here (recent folders, editor and terminal, window bounds).
 *
 * `gitPath` is the user's git binary override, tried before any other candidate; `null`
 * lets discovery choose.
 */
export const SettingsSchema = v.object({
  appearance: AppearanceSchema,
  gitPath: v.nullable(GitPathSchema),
});
export type Settings = v.InferOutput<typeof SettingsSchema>;

/**
 * A partial update from the renderer (`settings.set`). Unknown keys are rejected rather
 * than silently dropped.
 *
 * `gitPath` is deliberately absent: the core service executes that file, so a page must
 * not be able to name it. Main sets it only from its own native file dialog.
 */
export const SettingsPatchSchema = v.strictObject({
  appearance: v.optional(AppearanceSchema),
});
export type SettingsPatch = v.InferOutput<typeof SettingsPatchSchema>;

/** A partial update main makes itself; it may change every field. */
export const StoredSettingsPatchSchema = v.strictObject({
  appearance: v.optional(AppearanceSchema),
  gitPath: v.optional(v.nullable(GitPathSchema)),
});
export type StoredSettingsPatch = v.InferOutput<typeof StoredSettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = Object.freeze({ appearance: "system", gitPath: null });
