import type { BrowserWindow } from "electron";
import type { SettingsSection } from "../shared/ipc/contract";
import type { Logger } from "../shared/log";
import { SingletonWindow } from "./windows";

/** The Settings window's default size and minimum. */
export const SETTINGS_WINDOW_SIZE = Object.freeze({
  width: 760,
  height: 540,
  minWidth: 640,
  minHeight: 460,
});

export interface SettingsWindowOptions {
  /** Creates the window with the app's hardened setup. */
  create: () => BrowserWindow;
  /** Tells the window which section to show. */
  showSection: (win: BrowserWindow, section: SettingsSection) => void;
  log: Logger;
}

/**
 * The Settings window (⌘,): one instance. Asking for it again brings the open one
 * forward, at the section asked for.
 */
export class SettingsWindow {
  readonly #options: SettingsWindowOptions;
  readonly #single: SingletonWindow;

  constructor(options: SettingsWindowOptions) {
    this.#options = options;
    this.#single = new SingletonWindow(options.create);
  }

  open(section?: SettingsSection): BrowserWindow {
    const { win, created } = this.#single.open();
    this.#options.log.info(created ? "opened the settings window" : "focused the settings window", {
      section: section ?? null,
    });
    if (section) this.#options.showSection(win, section);
    return win;
  }

  get(): BrowserWindow | null {
    return this.#single.get();
  }

  fromContentsId(contentsId: number): BrowserWindow | null {
    return this.#single.fromContentsId(contentsId);
  }
}
