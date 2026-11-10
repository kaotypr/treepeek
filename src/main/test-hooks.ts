import { delimiter } from "node:path";

/**
 * Hooks end-to-end tests use instead of native UI and the person's apps. Each is honoured
 * only when `NODE_ENV` is `test`, which the end-to-end launcher sets; a normal launch never
 * has it.
 *
 * - `TREEPEEK_E2E_OPEN`: folders to open at launch (see `index.ts`).
 * - `TREEPEEK_E2E_DIALOG`: answers for the native open dialogs (folder, git binary), in
 *   order, separated like `PATH`; once used up, a dialog counts as cancelled. No dialog is
 *   shown.
 * - `TREEPEEK_E2E_LAUNCH_LOG`: a file "Open in…", the clipboard and "Open Logs Folder"
 *   append to (`open-in/launcher.ts`), instead of opening apps or writing the clipboard.
 * - `TREEPEEK_E2E_MENU`: menu item ids, separated by commas, clicked once each after
 *   launch, the way a person picks them from the menu bar: for the first scan window, once
 *   it has reported its commands (as if it were focused, which background-mode windows
 *   never are), or with no window when none scans. A disabled item is skipped and logged;
 *   `wait:<id>` instead waits for the item to be enabled by one of the window's later
 *   reports (a checkout selected and its review status read), then goes on with the rest.
 * - `TREEPEEK_E2E_GIT_OVERRIDE_ONLY` is read by the core service (`core/index.ts`).
 */
export function testHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test";
}

export function testLaunchLog(env: NodeJS.ProcessEnv = process.env): string | null {
  return testHooksEnabled(env) ? env.TREEPEEK_E2E_LAUNCH_LOG || null : null;
}

/** Answers the native open dialogs from `TREEPEEK_E2E_DIALOG`, or `null` when it is unset. */
export function testDialogAnswers(
  env: NodeJS.ProcessEnv = process.env,
): (() => string | null) | null {
  const raw = testHooksEnabled(env) ? env.TREEPEEK_E2E_DIALOG : undefined;
  if (raw === undefined) return null;
  const answers = raw.split(delimiter).filter(Boolean);
  return () => answers.shift() ?? null;
}

/** The menu item ids `TREEPEEK_E2E_MENU` asks to click, or `null` when it is unset. */
export function testMenuClicks(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = testHooksEnabled(env) ? env.TREEPEEK_E2E_MENU : undefined;
  if (!raw) return null;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
