/**
 * Every action in a window is a command with an id (`shared/commands.ts`). Shortcuts
 * (`keymap.ts`) and the native menu (`command.run` from main) run commands by id, so a key
 * and a menu item can never do different things.
 *
 * The component that owns an action registers it while mounted (`useCommand`), so a command
 * exists only while what it acts on is on screen. Each run is announced on `window` as a
 * `treepeek:command` event (`detail.id`), which end-to-end tests count.
 */

import { useEffect, useRef } from "react";
import { COMMAND_IDS, type CommandId } from "../../shared/commands";

export { COMMAND_IDS, type CommandId };

/** The DOM event a command run is announced with. */
export const COMMAND_RUN_EVENT = "treepeek:command";

interface Command {
  run: () => void;
  isEnabled: () => boolean;
  /** For a command shown with a check mark: whether it is on. */
  isChecked?: () => boolean;
}

const commands = new Map<CommandId, Command>();
const changeListeners = new Set<() => void>();

/**
 * Calls `listener` whenever which commands exist, or what they depend on, may have
 * changed (a registration came or went, or a component owning commands rendered).
 */
export function onCommandsChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
}

/** Registers a command; answers the function that removes exactly this registration. */
export function registerCommand(
  id: CommandId,
  run: () => void,
  isEnabled: () => boolean = () => true,
  isChecked?: () => boolean,
): () => void {
  const command: Command = { run, isEnabled, ...(isChecked ? { isChecked } : {}) };
  commands.set(id, command);
  notifyChange();
  return () => {
    if (commands.get(id) !== command) return;
    commands.delete(id);
    notifyChange();
  };
}

export function isCommandEnabled(id: CommandId): boolean {
  return commands.get(id)?.isEnabled() ?? false;
}

/** Whether a command that reports a check mark has it on. */
export function isCommandChecked(id: CommandId): boolean {
  return commands.get(id)?.isChecked?.() ?? false;
}

/** Runs a command when it is registered and enabled; answers whether it ran. */
export function runCommand(id: CommandId): boolean {
  const command = commands.get(id);
  if (!command?.isEnabled()) return false;
  command.run();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(COMMAND_RUN_EVENT, { detail: { id } }));
  }
  return true;
}

/** Runs the commands main asks for from the native menu (`command.run`). */
export function installMenuCommands(): () => void {
  return window.treepeek.on("command.run", ({ id }) => {
    runCommand(id);
  });
}

/** Test support: forgets every registration. */
export function clearCommands(): void {
  commands.clear();
}

/**
 * Registers `id` while the calling component is mounted. `run` and `isEnabled` may change on
 * every render; the latest ones are used.
 */
export function useCommand(
  id: CommandId,
  run: () => void,
  isEnabled?: () => boolean,
  isChecked?: () => boolean,
): void {
  const latest = useRef({ run, isEnabled, isChecked });
  latest.current = { run, isEnabled, isChecked };
  useEffect(
    () =>
      registerCommand(
        id,
        () => latest.current.run(),
        () => latest.current.isEnabled?.() ?? true,
        () => latest.current.isChecked?.() ?? false,
      ),
    [id],
  );
  // Whether it is enabled may have changed with this render; the menu hears about it.
  useEffect(() => notifyChange());
}
