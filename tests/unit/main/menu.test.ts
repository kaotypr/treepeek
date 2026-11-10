import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, name: "Treepeek" },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: (template: unknown) => template },
}));

const { BrowserWindow } = await import("electron");
const {
  applyCommandState,
  checkAppearance,
  COMMAND_ACCELERATORS,
  fileMenu,
  HELP_LINKS,
  menuTemplate,
  viewMenu,
} = await import("../../../src/main/menu");
const { COMMAND_IDS } = await import("../../../src/shared/commands");

type Item = Electron.MenuItemConstructorOptions;
const submenu = (item: Item | undefined): Item[] => (item?.submenu as Item[] | undefined) ?? [];

/** Every item of a template, depth first. */
function flatten(items: readonly Item[]): Item[] {
  return items.flatMap((item) => [item, ...flatten(submenu(item))]);
}

function actions(overrides: Partial<Parameters<typeof menuTemplate>[0]> = {}) {
  const ran: [unknown, string][] = [];
  const calls: string[] = [];
  const value: Parameters<typeof menuTemplate>[0] = {
    openFolder: () => calls.push("openFolder"),
    recentFolders: [],
    openRecent: (path) => calls.push(`openRecent:${path}`),
    clearRecent: () => calls.push("clearRecent"),
    appearance: "system",
    setAppearance: (appearance) => calls.push(`appearance:${appearance}`),
    openSettings: () => calls.push("settings"),
    openAbout: () => calls.push("about"),
    openHelpLink: (link) => calls.push(`help:${link}`),
    runCommand: (win, id) => ran.push([win, id]),
    ...overrides,
  };
  return { value, ran, calls };
}

const click = (item: Item | undefined, win?: unknown) =>
  item?.click?.({} as never, win as never, {} as never);

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
    click(recent[1]);
    click(recent[3]);
    click(open);
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
    const items = submenu(viewMenu(actions().value, false));
    const reload = items.find((item) => item.role === "reload");
    expect(reload?.accelerator).toBe("Alt+CmdOrCtrl+R");
    expect(items.find((item) => item.id === "scan.refresh")?.accelerator).toBe("CmdOrCtrl+R");
  });

  it("has no development items in the packaged app", () => {
    const roles = submenu(viewMenu(actions().value, true)).map((item) => item.role);
    expect(roles).not.toContain("reload");
    expect(roles).not.toContain("toggleDevTools");
  });

  it("checks the appearance setting and changes it", () => {
    const { value, calls } = actions({ appearance: "dark" });
    const appearance = submenu(
      submenu(viewMenu(value, true)).find((item) => item.id === "appearance"),
    );
    expect(appearance.map((item) => [item.label, item.checked])).toEqual([
      ["System", false],
      ["Light", false],
      ["Dark", true],
    ]);
    click(appearance[1]);
    expect(calls).toEqual(["appearance:light"]);
  });
});

describe("the menu bar", () => {
  const template = menuTemplate(actions().value, true);
  const items = flatten(template);

  it("has the design's menus in order", () => {
    expect(template.map((item) => item.label ?? item.role)).toEqual([
      "Treepeek",
      "File",
      "Edit",
      "View",
      "Go",
      "Checkout",
      "windowMenu",
      "help",
    ]);
  });

  it("shows every shortcut from the design's table (V and ⌘↩ arrive with review marks)", () => {
    const accelerators = items.map((item) => item.accelerator).filter(Boolean);
    expect(new Set(accelerators)).toEqual(
      new Set([
        "CmdOrCtrl+,",
        "CmdOrCtrl+O",
        "CmdOrCtrl+R",
        "CmdOrCtrl+T",
        "CmdOrCtrl+Shift+T",
        "CmdOrCtrl+[",
        "CmdOrCtrl+]",
        "Alt+Up",
        "Alt+Down",
        "CmdOrCtrl+1",
        "CmdOrCtrl+2",
        "CmdOrCtrl+3",
        "CmdOrCtrl+Shift+F",
        "CmdOrCtrl+F",
        "CmdOrCtrl+K",
        "CmdOrCtrl+E",
        "CmdOrCtrl+Shift+E",
        "CmdOrCtrl+Shift+R",
      ]),
    );
    // One item per shortcut, so a key press can only ever mean one thing.
    expect(accelerators).toHaveLength(new Set(accelerators).size);
  });

  it("gives each command item its command's id, and the keymap's shortcut", () => {
    for (const [id, accelerator] of Object.entries(COMMAND_ACCELERATORS)) {
      expect(items.find((item) => item.id === id)?.accelerator, id).toBe(accelerator);
    }
    for (const id of COMMAND_IDS) {
      if (id === "appearance.cycle" || id === "app.settings") continue;
      expect(
        items.filter((item) => item.id === id),
        id,
      ).toHaveLength(1);
    }
  });

  it("sends a command item to the focused window, as command.run", () => {
    const { value, ran } = actions();
    const all = flatten(menuTemplate(value, true));
    const win = new BrowserWindow();
    click(
      all.find((item) => item.id === "checkout.openInEditor"),
      win,
    );
    click(
      all.find((item) => item.id === "view.timeline"),
      undefined,
    );
    expect(ran).toEqual([
      [win, "checkout.openInEditor"],
      [null, "view.timeline"],
    ]);
  });

  it("opens Settings and About from the app menu, and fixed pages from Help", () => {
    const { value, calls } = actions();
    const all = flatten(menuTemplate(value, true));
    expect(all.find((item) => item.id === "settings")?.accelerator).toBe("CmdOrCtrl+,");
    for (const id of [
      "settings",
      "about",
      "help.repository",
      "help.issues",
      "help.acknowledgements",
    ])
      click(all.find((item) => item.id === id));
    expect(calls).toEqual(["settings", "about", "help:repository", "help:issues", "about"]);
    expect(HELP_LINKS.repository).toMatch(/^https:\/\/github\.com\//);
    expect(all.find((item) => item.id === "check-for-updates")?.enabled).toBe(false);
  });
});

describe("applyCommandState", () => {
  /** A fake built menu: the template's command items, by id. */
  function builtMenu() {
    const byId = new Map<string, { enabled: boolean; checked: boolean }>();
    for (const item of flatten(menuTemplate(actions().value, true))) {
      if (item.id) byId.set(item.id, { enabled: item.enabled ?? true, checked: !!item.checked });
    }
    return { getMenuItemById: (id: string) => byId.get(id) ?? null, byId };
  }

  it("disables every checkout item with no scan window focused", () => {
    const menu = builtMenu();
    applyCommandState(menu, {
      enabled: new Set(["checkout.copyPath", "checkout.openInEditor"]),
      checked: new Set(),
    });
    expect(menu.byId.get("checkout.copyPath")?.enabled).toBe(true);
    applyCommandState(menu, null);
    for (const id of COMMAND_IDS) {
      const item = menu.byId.get(id);
      if (item) expect(item.enabled, id).toBe(false);
    }
    // App-level items stay as they are.
    expect(menu.byId.get("settings")?.enabled).toBe(true);
  });

  it("enables and checks what the focused window reports", () => {
    const menu = builtMenu();
    applyCommandState(menu, {
      enabled: new Set(["view.timeline", "preview.unified", "checkout.next"]),
      checked: new Set(["view.timeline", "preview.unified"]),
    });
    expect(menu.byId.get("view.timeline")).toEqual({ enabled: true, checked: true });
    expect(menu.byId.get("preview.unified")).toEqual({ enabled: true, checked: true });
    expect(menu.byId.get("preview.split")).toEqual({ enabled: false, checked: false });
    expect(menu.byId.get("checkout.next")?.enabled).toBe(true);
    expect(menu.byId.get("checkout.previous")?.enabled).toBe(false);
  });

  it("checks the current appearance", () => {
    const menu = builtMenu();
    checkAppearance(menu, "light");
    expect(menu.byId.get("appearance.light")?.checked).toBe(true);
    expect(menu.byId.get("appearance.system")?.checked).toBe(false);
  });
});
