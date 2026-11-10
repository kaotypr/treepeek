import { BrowserWindow, screen } from "electron";
import type { ResolvedTheme, WindowBounds } from "../shared/settings";
import { WINDOW_BACKGROUND } from "../shared/theme";

export interface CreateWindowOptions {
  theme: ResolvedTheme;
  preload: string;
  url: string;
  /** Window title (the Window menu and Mission Control); the hidden title bar never shows it. */
  title?: string;
  /** Where to put the window; centred at the default size otherwise. */
  bounds?: WindowBounds | null;
  /** The size used without `bounds`, and the minimum; the scan window's when absent. */
  size?: { width: number; height: number; minWidth: number; minHeight: number };
  /**
   * The macOS `sidebar` material behind the window. The page then paints its own opaque
   * surfaces and leaves the side panels translucent; the window background is clear, so the
   * material (which follows the appearance) is what shows before the first frame.
   */
  vibrancy?: boolean;
}

/** A scan window's default size and minimum. */
export const SCAN_WINDOW_SIZE = Object.freeze({
  width: 1280,
  height: 820,
  minWidth: 880,
  minHeight: 560,
});

/** The welcome window's default size and minimum. */
export const WELCOME_WINDOW_SIZE = Object.freeze({
  width: 720,
  height: 500,
  minWidth: 560,
  minHeight: 420,
});

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
  const size = options.size ?? SCAN_WINDOW_SIZE;
  const bounds = options.bounds ? visibleBounds(options.bounds) : null;
  const win = new BrowserWindow({
    width: bounds?.width ?? size.width,
    height: bounds?.height ?? size.height,
    ...(bounds && bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    show: false,
    opacity: background ? 0 : 1,
    title: options.title ?? "Treepeek",
    titleBarStyle: "hiddenInset",
    backgroundColor: options.vibrancy ? "#00000000" : WINDOW_BACKGROUND[options.theme],
    ...(options.vibrancy
      ? { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const }
      : {}),
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

/**
 * Saved bounds, kept only where they still land on a connected display. A window saved on
 * a monitor that has since been unplugged keeps its size and is placed by macOS instead.
 */
function visibleBounds(saved: WindowBounds): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  const onScreen = screen.getAllDisplays().some(({ workArea }) => {
    const width =
      Math.min(saved.x + saved.width, workArea.x + workArea.width) - Math.max(saved.x, workArea.x);
    const height =
      Math.min(saved.y + saved.height, workArea.y + workArea.height) -
      Math.max(saved.y, workArea.y);
    return width >= 80 && height >= 40;
  });
  return onScreen ? saved : { width: saved.width, height: saved.height };
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
