import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";

/**
 * Launches Treepeek for end-to-end tests and connects over the Chrome DevTools Protocol.
 *
 * Playwright's `_electron.launch` drives the main process through `--inspect`, which the
 * packaged app's `EnableNodeCliInspectArguments` fuse turns off. Both targets therefore
 * use `--remote-debugging-port` (a Chromium switch no fuse touches) and test the app the
 * way the renderer sees it.
 *
 * `APP_TARGET=dev` (default) runs the built `out/` with the Electron binary;
 * `APP_TARGET=packaged` runs `dist/mac-arm64/Treepeek.app` from `bun run package`.
 * `launchApp({ build: "lab" })` runs the lab build in `out-lab/` (`bun run build:lab`),
 * which holds the development pages; it exists only for the dev target.
 */

const root = resolve(import.meta.dirname, "../../..");
export const target = process.env.APP_TARGET === "packaged" ? "packaged" : "dev";

/**
 * `TREEPEEK_E2E_SHOW=1` shows the app's windows normally, to watch a run. Otherwise the app
 * runs in background mode (`TREEPEEK_E2E_BACKGROUND`, see `src/main/windows.ts`), so test
 * runs never pop windows up or take focus.
 */
export const showWindows = process.env.TREEPEEK_E2E_SHOW === "1";

/** The lab build's folder: `bun run build:lab` writes it, tests add fixtures to it. */
export const LAB_OUT_DIR = join(root, "out-lab");

function command(build: "app" | "lab"): { executable: string; args: string[] } {
  if (build === "lab") {
    const entry = join(LAB_OUT_DIR, "main/index.js");
    if (!existsSync(entry)) throw new Error("Run `bun run build:lab` before the diff lab tests");
    const executable = join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    return { executable, args: [entry] };
  }
  if (target === "packaged") {
    const executable = join(root, "dist/mac-arm64/Treepeek.app/Contents/MacOS/Treepeek");
    if (!existsSync(executable))
      throw new Error("Run `bun run package` before APP_TARGET=packaged");
    return { executable, args: [] };
  }
  if (!existsSync(join(root, "out/main/index.js"))) {
    throw new Error("Run `bun run build` before the end-to-end tests");
  }
  const executable = join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  return { executable, args: [root] };
}

export interface LaunchOptions {
  /** Reuse a profile (to test a restart); a fresh temporary one otherwise. */
  userDataDir?: string;
  /** Written to `settings.json` before launch. */
  settings?: Record<string, unknown>;
  /** `lab` runs the lab build (`out-lab/`) instead of the app. Default `app`. */
  build?: "app" | "lab";
  /**
   * Folders to open at launch through the test-only `TREEPEEK_E2E_OPEN` hook (honoured only
   * with `NODE_ENV=test`), instead of the native folder dialog.
   */
  open?: readonly string[];
  /**
   * Test-only hooks for the app (`src/main/test-hooks.ts`), such as
   * `TREEPEEK_E2E_LAUNCH_LOG` or `TREEPEEK_E2E_DIALOG`. Setting any of them runs the app
   * with `NODE_ENV=test`, the only way they are honoured.
   */
  env?: Readonly<Record<string, string>>;
}

export interface App {
  browser: Browser;
  /** The first Treepeek window that appeared. */
  page: Page;
  /** Every Treepeek window open now. */
  pages(): Page[];
  /** Waits for a Treepeek window whose page satisfies `match`. */
  waitForPage(match: (page: Page) => Promise<boolean>, what: string): Promise<Page>;
  process: ChildProcess;
  userDataDir: string;
  /** Contents of `userData/logs/<name>.log`. */
  log(name: "main" | "core"): string;
  close(): Promise<void>;
}

export function newUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "treepeek-e2e-"));
}

export async function launchApp(options: LaunchOptions = {}): Promise<App> {
  const userDataDir = options.userDataDir ?? newUserDataDir();
  if (options.settings) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(options.settings));
  }
  const port = await freePort();
  const child = spawnApp(
    userDataDir,
    [`--remote-debugging-port=${port}`],
    options.build,
    options.open,
    options.env,
  );
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      return response?.ok ?? false;
    },
    20_000,
    "the DevTools endpoint",
  );

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page: Page | undefined;
  await waitFor(
    () => {
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith("app://treepeek/"));
      return Promise.resolve(page !== undefined);
    },
    20_000,
    "the Treepeek window",
  );

  const pages = () =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((candidate) => candidate.url().startsWith("app://treepeek/"));
  return {
    browser,
    page: page as Page,
    pages,
    waitForPage: async (match, what) => {
      let found: Page | undefined;
      await waitFor(
        async () => {
          for (const candidate of pages()) {
            if (await match(candidate).catch(() => false)) {
              found = candidate;
              return true;
            }
          }
          return false;
        },
        20_000,
        what,
      );
      return found as Page;
    },
    process: child,
    userDataDir,
    log: (name) => {
      const file = join(userDataDir, "logs", `${name}.log`);
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
    close: async () => {
      await browser.close().catch(() => undefined);
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([exited, sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

/** Starts another instance on the same profile, as a second double-click would. */
export function spawnApp(
  userDataDir: string,
  extraArgs: string[] = [],
  build: "app" | "lab" = "app",
  open: readonly string[] = [],
  hooks: Readonly<Record<string, string>> = {},
): ChildProcess {
  const { executable, args } = command(build);
  const env: NodeJS.ProcessEnv = { ...process.env, TREEPEEK_USER_DATA_DIR: userDataDir };
  if (open.length > 0) {
    env.NODE_ENV = "test";
    env.TREEPEEK_E2E_OPEN = open.join(delimiter);
  }
  if (Object.keys(hooks).length > 0) {
    env.NODE_ENV = "test";
    Object.assign(env, hooks);
  }
  // Windows stay transparent, unfocused and click-through unless the run asks to watch.
  if (!showWindows) env.TREEPEEK_E2E_BACKGROUND = "1";
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  return spawn(executable, [...args, ...extraArgs], { env, stdio: "ignore" });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** Launches the app with `folder` open in its own window (no folder dialog). */
export async function launchWithFolder(
  folder: string | readonly string[],
  options: Omit<LaunchOptions, "open"> = {},
): Promise<App> {
  return launchApp({ ...options, open: typeof folder === "string" ? [folder] : folder });
}

/** What a window shows, read from its UI. */
export async function windowKind(
  page: Page,
): Promise<"welcome" | "scan" | "settings" | "about" | "unknown"> {
  return page.evaluate(() =>
    document.querySelector('[data-testid="welcome"]')
      ? "welcome"
      : document.querySelector('[data-testid="scan-window"]')
        ? "scan"
        : document.querySelector('[data-testid="settings-window"]')
          ? "settings"
          : document.querySelector('[data-testid="about"]')
            ? "about"
            : "unknown",
  );
}

/** One action "Open in…", the clipboard or Open Logs Folder recorded (`TREEPEEK_E2E_LAUNCH_LOG`). */
export type LaunchRecord =
  | { action: "run"; command: string; args: string[] }
  | { action: "reveal"; path: string }
  | { action: "openFolder"; path: string }
  | { action: "copy"; text: string };

/** A fresh file for the app to record launches in; `read()` answers what it recorded. */
export function launchLog(): { file: string; read(): LaunchRecord[] } {
  const file = join(mkdtempSync(join(tmpdir(), "treepeek-launch-")), "launches.jsonl");
  return {
    file,
    read: () =>
      existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LaunchRecord)
        : [],
  };
}
