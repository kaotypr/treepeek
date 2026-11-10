import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing here opens a native dialog; the opener is handed a fake one.
vi.mock("electron", () => ({ dialog: {} }));

const { FolderOpener, PendingFolders, RecentFolders, resolveFolder } = await import(
  "../../../src/main/folders"
);
const { SettingsStore } = await import("../../../src/main/settings");
const { createLogger } = await import("../../../src/shared/log");

let dir: string;
let settingsDir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-folders-")));
  settingsDir = mkdtempSync(join(tmpdir(), "treepeek-folders-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(settingsDir, { recursive: true, force: true });
});

const log = createLogger({ scope: "test", sink: () => {} });

describe("resolveFolder", () => {
  it("answers the real path of a folder, through symlinks", async () => {
    mkdirSync(join(dir, "work"));
    symlinkSync(join(dir, "work"), join(dir, "link"));
    expect(await resolveFolder(join(dir, "work"))).toBe(join(dir, "work"));
    expect(await resolveFolder(join(dir, "link"))).toBe(join(dir, "work"));
  });

  it("refuses files, missing paths, relative paths and NUL", async () => {
    writeFileSync(join(dir, "file.txt"), "x");
    expect(await resolveFolder(join(dir, "file.txt"))).toBeNull();
    expect(await resolveFolder(join(dir, "missing"))).toBeNull();
    expect(await resolveFolder("relative/folder")).toBeNull();
    expect(await resolveFolder(`${dir}\0`)).toBeNull();
  });
});

describe("RecentFolders", () => {
  it("keeps the newest first, without duplicates, at most ten", () => {
    const recent = new RecentFolders(new SettingsStore(settingsDir));
    for (let index = 0; index < 12; index += 1) recent.add(`/f${index}`);
    recent.add("/f5");
    expect(recent.list()).toEqual([
      "/f5",
      "/f11",
      "/f10",
      "/f9",
      "/f8",
      "/f7",
      "/f6",
      "/f4",
      "/f3",
      "/f2",
    ]);
    recent.remove("/f11");
    expect(recent.has("/f11")).toBe(false);
    recent.clear();
    expect(recent.list()).toEqual([]);
  });
});

describe("FolderOpener", () => {
  function setup(answer: string | null = null) {
    const settings = new SettingsStore(settingsDir);
    const recent = new RecentFolders(settings);
    const opened: string[] = [];
    const opener = new FolderOpener({
      recent,
      log,
      dialog: async () => answer,
      openScanWindow: (scanRoot) => {
        opened.push(scanRoot);
        return {} as Electron.BrowserWindow;
      },
    });
    return { recent, opened, opener };
  }

  it("opens a folder by its real path and remembers it", async () => {
    mkdirSync(join(dir, "work"));
    symlinkSync(join(dir, "work"), join(dir, "link"));
    const { recent, opened, opener } = setup();
    expect(await opener.open(join(dir, "link"))).not.toBeNull();
    expect(opened).toEqual([join(dir, "work")]);
    expect(recent.list()).toEqual([join(dir, "work")]);
  });

  it("opens nothing for a path that is not a folder", async () => {
    writeFileSync(join(dir, "file.txt"), "x");
    const { opened, opener, recent } = setup();
    expect(await opener.open(join(dir, "file.txt"))).toBeNull();
    expect(opened).toEqual([]);
    expect(recent.list()).toEqual([]);
  });

  it("opens only recent folders, and forgets one that is gone", async () => {
    mkdirSync(join(dir, "work"));
    const { recent, opened, opener } = setup();
    expect(await opener.openRecent(join(dir, "work"))).toBeNull();
    expect(opened).toEqual([]);

    recent.add(join(dir, "work"));
    recent.add(join(dir, "gone"));
    expect(await opener.openRecent(join(dir, "work"))).not.toBeNull();
    expect(await opener.openRecent(join(dir, "gone"))).toBeNull();
    expect(opened).toEqual([join(dir, "work")]);
    expect(recent.list()).toEqual([join(dir, "work")]);
  });

  it("opens the folder the dialog answers, and nothing when it is cancelled", async () => {
    mkdirSync(join(dir, "picked"));
    const picked = setup(join(dir, "picked"));
    expect(await picked.opener.choose(null)).toBe(realpathSync(join(dir, "picked")));
    expect(picked.opened).toEqual([realpathSync(join(dir, "picked"))]);

    const cancelled = setup(null);
    expect(await cancelled.opener.choose(null)).toBeNull();
    expect(cancelled.opened).toEqual([]);
  });
});

describe("PendingFolders", () => {
  it("holds folders that arrive before the opener, then delivers each new one at once", () => {
    const pending = new PendingFolders();
    pending.push("/early");
    expect(pending.pending).toBe(1);
    const delivered: string[] = [];
    pending.drainInto((path) => delivered.push(path));
    pending.push("/late");
    expect(delivered).toEqual(["/early", "/late"]);
    expect(pending.pending).toBe(0);
  });
});
