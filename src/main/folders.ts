import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type BrowserWindow, dialog } from "electron";
import type { Logger } from "../shared/log";
import { MAX_RECENT_FOLDERS } from "../shared/settings";
import type { SettingsStore } from "./settings";

/**
 * The real path of an existing folder, or `null` for anything else. Scan roots are kept as
 * real paths, so the same folder reached through a symlink opens the same window.
 */
export async function resolveFolder(path: string): Promise<string | null> {
  if (!isAbsolute(path) || path.includes("\0")) return null;
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** `settings.recentFolders`: newest first, no duplicates, at most `MAX_RECENT_FOLDERS`. */
export class RecentFolders {
  readonly #settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.#settings = settings;
  }

  list(): readonly string[] {
    return this.#settings.get().recentFolders;
  }

  has(path: string): boolean {
    return this.list().includes(path);
  }

  add(path: string): void {
    const next = [path, ...this.list().filter((item) => item !== path)].slice(
      0,
      MAX_RECENT_FOLDERS,
    );
    if (sameList(next, this.list())) return;
    this.#settings.set({ recentFolders: next });
  }

  remove(path: string): void {
    if (!this.has(path)) return;
    this.#settings.set({ recentFolders: this.list().filter((item) => item !== path) });
  }

  clear(): void {
    if (this.list().length > 0) this.#settings.set({ recentFolders: [] });
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export interface FolderOpenerOptions {
  recent: RecentFolders;
  /** Opens a scan window for a real folder path, or focuses the one showing it. */
  openScanWindow: (scanRoot: string) => BrowserWindow;
  log: Logger;
}

/**
 * Every way a folder gets opened: the folder dialog, Open Recent, a drop on a window or the
 * Dock, a second launch. Each resolves the folder, remembers it as recent and opens (or
 * focuses) its one window.
 */
export class FolderOpener {
  readonly #options: FolderOpenerOptions;

  constructor(options: FolderOpenerOptions) {
    this.#options = options;
  }

  /** Opens `path` when it is an existing folder; `null` otherwise. */
  async open(path: string): Promise<BrowserWindow | null> {
    const folder = await resolveFolder(path);
    if (folder === null) {
      this.#options.log.warn("not opening a path that is not an existing folder", { path });
      return null;
    }
    this.#options.recent.add(folder);
    return this.#options.openScanWindow(folder);
  }

  /** Open Recent: only folders on the list; one that is gone is dropped from it. */
  async openRecent(path: string): Promise<BrowserWindow | null> {
    if (!this.#options.recent.has(path)) return null;
    const opened = await this.open(path);
    if (opened === null) this.#options.recent.remove(path);
    return opened;
  }

  /** The native folder dialog, as a sheet on `parent` when there is one. */
  async choose(parent: BrowserWindow | null): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: "Open Folder",
      buttonLabel: "Open",
      properties: ["openDirectory"],
    };
    const result =
      parent && !parent.isDestroyed()
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (chosen === undefined) return null;
    const opened = await this.open(chosen);
    return opened === null ? null : await resolveFolder(chosen);
  }
}

/**
 * Folders handed to the app before it is ready (a Dock drop that launched it) wait here
 * until the opener exists. Register it before `app.whenReady()`, as `open-file` can fire
 * during launch.
 */
export class PendingFolders {
  #queue: string[] = [];
  #sink: ((path: string) => void) | null = null;

  push(path: string): void {
    if (this.#sink) this.#sink(path);
    else this.#queue.push(path);
  }

  /** Drains what arrived early, then delivers each new folder straight away. */
  drainInto(sink: (path: string) => void): void {
    this.#sink = sink;
    for (const path of this.#queue.splice(0)) sink(path);
  }

  get pending(): number {
    return this.#queue.length;
  }
}
