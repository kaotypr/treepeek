import { realpath, stat } from "node:fs/promises";
import type { DetectedApp } from "../../shared/ipc/contract";
import { err, ok, type Result } from "../../shared/ipc/result";
import type { Logger } from "../../shared/log";
import type { Settings } from "../../shared/settings";
import type { DetectDeps } from "./detect";
import { detectEditors, editorLaunch } from "./editors";
import type { Launcher } from "./launcher";
import { detectTerminals, terminalLaunch } from "./terminals";

export interface Integrations {
  editors: DetectedApp[];
  terminals: DetectedApp[];
}

export interface OpenInDeps {
  /**
   * The core service's path rule for main (`paths.validate`): `true` per path only when
   * some window's scan holds it. Anything else is refused with `notInScan`.
   */
  validate: (paths: readonly string[]) => Promise<boolean[]>;
  launcher: Launcher;
  settings: () => Settings;
  detect: DetectDeps;
  /** Whether a path is a folder, after symlinks. Default: the file system. */
  isFolder?: (path: string) => Promise<boolean>;
  log: Logger;
}

const NOT_IN_SCAN = "Treepeek opens only files and folders of the checkouts it scanned.";

async function isFolderOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(await realpath(path))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * "Open in…" and the clipboard (user-interface design, "Open in…"). Main runs these, and
 * only for local paths the core service confirms are in a scan; nothing here goes through
 * a shell or `shell.openExternal`.
 */
export class OpenIn {
  readonly #deps: OpenInDeps;
  #integrations: Promise<Integrations> | null = null;

  constructor(deps: OpenInDeps) {
    this.#deps = deps;
  }

  /** The installed editors and terminals, detected once per session unless `refresh`. */
  integrations(refresh = false): Promise<Integrations> {
    if (refresh || this.#integrations === null) {
      const detect = this.#deps.detect;
      this.#integrations = Promise.all([detectEditors(detect), detectTerminals(detect)]).then(
        ([editors, terminals]) => ({ editors, terminals }),
      );
    }
    return this.#integrations;
  }

  /** Reveal in Finder: the checkout folder (or file) selected in its parent's window. */
  async finder(path: string): Promise<Result<Record<string, never>>> {
    if (!(await this.#inScan(path))) return err("notInScan", NOT_IN_SCAN);
    this.#deps.launcher.reveal(path);
    return ok({});
  }

  /** Opens a file (at `line` where the editor can) or a checkout folder in the editor. */
  async editor(path: string, line?: number): Promise<Result<Record<string, never>>> {
    if (!(await this.#inScan(path))) return err("notInScan", NOT_IN_SCAN);
    const { editors } = await this.integrations();
    const launch = await editorLaunch(
      this.#deps.settings().editor,
      editors,
      { path, ...(line === undefined ? {} : { line }) },
      this.#deps.detect.exists,
    );
    return this.#run(launch, "The editor could not be opened.");
  }

  /** Opens the terminal at a checkout folder. */
  async terminal(path: string): Promise<Result<Record<string, never>>> {
    if (!(await this.#inScan(path))) return err("notInScan", NOT_IN_SCAN);
    // A terminal handed a file runs it, so only a folder is ever passed on.
    if (!(await (this.#deps.isFolder ?? isFolderOnDisk)(path))) {
      return err("invalidRequest", "A terminal opens only at a folder.");
    }
    return this.#run(
      terminalLaunch(this.#deps.settings().terminal, path),
      "The terminal could not be opened.",
    );
  }

  copy(text: string): Result<Record<string, never>> {
    this.#deps.launcher.copy(text);
    return ok({});
  }

  async #inScan(path: string): Promise<boolean> {
    const [valid] = await this.#deps.validate([path]);
    if (valid !== true) this.#deps.log.warn("refused to open a path outside every scan", { path });
    return valid === true;
  }

  async #run(
    launch: { command: string; args: string[] },
    message: string,
  ): Promise<Result<Record<string, never>>> {
    try {
      await this.#deps.launcher.run(launch);
      return ok({});
    } catch (error) {
      this.#deps.log.warn("could not start a program", { command: launch.command, error });
      return err("internal", message, {
        command: launch.command,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
