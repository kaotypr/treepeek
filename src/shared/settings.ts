import * as v from "valibot";

export const APPEARANCES = ["system", "light", "dark"] as const;
export const AppearanceSchema = v.picklist(APPEARANCES);
export type Appearance = v.InferOutput<typeof AppearanceSchema>;

export type ResolvedTheme = "light" | "dark";

/**
 * The settings the renderer can read and change. Main owns the file
 * (`userData/settings.json`) and adds its `version` on disk; later plans add fields here
 * (recent folders, git binary override, editor and terminal, window bounds).
 */
export const SettingsSchema = v.object({
  appearance: AppearanceSchema,
});
export type Settings = v.InferOutput<typeof SettingsSchema>;

/** A partial update. Unknown keys are rejected rather than silently dropped. */
export const SettingsPatchSchema = v.strictObject({
  appearance: v.optional(AppearanceSchema),
});
export type SettingsPatch = v.InferOutput<typeof SettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = Object.freeze({ appearance: "system" });
