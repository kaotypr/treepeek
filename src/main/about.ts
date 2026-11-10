import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { Logger } from "../shared/log";
import { SingletonWindow } from "./windows";

/** The About window's default size and minimum. */
export const ABOUT_WINDOW_SIZE = Object.freeze({
  width: 560,
  height: 620,
  minWidth: 440,
  minHeight: 420,
});

export const COPYRIGHT = "Copyright 2026 Adhitya Yosua Sanjaya Andaria";
export const LICENSE = "Licensed under the Apache License, Version 2.0.";

/** Notices bigger than this are cut; they are shown, not parsed. */
const MAX_NOTICE_BYTES = 4 * 1024 * 1024;

export interface AboutInfo {
  name: string;
  version: string;
  license: string;
  copyright: string;
  notice: string | null;
  thirdPartyNotices: string | null;
  versions: { electron: string; chrome: string; node: string };
}

export interface NoticeLocations {
  /** Folders looked in, in order: the packaged app's `Resources`, then the source tree. */
  dirs: readonly string[];
}

/**
 * The `NOTICE` and `THIRD_PARTY_NOTICES` files, read from the first folder that has them.
 * A packaged app carries them in `Contents/Resources` (`process.resourcesPath`); a build run
 * from the source tree reads them there (`THIRD_PARTY_NOTICES` is generated into `build/`).
 * Either may be missing from a build; it then shows as `null`.
 */
export function readNotices(locations: NoticeLocations): {
  notice: string | null;
  thirdPartyNotices: string | null;
} {
  const find = (names: readonly string[]) => {
    for (const dir of locations.dirs) {
      for (const name of names) {
        const text = readTextFile(join(dir, name));
        if (text !== null) return text;
      }
    }
    return null;
  };
  return {
    notice: find(["NOTICE"]),
    thirdPartyNotices: find(["THIRD_PARTY_NOTICES", "build/THIRD_PARTY_NOTICES"]),
  };
}

function readTextFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path).subarray(0, MAX_NOTICE_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

export interface AboutWindowOptions {
  create: () => BrowserWindow;
  log: Logger;
}

/** The About window (Treepeek › About, Help › Acknowledgements): one instance. */
export class AboutWindow {
  readonly #single: SingletonWindow;
  readonly #log: Logger;

  constructor(options: AboutWindowOptions) {
    this.#single = new SingletonWindow(options.create);
    this.#log = options.log;
  }

  open(): BrowserWindow {
    const { win, created } = this.#single.open();
    this.#log.info(created ? "opened the about window" : "focused the about window");
    return win;
  }

  get(): BrowserWindow | null {
    return this.#single.get();
  }

  fromContentsId(contentsId: number): BrowserWindow | null {
    return this.#single.fromContentsId(contentsId);
  }
}
