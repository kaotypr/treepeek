import { basename } from "node:path";
import type { BrowserWindow } from "electron";
import type { Logger } from "../shared/log";
import {
  MAX_RESTORED_WINDOWS,
  type SavedWindow,
  type WindowBounds,
  type WindowUiState,
} from "../shared/settings";
import type { SettingsStore } from "./settings";
import { focusWindow, WindowRegistry } from "./windows";

export interface WindowSpec {
  /** The folder the window scans, or `null` for the welcome window. */
  scanRoot: string | null;
  title: string;
  bounds: WindowBounds | null;
}

export interface AppWindowsOptions {
  settings: SettingsStore;
  /** Creates a window (scan or welcome) with the app's hardened setup. */
  create: (spec: WindowSpec) => BrowserWindow;
  log: Logger;
  /** How long window moves and layout changes wait before they are written to settings. */
  persistDelayMs?: number;
}

/**
 * The app's windows: one scan window per folder, and the welcome window whenever no scan
 * window is open. It keeps `settings.windows` in step with the open scan windows (scan
 * root, bounds, layout), so they come back on the next launch.
 *
 * While the app quits, closing windows no longer removes them from that list: they were
 * open at quit, so they are the ones to restore.
 */
export class AppWindows {
  readonly #options: AppWindowsOptions;
  readonly #scan: WindowRegistry;
  /** Live state of each open scan window, in the order they opened. */
  readonly #saved = new Map<BrowserWindow, SavedWindow>();
  #welcome: BrowserWindow | null = null;
  #quitting = false;
  #persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** The saved window being reopened by `restore`, read while its window is created. */
  #restoring: SavedWindow | null = null;

  constructor(options: AppWindowsOptions) {
    this.#options = options;
    this.#scan = new WindowRegistry((scanRoot) => this.#createScanWindow(scanRoot));
  }

  /** Opens a scan window for a real folder path, or focuses the one already showing it. */
  openScanWindow(scanRoot: string): BrowserWindow {
    const existing = this.#scan.get(scanRoot);
    const win = this.#scan.openOrFocus(scanRoot);
    if (existing !== win) this.#closeWelcome();
    return win;
  }

  /** Shows the welcome window, creating it when there is none. */
  openWelcomeWindow(): BrowserWindow {
    if (this.#welcome && !this.#welcome.isDestroyed()) {
      focusWindow(this.#welcome);
      return this.#welcome;
    }
    const win = this.#options.create({ scanRoot: null, title: "Treepeek", bounds: null });
    this.#welcome = win;
    win.once("closed", () => {
      if (this.#welcome === win) this.#welcome = null;
    });
    return win;
  }

  /**
   * Opens the scan windows saved at the last quit, skipping folders that `exists` says are
   * gone. Answers how many opened; the caller shows the welcome window when none did.
   */
  async restore(exists: (path: string) => Promise<string | null>): Promise<number> {
    let opened = 0;
    for (const saved of this.#options.settings.get().windows.slice(0, MAX_RESTORED_WINDOWS)) {
      const scanRoot = await exists(saved.scanRoot);
      if (scanRoot === null || this.#scan.get(scanRoot)) continue;
      this.#restoring = { ...saved, scanRoot };
      try {
        this.openScanWindow(scanRoot);
        opened += 1;
      } finally {
        this.#restoring = null;
      }
    }
    if (opened === 0 && this.#options.settings.get().windows.length > 0) this.#persist();
    return opened;
  }

  /** The window a call came from, by its web contents id. */
  fromContentsId(id: number): BrowserWindow | null {
    for (const win of this.all()) {
      if (!win.isDestroyed() && win.webContents.id === id) return win;
    }
    return null;
  }

  /** What the window shows: its scan root, or `null` for the welcome window. */
  scanRootOf(win: BrowserWindow): string | null {
    return this.#saved.get(win)?.scanRoot ?? null;
  }

  /** The layout a scan window saved; `null` for a new one or the welcome window. */
  uiOf(win: BrowserWindow): WindowUiState | null {
    return this.#saved.get(win)?.ui ?? null;
  }

  /** Records a scan window's layout and view (`window.state`). */
  setUi(win: BrowserWindow, ui: WindowUiState): boolean {
    const saved = this.#saved.get(win);
    if (!saved) return false;
    this.#saved.set(win, { ...saved, ui });
    this.#schedulePersist();
    return true;
  }

  /** Every open window, scan windows first. */
  all(): BrowserWindow[] {
    const scan = this.#scan.all();
    return this.#welcome && !this.#welcome.isDestroyed() ? [...scan, this.#welcome] : scan;
  }

  scanWindows(): BrowserWindow[] {
    return this.#scan.all();
  }

  has(win: BrowserWindow): boolean {
    return this.all().includes(win);
  }

  /** From now on closing windows keeps them in the restore list; saves it right away. */
  beginQuit(): void {
    if (this.#quitting) return;
    this.#quitting = true;
    for (const win of this.#saved.keys()) this.#captureBounds(win);
    this.#persist();
  }

  #createScanWindow(scanRoot: string): BrowserWindow {
    const restoring = this.#restoring;
    const win = this.#options.create({
      scanRoot,
      title: basename(scanRoot) || scanRoot,
      bounds: restoring?.bounds ?? null,
    });
    this.#saved.set(win, {
      scanRoot,
      bounds: restoring?.bounds ?? null,
      ui: restoring?.ui ?? null,
    });
    const track = () => {
      this.#captureBounds(win);
      this.#schedulePersist();
    };
    win.on("resize", track);
    win.on("move", track);
    win.on("close", () => this.#captureBounds(win));
    win.once("closed", () => {
      if (this.#quitting) return;
      this.#saved.delete(win);
      this.#persist();
      if (this.#scan.all().length === 0) this.openWelcomeWindow();
    });
    this.#schedulePersist();
    return win;
  }

  #captureBounds(win: BrowserWindow): void {
    const saved = this.#saved.get(win);
    if (!saved || win.isDestroyed()) return;
    // A full-screen or minimized window keeps the bounds it had before.
    if (win.isFullScreen() || win.isMinimized()) return;
    this.#saved.set(win, { ...saved, bounds: roundBounds(win.getNormalBounds()) });
  }

  #schedulePersist(): void {
    if (this.#persistTimer !== null) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#persist();
    }, this.#options.persistDelayMs ?? 500);
  }

  #persist(): void {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    const windows = [...this.#saved.values()].slice(0, MAX_RESTORED_WINDOWS);
    try {
      this.#options.settings.set({ windows });
    } catch (error) {
      this.#options.log.warn("could not save the open windows", { error });
    }
  }

  #closeWelcome(): void {
    const welcome = this.#welcome;
    this.#welcome = null;
    if (welcome && !welcome.isDestroyed()) welcome.close();
  }
}

function roundBounds(bounds: WindowBounds): WindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}
