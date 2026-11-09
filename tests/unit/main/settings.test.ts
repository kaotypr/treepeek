import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_VERSION, SettingsStore } from "../../../src/main/settings";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("loads defaults when there is no file, and writes nothing", () => {
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("persists a change across a restart", () => {
    new SettingsStore(dir).set({ appearance: "dark" });
    const reopened = new SettingsStore(dir);
    expect(reopened.get().appearance).toBe("dark");
    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(onDisk).toEqual({ version: SETTINGS_VERSION, appearance: "dark" });
  });

  it("writes atomically, leaving no temporary file behind", () => {
    const store = new SettingsStore(dir);
    store.set({ appearance: "light" });
    store.set({ appearance: "dark" });
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("moves a corrupt file aside and loads defaults", () => {
    writeFileSync(join(dir, "settings.json"), "{ not json");
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const files = readdirSync(dir);
    expect(files).not.toContain("settings.json");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^settings\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
    expect(readFileSync(join(dir, files[0] ?? ""), "utf8")).toBe("{ not json");
  });

  it("treats a file with invalid values as corrupt", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, appearance: "neon" }));
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
    expect(readdirSync(dir).some((name) => name.startsWith("settings.corrupt-"))).toBe(true);
  });

  it("rejects unknown keys and invalid values on set", () => {
    const store = new SettingsStore(dir);
    expect(() => store.set({ appearance: "neon" } as never)).toThrow();
    expect(() => store.set({ shell: "/bin/sh" } as never)).toThrow();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("notifies listeners with the new and previous settings", () => {
    const store = new SettingsStore(dir);
    const seen: string[] = [];
    store.onChange((next, previous) => seen.push(`${previous.appearance}->${next.appearance}`));
    store.set({ appearance: "dark" });
    expect(seen).toEqual(["system->dark"]);
  });
});
