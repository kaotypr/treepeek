/**
 * In-window shortcuts (user-interface design, "Keyboard"), each bound to a command id. ⌘O
 * is the native menu's; ↑ and ↓ belong to the focused list or tree.
 *
 * The native menu shows the same shortcuts (`main/menu.ts`). Chromium hands a ⌘ shortcut
 * to the page before the menu; when its command runs here, the key press is taken, so the
 * menu never runs it a second time. A key whose command is disabled here passes on to the
 * menu, whose item is disabled too.
 */

import { type CommandId, runCommand } from "./registry";

export interface KeyBinding {
  command: CommandId;
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * The shortcut belongs to a text field while one has focus, even with ⌘ (⌘Z undoes
   * typing there, and the review undo everywhere else).
   */
  notInTextField?: boolean;
}

export const KEYMAP: readonly KeyBinding[] = Object.freeze([
  { command: "scan.refresh", key: "r", meta: true },
  { command: "view.timeline", key: "t", meta: true },
  { command: "view.tree", key: "t", meta: true, shift: true },
  { command: "checkout.previous", key: "[", meta: true },
  { command: "checkout.next", key: "]", meta: true },
  { command: "file.previous", key: "ArrowUp", alt: true },
  { command: "file.next", key: "ArrowDown", alt: true },
  { command: "file.toggleViewed", key: "v" },
  { command: "file.markViewedAndNext", key: "Enter", meta: true },
  { command: "review.undo", key: "z", meta: true, notInTextField: true },
  { command: "preview.split", key: "1", meta: true },
  { command: "preview.unified", key: "2", meta: true },
  { command: "preview.result", key: "3", meta: true },
  { command: "preview.focus", key: "f", meta: true, shift: true },
  { command: "files.filter", key: "f", meta: true },
  { command: "comparison.settings", key: "k", meta: true },
  { command: "checkout.openInEditor", key: "e", meta: true },
  { command: "checkout.openInTerminal", key: "e", meta: true, shift: true },
  { command: "checkout.revealInFinder", key: "r", meta: true, shift: true },
  { command: "app.settings", key: ",", meta: true },
]);

export interface KeyLike {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

/**
 * The command a key press asks for, or `null`. In a text field only ⌘ shortcuts count, so
 * typing and the field's own ⌥-arrow movement stay the field's.
 */
export function commandForKey(event: KeyLike, inTextField: boolean): CommandId | null {
  if (event.ctrlKey) return null;
  for (const binding of KEYMAP) {
    if (event.key.toLowerCase() !== binding.key.toLowerCase()) continue;
    if (event.metaKey !== !!binding.meta) continue;
    if (event.shiftKey !== !!binding.shift) continue;
    if (event.altKey !== !!binding.alt) continue;
    if (inTextField && (!binding.meta || binding.notInTextField)) return null;
    return binding.command;
  }
  return null;
}

/** A shortcut's label for menus and tooltips, such as `⌘⇧T`. */
export function shortcutLabel(command: CommandId): string | null {
  const binding = KEYMAP.find((item) => item.command === command);
  if (!binding) return null;
  const key =
    binding.key === "ArrowUp"
      ? "↑"
      : binding.key === "ArrowDown"
        ? "↓"
        : binding.key === "Enter"
          ? "↩"
          : binding.key.toUpperCase();
  return `${binding.alt ? "⌥" : ""}${binding.shift ? "⇧" : ""}${binding.meta ? "⌘" : ""}${key}`;
}

/** Whether keys typed at `target` are text: a text field, or a select's type-to-find. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  return (
    target instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(target.type)
  );
}

/** Listens for shortcuts on `target`; a shortcut whose command ran takes the key press. */
export function installKeymap(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    // A plain key on a select is its type-to-find; ⌘ and ⌥ shortcuts still run there.
    const typing =
      isTextField(event.target) ||
      (event.target instanceof HTMLSelectElement && !event.metaKey && !event.altKey);
    const command = commandForKey(event, typing);
    if (command !== null && runCommand(command)) event.preventDefault();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
