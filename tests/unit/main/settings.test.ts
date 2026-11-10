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
    expect(onDisk).toEqual({
      version: SETTINGS_VERSION,
      appearance: "dark",
      gitPath: null,
      recentFolders: [],
      windows: [],
    });
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
  it("loads a file written before gitPath existed, with no override", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, appearance: "dark" }));
    expect(new SettingsStore(dir).get()).toEqual({
      appearance: "dark",
      gitPath: null,
      recentFolders: [],
      windows: [],
    });
  });

  it("keeps recent folders and saved windows across a restart", () => {
    const window = {
      scanRoot: "/Users/me/work",
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      ui: {
        timelineOpen: true,
        navigatorMode: "tree" as const,
        timelineGrouping: "repository" as const,
        timelineOrder: "newest" as const,
        previewMode: "unified" as const,
        timelineWidth: 280,
        navigatorWidth: 360,
        selectedCheckout: "/Users/me/work/app",
      },
    };
    new SettingsStore(dir).set({ recentFolders: ["/Users/me/work"], windows: [window] });
    const reopened = new SettingsStore(dir).get();
    expect(reopened.recentFolders).toEqual(["/Users/me/work"]);
    expect(reopened.windows).toEqual([window]);
  });

  it("drops damaged window entries without losing the other settings", () => {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        version: 1,
        appearance: "dark",
        recentFolders: ["relative/path"],
        windows: [{ scanRoot: "/Users/me/work", bounds: "wide", ui: { timelineOpen: "yes" } }],
      }),
    );
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual({
      appearance: "dark",
      gitPath: null,
      recentFolders: [],
      windows: [{ scanRoot: "/Users/me/work", bounds: null, ui: null }],
    });
    expect(readdirSync(dir).some((name) => name.startsWith("settings.corrupt-"))).toBe(false);
  });

  it("refuses relative recent folders and more than ten of them", () => {
    const store = new SettingsStore(dir);
    expect(() => store.set({ recentFolders: ["relative"] })).toThrow();
    expect(() =>
      store.set({ recentFolders: Array.from({ length: 11 }, (_, i) => `/f${i}`) }),
    ).toThrow();
    expect(store.get().recentFolders).toEqual([]);
  });

  it("stores the git binary override from main, and clears it with null", () => {
    const store = new SettingsStore(dir);
    store.set({ gitPath: "/opt/homebrew/bin/git" });
    expect(new SettingsStore(dir).get().gitPath).toBe("/opt/homebrew/bin/git");
    store.set({ gitPath: null });
    expect(new SettingsStore(dir).get().gitPath).toBeNull();
  });

  it("rejects a relative git path", () => {
    const store = new SettingsStore(dir);
    expect(() => store.set({ gitPath: "bin/git" })).toThrow();
    expect(store.get().gitPath).toBeNull();
  });
});
