import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import {
  CHECKABLE_COMMAND_IDS,
  type CheckableCommandId,
  COMMAND_IDS,
  type CommandId,
} from "../shared/commands";
import { APPEARANCES, type Appearance } from "../shared/settings";

/**
 * Development and lab builds carry the diff lab; `bun run build` does not. A compile-time
 * constant, so a production build drops the lab's menu item along with the lab.
 */
const LAB_BUILD = import.meta.env.DEV || import.meta.env.MODE === "lab";

/** The project's pages, for the Help menu. Fixed URLs: nothing from a page reaches them. */
export const HELP_LINKS = Object.freeze({
  repository: "https://github.com/kaotypr/treepeek",
  issues: "https://github.com/kaotypr/treepeek/issues/new",
});
export type HelpLink = keyof typeof HELP_LINKS;

/**
 * The shortcut of every window command that has one, as a menu accelerator (user-interface
 * design, "Keyboard"). The renderer's keymap (`renderer/commands/keymap.ts`) binds the same
 * keys to the same commands: Chromium hands ⌘ shortcuts to the page before the menu, and the
 * page takes a key press whose command ran, so a shortcut runs its command once either way.
 */
export const COMMAND_ACCELERATORS: Readonly<Partial<Record<CommandId, string>>> = Object.freeze({
  "scan.refresh": "CmdOrCtrl+R",
  "view.timeline": "CmdOrCtrl+T",
  "view.tree": "CmdOrCtrl+Shift+T",
  "checkout.previous": "CmdOrCtrl+[",
  "checkout.next": "CmdOrCtrl+]",
  "file.previous": "Alt+Up",
  "file.next": "Alt+Down",
  "preview.split": "CmdOrCtrl+1",
  "preview.unified": "CmdOrCtrl+2",
  "preview.result": "CmdOrCtrl+3",
  "preview.focus": "CmdOrCtrl+Shift+F",
  "files.filter": "CmdOrCtrl+F",
  "comparison.settings": "CmdOrCtrl+K",
  "checkout.openInEditor": "CmdOrCtrl+E",
  "checkout.openInTerminal": "CmdOrCtrl+Shift+E",
  "checkout.revealInFinder": "CmdOrCtrl+Shift+R",
});

/** What the menu bar needs from the app. */
export interface MenuActions {
  /** Shows the folder dialog, attached to `win` when a window is focused. */
  openFolder: (win: BrowserWindow | null) => void;
  /** Newest first. */
  recentFolders: readonly string[];
  openRecent: (path: string) => void;
  clearRecent: () => void;
  /** The appearance setting, checked in View › Appearance. */
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
  openSettings: () => void;
  openAbout: () => void;
  openHelpLink: (link: HelpLink) => void;
  /** Asks `win` (the focused window, if any) to run one of its commands. */
  runCommand: (win: BrowserWindow | null, id: CommandId) => void;
}

type FileMenuActions = Pick<
  MenuActions,
  "openFolder" | "recentFolders" | "openRecent" | "clearRecent"
>;

const separator: MenuItemConstructorOptions = { type: "separator" };

function focused(win: unknown): BrowserWindow | null {
  return win instanceof BrowserWindow ? win : null;
}

/**
 * A menu item that runs a window command. It starts disabled; `applyCommandState` enables
 * and checks it from what the focused window reports.
 */
function commandItem(
  actions: Pick<MenuActions, "runCommand">,
  id: CommandId,
  label: string,
  type?: "checkbox" | "radio",
): MenuItemConstructorOptions {
  const accelerator = COMMAND_ACCELERATORS[id];
  return {
    id,
    label,
    enabled: false,
    ...(accelerator ? { accelerator } : {}),
    ...(type ? { type, checked: false } : {}),
    click: (_item, win) => actions.runCommand(focused(win), id),
  };
}

/** The application menu: About, Check for Updates…, Settings… (⌘,), Hide, Quit. */
export function appMenu(actions: Pick<MenuActions, "openSettings" | "openAbout">) {
  return {
    label: app.name,
    submenu: [
      { id: "about", label: `About ${app.name}`, click: () => actions.openAbout() },
      // Filled in by the update work; there for its place in the menu.
      { id: "check-for-updates", label: "Check for Updates…", enabled: false },
      separator,
      {
        id: "settings",
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        click: () => actions.openSettings(),
      },
      separator,
      { role: "services" },
      separator,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      separator,
      { role: "quit" },
    ],
  } satisfies MenuItemConstructorOptions;
}

/** File › Open Folder… (⌘O), Open Recent ▸ and Close Window. */
export function fileMenu(actions: FileMenuActions): MenuItemConstructorOptions {
  const recent: MenuItemConstructorOptions[] = actions.recentFolders.map((path) => ({
    label: path,
    click: () => actions.openRecent(path),
  }));
  return {
    label: "File",
    submenu: [
      {
        id: "open-folder",
        label: "Open Folder…",
        accelerator: "CmdOrCtrl+O",
        click: (_item, win) => actions.openFolder(focused(win)),
      },
      {
        id: "open-recent",
        label: "Open Recent",
        submenu: [
          ...recent,
          ...(recent.length > 0 ? [separator] : []),
          {
            id: "clear-recent",
            label: "Clear Menu",
            enabled: recent.length > 0,
            click: () => actions.clearRecent(),
          },
        ],
      },
      separator,
      { role: "close" },
    ],
  };
}

/** The standard editing roles, plus Find (⌘F), which filters the file list. */
export function editMenu(actions: Pick<MenuActions, "runCommand">): MenuItemConstructorOptions {
  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      separator,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
      separator,
      commandItem(actions, "files.filter", "Find…"),
    ],
  };
}

/**
 * The View menu: Timeline, Tree, Preview Mode ▸, Focus Preview, Appearance ▸, Refresh.
 * Development items (reload, DevTools, `extra`) appear only outside a packaged app.
 */
export function viewMenu(
  actions: Pick<MenuActions, "runCommand" | "appearance" | "setAppearance">,
  packaged: boolean,
  extra: readonly MenuItemConstructorOptions[] = [],
): MenuItemConstructorOptions {
  // ⌘R is the window's Refresh (rescan), so the development reloads move off it.
  const development: MenuItemConstructorOptions[] = packaged
    ? []
    : [
        separator,
        { role: "reload", accelerator: "Alt+CmdOrCtrl+R" },
        { role: "forceReload", accelerator: "Alt+Shift+CmdOrCtrl+R" },
        { role: "toggleDevTools" },
        ...extra,
      ];
  const label: Readonly<Record<Appearance, string>> = {
    system: "System",
    light: "Light",
    dark: "Dark",
  };
  return {
    label: "View",
    submenu: [
      commandItem(actions, "view.timeline", "Timeline", "checkbox"),
      commandItem(actions, "view.tree", "Tree", "checkbox"),
      separator,
      {
        id: "preview-mode",
        label: "Preview Mode",
        submenu: [
          commandItem(actions, "preview.split", "Side by Side", "radio"),
          commandItem(actions, "preview.unified", "Unified", "radio"),
          commandItem(actions, "preview.result", "Resulting File", "radio"),
        ],
      },
      commandItem(actions, "preview.focus", "Focus Preview", "checkbox"),
      separator,
      {
        id: "appearance",
        label: "Appearance",
        submenu: APPEARANCES.map((appearance) => ({
          id: `appearance.${appearance}`,
          label: label[appearance],
          type: "radio" as const,
          checked: actions.appearance === appearance,
          click: () => actions.setAppearance(appearance),
        })),
      },
      separator,
      commandItem(actions, "scan.refresh", "Refresh"),
      ...development,
      separator,
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      separator,
      { role: "togglefullscreen" },
    ],
  };
}

/** Go: the previous and next checkout (timeline order) and file. */
export function goMenu(actions: Pick<MenuActions, "runCommand">): MenuItemConstructorOptions {
  return {
    label: "Go",
    submenu: [
      commandItem(actions, "checkout.previous", "Previous Checkout"),
      commandItem(actions, "checkout.next", "Next Checkout"),
      separator,
      commandItem(actions, "file.previous", "Previous File"),
      commandItem(actions, "file.next", "Next File"),
    ],
  };
}

/** Checkout: comparison settings, the start, "Open in…" and copying. */
export function checkoutMenu(actions: Pick<MenuActions, "runCommand">): MenuItemConstructorOptions {
  return {
    id: "checkout-menu",
    label: "Checkout",
    submenu: [
      commandItem(actions, "comparison.settings", "Comparison Settings…"),
      commandItem(actions, "checkout.setStart", "Set Start…"),
      separator,
      commandItem(actions, "checkout.openInEditor", "Open in Editor"),
      commandItem(actions, "checkout.openInTerminal", "Open in Terminal"),
      commandItem(actions, "checkout.revealInFinder", "Reveal in Finder"),
      separator,
      commandItem(actions, "checkout.copyPath", "Copy Path"),
      commandItem(actions, "checkout.copyBranch", "Copy Branch"),
      commandItem(actions, "checkout.copyCommit", "Copy Commit"),
    ],
  };
}

/** Help: the project's pages and the acknowledgements (in the About window). */
export function helpMenu(
  actions: Pick<MenuActions, "openHelpLink" | "openAbout">,
): MenuItemConstructorOptions {
  return {
    role: "help",
    submenu: [
      {
        id: "help.repository",
        label: `${app.name} on GitHub`,
        click: () => actions.openHelpLink("repository"),
      },
      {
        id: "help.issues",
        label: "Report an Issue",
        click: () => actions.openHelpLink("issues"),
      },
      separator,
      { id: "help.acknowledgements", label: "Acknowledgements", click: () => actions.openAbout() },
    ],
  };
}

/** "Open Diff Lab": the same page with the lab's location hash (`renderer/dev`). */
export function diffLabMenuItem(): MenuItemConstructorOptions {
  return {
    id: "diff-lab",
    label: "Open Diff Lab",
    accelerator: "CmdOrCtrl+Alt+L",
    click: (_item, win) => {
      if (!(win instanceof BrowserWindow)) return;
      const url = new URL(win.webContents.getURL());
      url.hash = "#diff-lab";
      void win.webContents.loadURL(url.toString());
    },
  };
}

/** The menu bar's template (user-interface design, "Menus"). */
export function menuTemplate(
  actions: MenuActions,
  packaged: boolean,
): MenuItemConstructorOptions[] {
  return [
    appMenu(actions),
    fileMenu(actions),
    editMenu(actions),
    viewMenu(actions, packaged, LAB_BUILD ? [diffLabMenuItem()] : []),
    goMenu(actions),
    checkoutMenu(actions),
    { role: "windowMenu" },
    helpMenu(actions),
  ];
}

/** The native menu bar. Every window command starts disabled until a window reports in. */
export function buildMenu(actions: MenuActions): Menu {
  return Menu.buildFromTemplate(menuTemplate(actions, app.isPackaged));
}

/** What the focused window says about its commands (`window.commands`). */
export interface CommandState {
  enabled: ReadonlySet<CommandId>;
  checked: ReadonlySet<CheckableCommandId>;
}

/** The part of `Menu` that `applyCommandState` touches. */
export interface MenuLike {
  getMenuItemById(id: string): { enabled: boolean; checked: boolean } | null;
}

/**
 * Enables and checks the command items for the focused window. `null` (no scan window
 * focused: none at all, the welcome window, Settings, About) disables every one of them.
 */
export function applyCommandState(menu: MenuLike | null, state: CommandState | null): void {
  if (!menu) return;
  const checkable: ReadonlySet<string> = new Set(CHECKABLE_COMMAND_IDS);
  for (const id of COMMAND_IDS) {
    const item = menu.getMenuItemById(id);
    if (!item) continue;
    item.enabled = state?.enabled.has(id) ?? false;
    if (checkable.has(id)) item.checked = state?.checked.has(id as CheckableCommandId) ?? false;
  }
}

/** Checks the appearance the settings now hold in View › Appearance. */
export function checkAppearance(menu: MenuLike | null, appearance: Appearance): void {
  for (const candidate of APPEARANCES) {
    const item = menu?.getMenuItemById(`appearance.${candidate}`);
    if (item) item.checked = candidate === appearance;
  }
}
