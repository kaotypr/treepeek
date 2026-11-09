import type { ResolvedTheme } from "./settings";

/**
 * Window background per resolved theme. Main paints a new window with it before the first
 * frame, so it must equal `--background` in `renderer/styles/tokens.css`.
 */
export const WINDOW_BACKGROUND: Readonly<Record<ResolvedTheme, string>> = Object.freeze({
  light: "#f4f6f3",
  dark: "#0e1613",
});
