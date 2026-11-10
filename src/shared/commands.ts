/**
 * The ids of the commands a window runs (user-interface design, "Keyboard" and "Menus").
 * The renderer registers what each one does (`renderer/commands/registry.ts`); its keymap
 * and the native menu (`main/menu.ts`) both run them by id, so a shortcut and a menu item
 * can never do different things. Shared, because main sends them as `command.run`.
 */
export const COMMAND_IDS = [
  "scan.refresh",
  "view.timeline",
  "view.tree",
  "checkout.previous",
  "checkout.next",
  "file.previous",
  "file.next",
  "file.toggleViewed",
  "file.markViewedAndNext",
  "preview.split",
  "preview.unified",
  "preview.result",
  "preview.focus",
  "files.filter",
  "comparison.settings",
  "appearance.cycle",
  "checkout.setStart",
  "checkout.revealInFinder",
  "checkout.openInEditor",
  "checkout.openInTerminal",
  "checkout.copyPath",
  "checkout.copyBranch",
  "checkout.copyCommit",
  "checkout.markAllReviewed",
  "checkout.unmarkAll",
  "review.undo",
  "app.settings",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/**
 * Commands shown as a check mark (or a radio choice) in the menus. A window reports which
 * of them are on, next to which commands are enabled (`window.commands`).
 */
export const CHECKABLE_COMMAND_IDS = [
  "file.toggleViewed",
  "view.timeline",
  "view.tree",
  "preview.split",
  "preview.unified",
  "preview.result",
  "preview.focus",
] as const satisfies readonly CommandId[];

export type CheckableCommandId = (typeof CHECKABLE_COMMAND_IDS)[number];
