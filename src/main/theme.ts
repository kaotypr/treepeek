import { nativeTheme } from "electron";
import type { Appearance, ResolvedTheme } from "../shared/settings";

export interface ThemeState {
  resolved: ResolvedTheme;
  source: Appearance;
}

let source: Appearance = "system";

/**
 * Applies the appearance setting app-wide. `themeSource` also switches the native title
 * bar, menus, scrollbars and vibrancy.
 */
export function applyAppearance(setting: Appearance): void {
  source = setting;
  nativeTheme.themeSource = setting;
}

export function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function themeState(): ThemeState {
  return { resolved: resolvedTheme(), source };
}

/**
 * Calls `listener` whenever the resolved theme may have changed: the setting changed, or
 * macOS appearance changed while the setting is System (including Auto at sunset).
 */
export function onThemeChanged(listener: (state: ThemeState) => void): () => void {
  const handler = () => listener(themeState());
  nativeTheme.on("updated", handler);
  return () => nativeTheme.off("updated", handler);
}
