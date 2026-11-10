/**
 * Tells main which of this window's commands are enabled and which are checked
 * (`window.commands`), so the native menu enables and checks its items for the focused
 * window. Sent only when the answer changes, at most once per task.
 */

import {
  CHECKABLE_COMMAND_IDS,
  type CheckableCommandId,
  COMMAND_IDS,
  type CommandId,
} from "../../shared/commands";
import type { UiState } from "../state/ui-store";
import { isCommandChecked, isCommandEnabled, onCommandsChange } from "./registry";

/** The menu items a window's layout checks. */
export function checkedCommands(ui: UiState): CheckableCommandId[] {
  const checked: CheckableCommandId[] = [];
  if (ui.timelineOpen) checked.push("view.timeline");
  if (ui.navigatorMode === "tree") checked.push("view.tree");
  checked.push(
    ui.previewMode === "split"
      ? "preview.split"
      : ui.previewMode === "unified"
        ? "preview.unified"
        : "preview.result",
  );
  if (ui.focusPreview) checked.push("preview.focus");
  return checked;
}

export interface CommandReportOptions {
  send: (state: { enabled: CommandId[]; checked: CheckableCommandId[] }) => void;
  checked: () => CheckableCommandId[];
  /** More things that can change the answer (the UI store). */
  subscribe?: (listener: () => void) => () => void;
}

export function startCommandReport(options: CommandReportOptions): () => void {
  let last = "";
  let scheduled = false;
  let stopped = false;
  const report = () => {
    scheduled = false;
    if (stopped) return;
    const enabled = COMMAND_IDS.filter((id) => isCommandEnabled(id));
    // The layout's check marks, and those a command reports itself (Go › Viewed).
    const checked = [
      ...new Set([...options.checked(), ...CHECKABLE_COMMAND_IDS.filter(isCommandChecked)]),
    ];
    const key = `${enabled.join(",")}|${checked.join(",")}`;
    if (key === last) return;
    last = key;
    options.send({ enabled, checked });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(report);
  };
  const offCommands = onCommandsChange(schedule);
  const offExtra = options.subscribe?.(schedule);
  schedule();
  return () => {
    stopped = true;
    offCommands();
    offExtra?.();
  };
}
