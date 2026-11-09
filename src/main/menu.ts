import { app, Menu, type MenuItemConstructorOptions } from "electron";

/** The native menu: standard roles only. Later plans add their own items. */
export function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...(app.isPackaged
          ? []
          : ([
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" },
            ] satisfies MenuItemConstructorOptions[])),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [] },
  ];
  return Menu.buildFromTemplate(template);
}
