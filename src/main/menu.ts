import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Development and lab builds carry the diff lab; `bun run build` does not. A compile-time
 * constant, so a production build drops the lab's menu item along with the lab.
 */
const LAB_BUILD = import.meta.env.DEV || import.meta.env.MODE === "lab";

/**
 * The View menu. Development items (reload, DevTools, `extra`) appear only outside a
 * packaged app. Separate from `buildMenu` so its contents can be tested.
 */
export function viewMenu(
  packaged: boolean,
  extra: readonly MenuItemConstructorOptions[] = [],
): MenuItemConstructorOptions {
  // ⌘R is the window's Refresh (rescan), so the development reloads move off it.
  const development: MenuItemConstructorOptions[] = packaged
    ? []
    : [
        { role: "reload", accelerator: "Alt+CmdOrCtrl+R" },
        { role: "forceReload", accelerator: "Alt+Shift+CmdOrCtrl+R" },
        { role: "toggleDevTools" },
        ...extra,
        { type: "separator" },
      ];
  return {
    label: "View",
    submenu: [
      ...development,
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
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

export interface FileMenuActions {
  /** Shows the folder dialog, attached to `win` when a window is focused. */
  openFolder: (win: BrowserWindow | null) => void;
  /** Newest first. */
  recentFolders: readonly string[];
  openRecent: (path: string) => void;
  clearRecent: () => void;
}

/**
 * File › Open Folder… (⌘O), Open Recent ▸ and Close Window. The rest of the menu bar
 * (View, Go, Checkout) arrives with the desktop integration.
 */
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
        click: (_item, win) => actions.openFolder(win instanceof BrowserWindow ? win : null),
      },
      {
        id: "open-recent",
        label: "Open Recent",
        submenu: [
          ...recent,
          ...(recent.length > 0 ? [{ type: "separator" } as const] : []),
          {
            id: "clear-recent",
            label: "Clear Menu",
            enabled: recent.length > 0,
            click: () => actions.clearRecent(),
          },
        ],
      },
      { type: "separator" },
      { role: "close" },
    ],
  };
}

/** The native menu: standard roles, plus development items outside the packaged app. */
export function buildMenu(actions: FileMenuActions): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    fileMenu(actions),
    { role: "editMenu" },
    viewMenu(app.isPackaged, LAB_BUILD ? [diffLabMenuItem()] : []),
    { role: "windowMenu" },
    { role: "help", submenu: [] },
  ];
  return Menu.buildFromTemplate(template);
}
