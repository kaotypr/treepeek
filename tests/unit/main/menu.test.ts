import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: (template: unknown) => template },
}));

const { fileMenu, viewMenu } = await import("../../../src/main/menu");

type Item = Electron.MenuItemConstructorOptions;
const submenu = (item: Item | undefined): Item[] => (item?.submenu as Item[] | undefined) ?? [];

describe("the File menu", () => {
  it("opens folders with ⌘O and lists recent folders, newest first", () => {
    const opened: string[] = [];
    let cleared = false;
    const menu = fileMenu({
      openFolder: () => opened.push("dialog"),
      recentFolders: ["/w/new", "/w/old"],
      openRecent: (path) => opened.push(path),
      clearRecent: () => {
        cleared = true;
      },
    });
    const items = submenu(menu);
    const open = items.find((item) => item.id === "open-folder");
    expect(open).toMatchObject({ label: "Open Folder…", accelerator: "CmdOrCtrl+O" });
    const recent = submenu(items.find((item) => item.id === "open-recent"));
    expect(recent.map((item) => item.label ?? item.type)).toEqual([
      "/w/new",
      "/w/old",
      "separator",
      "Clear Menu",
    ]);
    recent[1]?.click?.({} as never, undefined, {} as never);
    recent[3]?.click?.({} as never, undefined, {} as never);
    open?.click?.({} as never, undefined, {} as never);
    expect(opened).toEqual(["/w/old", "dialog"]);
    expect(cleared).toBe(true);
    expect(items.some((item) => item.role === "close")).toBe(true);
  });

  it("disables Clear Menu when there is nothing recent", () => {
    const recent = submenu(
      submenu(
        fileMenu({
          openFolder: () => {},
          recentFolders: [],
          openRecent: () => {},
          clearRecent: () => {},
        }),
      ).find((item) => item.id === "open-recent"),
    );
    expect(recent).toEqual([expect.objectContaining({ label: "Clear Menu", enabled: false })]);
  });
});

describe("the View menu", () => {
  it("leaves ⌘R to the window's Refresh in development builds", () => {
    const items = submenu(viewMenu(false));
    const accelerators = items.map((item) => item.accelerator).filter(Boolean);
    expect(accelerators).not.toContain("CmdOrCtrl+R");
    expect(items.find((item) => item.role === "reload")?.accelerator).toBe("Alt+CmdOrCtrl+R");
  });
});
