import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { Logger } from "../shared/log";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
  SettingsPatchSchema,
  SettingsSchema,
} from "../shared/settings";

/** The on-disk format version of `settings.json`. */
export const SETTINGS_VERSION = 1;

type RawSettings = Record<string, unknown>;

/**
 * Upgrades, keyed by the version they upgrade from: `migrations[1]` turns a version 1 file
 * into version 2. Add one with every bump of `SETTINGS_VERSION`.
 */
export const migrations: Readonly<Record<number, (raw: RawSettings) => RawSettings>> = {};

const FILE_NAME = "settings.json";

/**
 * `userData/settings.json`, owned by main. Writes are atomic (temporary file, then
 * rename). A file that cannot be read is moved aside as `settings.corrupt-<time>.json` and
 * the defaults load.
 */
export class SettingsStore {
  readonly #dir: string;
  readonly #log: Logger | undefined;
  readonly #listeners = new Set<(settings: Settings, previous: Settings) => void>();
  #current: Settings;

  constructor(dir: string, log?: Logger) {
    this.#dir = dir;
    this.#log = log;
    this.#current = this.#load();
  }

  get path(): string {
    return join(this.#dir, FILE_NAME);
  }

  get(): Settings {
    return this.#current;
  }

  set(patch: SettingsPatch): Settings {
    const checked = v.parse(SettingsPatchSchema, patch);
    const next = v.parse(SettingsSchema, { ...this.#current, ...definedOnly(checked) });
    const previous = this.#current;
    this.#write(next);
    this.#current = Object.freeze(next);
    for (const listener of this.#listeners) listener(this.#current, previous);
    return this.#current;
  }

  onChange(listener: (settings: Settings, previous: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #load(): Settings {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return DEFAULT_SETTINGS;
      this.#log?.warn("could not read settings; using defaults", { error });
      return DEFAULT_SETTINGS;
    }

    try {
      const raw: unknown = JSON.parse(text);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("settings.json is not an object");
      }
      const migrated = migrate(raw as RawSettings);
      return Object.freeze(v.parse(SettingsSchema, { ...DEFAULT_SETTINGS, ...migrated }));
    } catch (error) {
      const aside = join(this.#dir, `settings.corrupt-${timestamp()}.json`);
      try {
        renameSync(this.path, aside);
      } catch {
        // Nothing more to do; defaults still load.
      }
      this.#log?.warn("settings.json was unreadable; moved it aside and loaded defaults", {
        movedTo: aside,
        error,
      });
      return DEFAULT_SETTINGS;
    }
  }

  #write(settings: Settings): void {
    const body = `${JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)}\n`;
    const temporary = join(this.#dir, `${FILE_NAME}.${process.pid}.tmp`);
    try {
      writeFileSync(temporary, body, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

function migrate(raw: RawSettings): RawSettings {
  let version = typeof raw.version === "number" ? raw.version : SETTINGS_VERSION;
  let current = raw;
  while (version < SETTINGS_VERSION) {
    const step = migrations[version];
    if (!step) throw new Error(`No settings migration from version ${version}`);
    current = step(current);
    version += 1;
  }
  const { version: _version, ...rest } = current;
  return rest;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** A filename-safe UTC time: `2026-11-09T10-53-00-000Z`. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
