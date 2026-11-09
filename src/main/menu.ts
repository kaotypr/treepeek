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
  const development: MenuItemConstructorOptions[] = packaged
    ? []
    : [
        { role: "reload" },
        { role: "forceReload" },
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

/** The native menu: standard roles, plus development items outside the packaged app. */
export function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    viewMenu(app.isPackaged, LAB_BUILD ? [diffLabMenuItem()] : []),
    { role: "windowMenu" },
    { role: "help", submenu: [] },
  ];
  return Menu.buildFromTemplate(template);
}
