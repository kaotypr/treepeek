/**
 * Every action in a window is a command with an id. Shortcuts (`keymap.ts`) and, later, the
 * native menu run commands by id, so a key and a menu item can never do different things.
 *
 * The component that owns an action registers it while mounted (`useCommand`), so a command
 * exists only while what it acts on is on screen.
 */

import { useEffect, useRef } from "react";

export const COMMAND_IDS = [
  "scan.refresh",
  "view.timeline",
  "view.tree",
  "checkout.previous",
  "checkout.next",
  "file.previous",
  "file.next",
  "preview.split",
  "preview.unified",
  "preview.result",
  "preview.focus",
  "files.filter",
  "comparison.settings",
  "appearance.cycle",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

interface Command {
  run: () => void;
  isEnabled: () => boolean;
}

const commands = new Map<CommandId, Command>();

/** Registers a command; answers the function that removes exactly this registration. */
export function registerCommand(
  id: CommandId,
  run: () => void,
  isEnabled: () => boolean = () => true,
): () => void {
  const command: Command = { run, isEnabled };
  commands.set(id, command);
  return () => {
    if (commands.get(id) === command) commands.delete(id);
  };
}

export function isCommandEnabled(id: CommandId): boolean {
  return commands.get(id)?.isEnabled() ?? false;
}

/** Runs a command when it is registered and enabled; answers whether it ran. */
export function runCommand(id: CommandId): boolean {
  const command = commands.get(id);
  if (!command?.isEnabled()) return false;
  command.run();
  return true;
}

/** Test support: forgets every registration. */
export function clearCommands(): void {
  commands.clear();
}

/**
 * Registers `id` while the calling component is mounted. `run` and `isEnabled` may change on
 * every render; the latest ones are used.
 */
export function useCommand(id: CommandId, run: () => void, isEnabled?: () => boolean): void {
  const latest = useRef({ run, isEnabled });
  latest.current = { run, isEnabled };
  useEffect(
    () =>
      registerCommand(
        id,
        () => latest.current.run(),
        () => latest.current.isEnabled?.() ?? true,
      ),
    [id],
  );
}
