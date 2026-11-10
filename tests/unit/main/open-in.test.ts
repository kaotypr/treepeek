import { describe, expect, it } from "vitest";
import type { DetectDeps } from "../../../src/main/open-in/detect";
import { detectEditors, editorLaunch, KNOWN_EDITORS } from "../../../src/main/open-in/editors";
import { OpenIn } from "../../../src/main/open-in/index";
import type { Launcher } from "../../../src/main/open-in/launcher";
import { expandTemplate } from "../../../src/main/open-in/template";
import { detectTerminals, terminalLaunch } from "../../../src/main/open-in/terminals";
import { CommandTemplateError, splitCommandTemplate } from "../../../src/shared/command-template";
import { createLogger } from "../../../src/shared/log";
import { type AppChoice, DEFAULT_SETTINGS, type Settings } from "../../../src/shared/settings";

const log = createLogger({ scope: "test", sink: () => {} });

const VSCODE = "/Applications/Visual Studio Code.app";
const ZED = "/Applications/Zed.app";
const WEBSTORM = "/Users/me/Applications/WebStorm.app";

/** A Mac with VS Code, Zed, WebStorm and the system apps, found through Spotlight. */
function fakeMac(options: { spotlight?: boolean; tools?: readonly string[] } = {}): DetectDeps {
  const spotlight = options.spotlight ?? true;
  const apps: Record<string, string> = {
    [VSCODE]: "com.microsoft.VSCode",
    [ZED]: "dev.zed.Zed",
    [WEBSTORM]: "com.jetbrains.WebStorm",
    "/System/Applications/TextEdit.app": "com.apple.TextEdit",
    "/System/Applications/Utilities/Terminal.app": "com.apple.Terminal",
    "/Applications/iTerm.app": "com.googlecode.iterm2",
  };
  const tools = new Set(
    options.tools ?? [`${VSCODE}/Contents/Resources/app/bin/code`, `${ZED}/Contents/MacOS/cli`],
  );
  return {
    mdfind: async (query) => {
      if (!spotlight) return [];
      const id = /== '(.+)'$/.exec(query)?.[1] ?? "";
      const matches = (bundleId: string) =>
        id.endsWith("*") ? bundleId.startsWith(id.slice(0, -1)) : bundleId === id;
      return Object.entries(apps)
        .filter(([, bundleId]) => matches(bundleId))
        .map(([path]) => path);
    },
    bundleIdOf: async (path) => apps[path] ?? null,
    exists: async (path) => path in apps || tools.has(path),
    applicationDirs: ["/Applications", "/System/Applications", "/Users/me/Applications"],
  };
}

interface Recorded {
  runs: { command: string; args: string[] }[];
  reveals: string[];
  copies: string[];
}

function recorder(): { launcher: Launcher; recorded: Recorded } {
  const recorded: Recorded = { runs: [], reveals: [], copies: [] };
  return {
    recorded,
    launcher: {
      run: async (launch) => {
        recorded.runs.push(launch);
      },
      reveal: (path) => recorded.reveals.push(path),
      openFolder: async () => {},
      copy: (text) => recorded.copies.push(text),
    },
  };
}

/**
 * The "Open in…" service against a fake core service that holds one scan: `/w/repo` and
 * everything inside it. Nothing is launched; the launcher records what would run.
 */
function setup(settings: Partial<Settings> = {}, detect: DetectDeps = fakeMac()) {
  const { launcher, recorded } = recorder();
  const asked: string[][] = [];
  const openIn = new OpenIn({
    validate: async (paths) => {
      asked.push([...paths]);
      return paths.map((path) => path === "/w/repo" || path.startsWith("/w/repo/"));
    },
    launcher,
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    detect,
    isFolder: async (path) => !path.includes("."),
    log,
  });
  return { openIn, recorded, asked };
}

describe("command templates", () => {
  it("split first, then substitute, so a path with spaces and ; is one argument", () => {
    const argv = expandTemplate("myeditor --line {line} {path}", {
      path: "/w/repo/a b; rm -rf ~/x $(touch y) 'z'.ts",
      line: 12,
    });
    expect(argv).toEqual(["myeditor", "--line", "12", "/w/repo/a b; rm -rf ~/x $(touch y) 'z'.ts"]);
    // The program and exactly three arguments.
    expect(argv.slice(1)).toHaveLength(3);
  });

  it("keeps quoted words together and substitutes inside them", () => {
    expect(
      expandTemplate(`'/Applications/My Editor.app/bin/ed' --goto "{path}:{line}" -x\\ y`, {
        path: "/w/r/a.ts",
        line: 3,
      }),
    ).toEqual(["/Applications/My Editor.app/bin/ed", "--goto", "/w/r/a.ts:3", "-x y"]);
  });

  it("stands in line 1 when the line is unknown", () => {
    expect(expandTemplate("ed +{line} {path}", { path: "/w/r" })).toEqual(["ed", "+1", "/w/r"]);
  });

  it("refuses an unclosed quote, a trailing backslash and an empty command", () => {
    expect(() => splitCommandTemplate("ed '{path}")).toThrow(CommandTemplateError);
    expect(() => splitCommandTemplate('ed "{path}')).toThrow(CommandTemplateError);
    expect(() => splitCommandTemplate("ed {path}\\")).toThrow(CommandTemplateError);
    expect(() => splitCommandTemplate("   ")).toThrow(CommandTemplateError);
    expect(() => splitCommandTemplate("'' {path}")).toThrow(CommandTemplateError);
  });
});

describe("the path rule for Open in…", () => {
  it("refuses a path that is in no scan with notInScan, and runs nothing", async () => {
    const { openIn, recorded, asked } = setup();
    for (const result of [
      await openIn.finder("/etc"),
      await openIn.editor("/w/other/file.ts", 3),
      await openIn.terminal("/Applications"),
      await openIn.finder("/w/repository-next-door"),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "notInScan" } });
    }
    expect(recorded).toEqual({ runs: [], reveals: [], copies: [] });
    expect(asked).toEqual([
      ["/etc"],
      ["/w/other/file.ts"],
      ["/Applications"],
      ["/w/repository-next-door"],
    ]);
  });

  it("refuses everything when the core service cannot say (it answers false)", async () => {
    const { launcher, recorded } = recorder();
    const openIn = new OpenIn({
      validate: async (paths) => paths.map(() => false),
      launcher,
      settings: () => DEFAULT_SETTINGS,
      detect: fakeMac(),
      log,
    });
    expect(await openIn.finder("/w/repo")).toMatchObject({ error: { code: "notInScan" } });
    expect(recorded.reveals).toEqual([]);
  });
});

describe("Reveal in Finder", () => {
  it("selects the checkout folder in Finder", async () => {
    const { openIn, recorded } = setup();
    expect(await openIn.finder("/w/repo")).toEqual({ ok: true, value: {} });
    expect(recorded.reveals).toEqual(["/w/repo"]);
  });
});

describe("Open in editor", () => {
  it("opens VS Code at the first changed line through its CLI: --goto path:line", async () => {
    const { openIn, recorded } = setup({
      editor: { kind: "app", bundleId: "com.microsoft.VSCode" },
    });
    expect(await openIn.editor("/w/repo/src/a b.ts", 12)).toEqual({ ok: true, value: {} });
    expect(recorded.runs).toEqual([
      {
        command: `${VSCODE}/Contents/Resources/app/bin/code`,
        args: ["--goto", "/w/repo/src/a b.ts:12"],
      },
    ]);
  });

  it("opens a folder, or a file without a line, with open -b", async () => {
    const { openIn, recorded } = setup({
      editor: { kind: "app", bundleId: "com.microsoft.VSCode" },
    });
    await openIn.editor("/w/repo");
    expect(recorded.runs).toEqual([
      { command: "/usr/bin/open", args: ["-b", "com.microsoft.VSCode", "/w/repo"] },
    ]);
  });

  it("picks the first detected editor when set to automatic", async () => {
    const { openIn, recorded } = setup();
    await openIn.editor("/w/repo/a.ts", 4);
    expect(recorded.runs[0]?.command).toBe(`${VSCODE}/Contents/Resources/app/bin/code`);
  });

  it("uses each editor's own line form, and opens without a line where it is unknown", async () => {
    const detected = await detectEditors(fakeMac());
    const exists = fakeMac().exists;
    const at = (setting: AppChoice) =>
      editorLaunch(setting, detected, { path: "/w/repo/a.ts", line: 7 }, exists);
    expect(await at({ kind: "app", bundleId: "dev.zed.Zed" })).toEqual({
      command: `${ZED}/Contents/MacOS/cli`,
      args: ["/w/repo/a.ts:7"],
    });
    expect(await at({ kind: "app", bundleId: "com.jetbrains.WebStorm" })).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "com.jetbrains.WebStorm", "/w/repo/a.ts"],
    });
    expect(await at({ kind: "app", bundleId: "com.apple.TextEdit" })).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "com.apple.TextEdit", "/w/repo/a.ts"],
    });
  });

  it("falls back to opening without a line when the editor's CLI is missing", async () => {
    const mac = fakeMac({ tools: [] });
    const launch = await editorLaunch(
      { kind: "app", bundleId: "com.microsoft.VSCode" },
      await detectEditors(mac),
      { path: "/w/repo/a.ts", line: 7 },
      mac.exists,
    );
    expect(launch).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "com.microsoft.VSCode", "/w/repo/a.ts"],
    });
  });

  it("runs a custom command as an argument array", async () => {
    const { openIn, recorded } = setup({
      editor: { kind: "custom", command: "myeditor --line {line} {path}" },
    });
    await openIn.editor("/w/repo/a b;c.ts", 9);
    expect(recorded.runs).toEqual([
      { command: "myeditor", args: ["--line", "9", "/w/repo/a b;c.ts"] },
    ]);
  });

  it("reports a program that could not start", async () => {
    const openIn = new OpenIn({
      validate: async (paths) => paths.map(() => true),
      launcher: { ...recorder().launcher, run: async () => Promise.reject(new Error("ENOENT")) },
      settings: () => DEFAULT_SETTINGS,
      detect: fakeMac(),
      log,
    });
    expect(await openIn.editor("/w/repo")).toMatchObject({
      ok: false,
      error: { code: "internal", message: "The editor could not be opened." },
    });
  });
});

describe("Open in terminal", () => {
  it("opens Terminal at the checkout folder by default, or the chosen terminal", async () => {
    expect(terminalLaunch({ kind: "auto" }, "/w/repo")).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "com.apple.Terminal", "/w/repo"],
    });
    const { openIn, recorded } = setup({
      terminal: { kind: "app", bundleId: "com.googlecode.iterm2" },
    });
    await openIn.terminal("/w/repo");
    expect(recorded.runs).toEqual([
      { command: "/usr/bin/open", args: ["-b", "com.googlecode.iterm2", "/w/repo"] },
    ]);
  });

  it("runs a custom terminal command without a shell", () => {
    expect(
      terminalLaunch(
        { kind: "custom", command: "open -na Alacritty --args --working-directory {path}" },
        "/w/my repo",
      ),
    ).toEqual({
      command: "open",
      args: ["-na", "Alacritty", "--args", "--working-directory", "/w/my repo"],
    });
  });

  it("never hands a terminal a file, which it would run", async () => {
    const { openIn, recorded } = setup();
    expect(await openIn.terminal("/w/repo/run.command")).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(recorded.runs).toEqual([]);
  });
});

describe("Copy", () => {
  it("writes exactly the text it is given: the full commit id, not a short one", () => {
    const { openIn, recorded } = setup();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    openIn.copy(commit);
    expect(recorded.copies).toEqual([commit]);
  });
});

describe("detection", () => {
  it("finds editors by bundle id with Spotlight, in the known order, listing each JetBrains IDE", async () => {
    const editors = await detectEditors(fakeMac());
    expect(editors.map((editor) => [editor.bundleId, editor.name, editor.opensAtLine])).toEqual([
      ["com.microsoft.VSCode", "Visual Studio Code", true],
      ["dev.zed.Zed", "Zed", true],
      ["com.jetbrains.WebStorm", "WebStorm", false],
      ["com.apple.TextEdit", "TextEdit", false],
    ]);
    expect(editors[0]?.path).toBe(VSCODE);
  });

  it("looks in the Applications folders when Spotlight finds nothing", async () => {
    const mac = fakeMac({ spotlight: false });
    expect((await detectEditors(mac)).map((editor) => editor.bundleId)).toEqual([
      "com.microsoft.VSCode",
      "dev.zed.Zed",
      "com.jetbrains.WebStorm",
      "com.apple.TextEdit",
    ]);
    expect((await detectTerminals(mac)).map((terminal) => terminal.bundleId)).toEqual([
      "com.apple.Terminal",
      "com.googlecode.iterm2",
    ]);
  });

  it("keeps every bundle id in one table, each a valid identifier or a family", () => {
    for (const editor of KNOWN_EDITORS) {
      expect(editor.bundleId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*(\.\*)?$/);
    }
  });
});
