import { join } from "node:path";
import type { DetectedApp } from "../../shared/ipc/contract";
import type { AppChoice } from "../../shared/settings";
import { type DetectDeps, detectApps, type KnownApp } from "./detect";
import { type Launch, templateLaunch } from "./template";

export const OPEN = "/usr/bin/open";

/** How an editor opens a file at a line: a program inside its bundle, and its arguments. */
interface LineForm {
  /** Relative to the `.app` bundle. */
  program: string;
  /** `{path}` and `{line}` are substituted. */
  args: readonly string[];
}

interface KnownEditor extends KnownApp {
  /** Absent where the line form is unknown: the file then opens without a line. */
  line?: LineForm;
}

const VSCODE_LINE = (cli: string): LineForm => ({
  program: `Contents/Resources/app/bin/${cli}`,
  args: ["--goto", "{path}:{line}"],
});

/**
 * The editors Treepeek detects, in the order "automatic" picks from. Bundle identifiers and
 * line forms change between versions, so they live here and nowhere else; an editor whose
 * line form is unknown, or whose command-line tool is missing, opens the file without a
 * line.
 */
export const KNOWN_EDITORS: readonly KnownEditor[] = Object.freeze([
  {
    name: "Visual Studio Code",
    bundleId: "com.microsoft.VSCode",
    appNames: ["Visual Studio Code.app"],
    opensAtLine: true,
    line: VSCODE_LINE("code"),
  },
  {
    name: "Cursor",
    bundleId: "com.todesktop.230313mzl4w4u92",
    appNames: ["Cursor.app"],
    opensAtLine: true,
    line: VSCODE_LINE("cursor"),
  },
  {
    name: "Zed",
    bundleId: "dev.zed.Zed",
    appNames: ["Zed.app"],
    opensAtLine: true,
    line: { program: "Contents/MacOS/cli", args: ["{path}:{line}"] },
  },
  {
    name: "Sublime Text",
    bundleId: "com.sublimetext.4",
    appNames: ["Sublime Text.app"],
    opensAtLine: true,
    line: { program: "Contents/SharedSupport/bin/subl", args: ["{path}:{line}"] },
  },
  {
    name: "Sublime Text 3",
    bundleId: "com.sublimetext.3",
    appNames: ["Sublime Text 3.app"],
    opensAtLine: true,
    line: { program: "Contents/SharedSupport/bin/subl", args: ["{path}:{line}"] },
  },
  {
    name: "JetBrains IDEs",
    bundleId: "com.jetbrains.*",
    appNames: [
      "IntelliJ IDEA.app",
      "IntelliJ IDEA CE.app",
      "IntelliJ IDEA Ultimate.app",
      "WebStorm.app",
      "PyCharm.app",
      "PyCharm CE.app",
      "PyCharm Professional Edition.app",
      "GoLand.app",
      "CLion.app",
      "PhpStorm.app",
      "RubyMine.app",
      "Rider.app",
      "RustRover.app",
      "DataGrip.app",
    ],
  },
  {
    name: "Xcode",
    bundleId: "com.apple.dt.Xcode",
    appNames: ["Xcode.app"],
    opensAtLine: true,
    line: { program: "Contents/Developer/usr/bin/xed", args: ["--line", "{line}", "{path}"] },
  },
  {
    name: "TextEdit",
    bundleId: "com.apple.TextEdit",
    appNames: ["TextEdit.app"],
  },
]);

/** Fallback when nothing is detected at all: TextEdit ships with every Mac. */
const TEXT_EDIT = "com.apple.TextEdit";

export function detectEditors(deps: DetectDeps): Promise<DetectedApp[]> {
  return detectApps(KNOWN_EDITORS, deps);
}

function knownEditorFor(bundleId: string): KnownEditor | undefined {
  return KNOWN_EDITORS.find((editor) =>
    editor.bundleId.endsWith(".*")
      ? bundleId.startsWith(editor.bundleId.slice(0, -1))
      : editor.bundleId === bundleId,
  );
}

export interface EditorTarget {
  /** The file (or checkout folder) to open. */
  path: string;
  /** The line to open a file at, when known. */
  line?: number;
}

/**
 * What opening `target` in the editor `setting` names runs. An app opens with
 * `open -b <bundleId> <path>`, or, with a line and a known line form whose tool exists,
 * through that tool (VS Code: `<app>/Contents/Resources/app/bin/code --goto path:line`). A
 * custom command is expanded without a shell. `exists` checks the line tool is there.
 */
export async function editorLaunch(
  setting: AppChoice,
  detected: readonly DetectedApp[],
  target: EditorTarget,
  exists: (path: string) => Promise<boolean>,
): Promise<Launch> {
  if (setting.kind === "custom") {
    return templateLaunch(setting.command, {
      path: target.path,
      ...(target.line === undefined ? {} : { line: target.line }),
    });
  }
  const bundleId = setting.kind === "app" ? setting.bundleId : (detected[0]?.bundleId ?? TEXT_EDIT);
  const app = detected.find((candidate) => candidate.bundleId === bundleId);
  const form = knownEditorFor(bundleId)?.line;
  if (target.line !== undefined && app && form) {
    const program = join(app.path, form.program);
    if (await exists(program)) {
      const line = String(target.line);
      return {
        command: program,
        args: form.args.map((arg) =>
          arg.replaceAll("{path}", target.path).replaceAll("{line}", line),
        ),
      };
    }
  }
  return { command: OPEN, args: ["-b", bundleId, target.path] };
}
