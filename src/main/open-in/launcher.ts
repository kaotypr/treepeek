import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { clipboard, shell } from "electron";
import type { Logger } from "../../shared/log";
import type { Launch } from "./template";

/**
 * The side effects of "Open in…": starting a program, revealing a path in Finder, opening a
 * folder in Finder, and the clipboard. One seam, so tests (and end-to-end runs, which must
 * not open apps or touch the person's clipboard) record what would happen instead.
 */
export interface Launcher {
  /** Starts a program with arguments, never through a shell. Rejects when it cannot start or fails at once. */
  run(launch: Launch): Promise<void>;
  /** Shows `path` selected in a Finder window. */
  reveal(path: string): void;
  /** Opens a folder in Finder. */
  openFolder(path: string): Promise<void>;
  copy(text: string): void;
}

/** How long a started program may take to fail before it counts as started. */
const SETTLE_MS = 3_000;

export interface SystemLauncherOptions {
  /** The environment programs start with: the login shell's, so `PATH` finds `code` and friends. */
  env: () => NodeJS.ProcessEnv;
  log: Logger;
}

export function systemLauncher(options: SystemLauncherOptions): Launcher {
  return {
    run: (launch) =>
      new Promise((resolve, reject) => {
        options.log.info("starting a program", { command: launch.command, args: launch.args });
        const child = spawn(launch.command, launch.args, {
          env: options.env(),
          detached: true,
          stdio: "ignore",
          shell: false,
        });
        let settled = false;
        const settle = (error: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.unref();
          if (error) reject(error);
          else resolve();
        };
        // `open` reports an unknown app or a failed launch by exiting non-zero at once; an
        // editor's own process keeps running, which counts as started.
        const timer = setTimeout(() => settle(null), SETTLE_MS);
        child.once("error", (error) => settle(error));
        child.once("exit", (code, signal) =>
          settle(
            code === 0
              ? null
              : new Error(
                  `${launch.command} ${code === null ? `stopped (${signal})` : `exited with code ${code}`}`,
                ),
          ),
        );
      }),
    reveal: (path) => shell.showItemInFolder(path),
    openFolder: async (path) => {
      const problem = await shell.openPath(path);
      if (problem) throw new Error(problem);
    },
    copy: (text) => clipboard.writeText(text),
  };
}

/**
 * End-to-end runs only: every action is appended to `file` as one JSON line
 * (`{"action":"run","command":…,"args":[…]}`, `reveal`, `openFolder`, `copy`) and nothing
 * else happens.
 */
export function recordingLauncher(file: string): Launcher {
  const record = (entry: Record<string, unknown>) =>
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return {
    run: async (launch) => record({ action: "run", command: launch.command, args: launch.args }),
    reveal: (path) => record({ action: "reveal", path }),
    openFolder: async (path) => record({ action: "openFolder", path }),
    copy: (text) => record({ action: "copy", text }),
  };
}
