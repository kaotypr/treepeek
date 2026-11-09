import { BrowserWindow } from "electron";
import type { ResolvedTheme } from "../shared/settings";
import { WINDOW_BACKGROUND } from "../shared/theme";

export interface CreateWindowOptions {
  theme: ResolvedTheme;
  preload: string;
  url: string;
}

/** The argument the preload reads to set the theme class before anything renders. */
export const THEME_ARGUMENT = "--treepeek-theme=";

/**
 * Set to `1` by the end-to-end launcher so test runs leave the person's screen alone:
 * windows open without taking focus, fully transparent and click-through, and the app
 * gets no Dock icon. Chromium still treats the window as shown, so pages lay out, paint
 * and run timers as they would on screen, and the tests drive them over DevTools.
 */
export const BACKGROUND_ENV = "TREEPEEK_E2E_BACKGROUND";

export function inBackgroundMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BACKGROUND_ENV] === "1";
}

/**
 * Creates a hardened window: isolated, sandboxed, no Node, no navigation, no new windows.
 * It is painted with the theme's background and shown only once it has rendered.
 */
export function createWindow(options: CreateWindowOptions): BrowserWindow {
  const background = inBackgroundMode();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    opacity: background ? 0 : 1,
    title: "Treepeek",
    titleBarStyle: "hiddenInset",
    backgroundColor: WINDOW_BACKGROUND[options.theme],
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      // A transparent window may count as occluded; keep it rendering like a visible one.
      backgroundThrottling: !background,
      additionalArguments: [`${THEME_ARGUMENT}${options.theme}`],
    },
  });
  guardWebContents(win.webContents);
  win.once("ready-to-show", () => {
    if (!background) {
      win.show();
      return;
    }
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  });
  void win.loadURL(options.url);
  return win;
}

/** No web contents may open windows, navigate away, or attach a webview. */
export function guardWebContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * One window per scan root. `openOrFocus` brings the existing window forward rather than
 * opening a second one for the same folder.
 */
export class WindowRegistry {
  readonly #byKey = new Map<string, BrowserWindow>();
  readonly #create: (scanRoot: string) => BrowserWindow;
  readonly #closedListeners = new Set<(scanRoot: string) => void>();

  constructor(create: (scanRoot: string) => BrowserWindow) {
    this.#create = create;
  }

  openOrFocus(scanRoot: string): BrowserWindow {
    const existing = this.#byKey.get(scanRoot);
    if (existing && !existing.isDestroyed()) {
      focusWindow(existing);
      return existing;
    }
    const win = this.#create(scanRoot);
    this.#byKey.set(scanRoot, win);
    win.once("closed", () => {
      if (this.#byKey.get(scanRoot) === win) this.#byKey.delete(scanRoot);
      for (const listener of this.#closedListeners) listener(scanRoot);
    });
    return win;
  }

  get(scanRoot: string): BrowserWindow | undefined {
    return this.#byKey.get(scanRoot);
  }

  all(): BrowserWindow[] {
    return [...this.#byKey.values()].filter((win) => !win.isDestroyed());
  }

  has(win: BrowserWindow): boolean {
    return this.all().includes(win);
  }

  onClosed(listener: (scanRoot: string) => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }
}

export function focusWindow(win: BrowserWindow): void {
  if (inBackgroundMode()) {
    if (!win.isVisible()) win.showInactive();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}
