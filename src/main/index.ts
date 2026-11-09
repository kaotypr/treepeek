import { delimiter, join } from "node:path";
import { app, type BrowserWindow, Menu, nativeTheme, session } from "electron";
import { err, mainCalls, mainEvents, ok } from "../shared/ipc";
import { WINDOW_BACKGROUND } from "../shared/theme";
import { AppWindows } from "./app-windows";
import { CoreSupervisor } from "./core-supervisor";
import { FolderOpener, PendingFolders, RecentFolders, resolveFolder } from "./folders";
import { emitToWindow, handleMain, installMainIpc } from "./ipc";
import { createLogger } from "./log";
import { buildMenu } from "./menu";
import { APP_URL, isAppUrl, registerAppProtocol, registerAppSchemePrivileged } from "./protocol";
import { SettingsStore } from "./settings";
import { loadLoginEnv } from "./shell-env";
import { applyAppearance, onThemeChanged, resolvedTheme, themeState } from "./theme";
import {
  createWindow,
  focusWindow,
  guardWebContents,
  inBackgroundMode,
  WELCOME_WINDOW_SIZE,
} from "./windows";

// Tests point the app at a throwaway profile. Must happen before anything reads userData,
// including the single-instance lock, which is scoped to it.
const userDataOverride = process.env.TREEPEEK_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", userDataOverride);

// End-to-end runs: no Dock icon, and the app never becomes the active one, so it cannot
// take keyboard focus from whatever the person running the tests is doing.
if (inBackgroundMode() && process.platform === "darwin") app.setActivationPolicy("accessory");

/**
 * Test-only: folders to open at launch instead of restoring windows, so end-to-end tests
 * can skip the native folder dialog. Honoured only when `NODE_ENV` is `test`.
 */
const E2E_OPEN_ENV = "TREEPEEK_E2E_OPEN";

registerAppSchemePrivileged();

const log = createLogger("main");
const outDir = join(import.meta.dirname, "..");
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

// A folder dropped on the Dock icon can arrive before the app is ready (when the drop is
// what launched it), so the listener goes in now and the folders wait for the opener.
const droppedFolders = new PendingFolders();
app.on("open-file", (event, path) => {
  event.preventDefault();
  droppedFolders.push(path);
});

if (!app.requestSingleInstanceLock()) {
  log.info("another instance is running; handing over to it");
  app.quit();
} else {
  void app.whenReady().then(start);
}

function start(): void {
  log.info("starting", {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
  });

  const settings = new SettingsStore(app.getPath("userData"), log.child("settings"));
  applyAppearance(settings.get().appearance);

  // Read once, while the first window loads; the core service waits for it to find git.
  const loginEnv = loadLoginEnv({ log: log.child("shell-env") });

  // Nothing in the renderer needs a browser permission; native actions go through main.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("web-contents-created", (_event, contents) => guardWebContents(contents));

  registerAppProtocol(join(outDir, "renderer"));

  const supervisor = new CoreSupervisor({
    entry: join(outDir, "core", "index.js"),
    userDataDir: app.getPath("userData"),
    log: log.child("core-supervisor"),
    gitPathOverride: settings.get().gitPath,
  });

  /** Whether each scan window currently sits on vibrancy ("Reduce transparency" is off). */
  const vibrancy = new Map<BrowserWindow, boolean>();
  // Background-mode windows are invisible, so vibrancy would only make the page's contrast
  // depend on a material nobody sees; test runs check the opaque surfaces instead.
  const wantsVibrancy = () => !inBackgroundMode() && !nativeTheme.prefersReducedTransparency;

  const windows: AppWindows = new AppWindows({
    settings,
    log: log.child("windows"),
    create: (spec) => {
      const withVibrancy = spec.scanRoot !== null && wantsVibrancy();
      const win = createWindow({
        theme: resolvedTheme(),
        preload: join(outDir, "preload", "index.cjs"),
        url: devServerUrl ?? APP_URL,
        title: spec.title,
        bounds: spec.bounds,
        vibrancy: withVibrancy,
        ...(spec.scanRoot === null ? { size: WELCOME_WINDOW_SIZE } : {}),
      });
      if (spec.scanRoot !== null) {
        vibrancy.set(win, withVibrancy);
        win.setRepresentedFilename(spec.scanRoot);
        win.once("closed", () => vibrancy.delete(win));
      }
      if (inBackgroundMode()) {
        // The page cannot see OS focus (DevTools emulates it), so main reports what it sees.
        win.once("show", () =>
          log.info("window shown in background mode", {
            focused: win.isFocused(),
            opacity: win.getOpacity(),
            scanRoot: spec.scanRoot,
          }),
        );
      }
      win.webContents.on("did-finish-load", () => {
        emitToWindow(win, mainEvents["theme.changed"], themeState(), log);
        emitToWindow(win, mainEvents["window.scanRoot"], windowState(win), log);
        const state = supervisor.state;
        if (state) emitToWindow(win, mainEvents["core.state"], { state }, log);
        const git = supervisor.gitState;
        if (git) emitToWindow(win, mainEvents["git.state"], git, log);
      });
      supervisor.attach(win);
      return win;
    },
  });

  function windowState(win: BrowserWindow) {
    return {
      scanRoot: windows.scanRootOf(win),
      ui: windows.uiOf(win),
      vibrancy: vibrancy.get(win) ?? false,
    };
  }

  const recent = new RecentFolders(settings);
  const opener = new FolderOpener({
    recent,
    openScanWindow: (scanRoot) => windows.openScanWindow(scanRoot),
    log: log.child("folders"),
  });

  const refreshMenu = () =>
    Menu.setApplicationMenu(
      buildMenu({
        recentFolders: recent.list(),
        openFolder: (win) => void opener.choose(win && windows.has(win) ? win : null),
        openRecent: (path) => void opener.openRecent(path),
        clearRecent: () => recent.clear(),
      }),
    );
  refreshMenu();

  installMainIpc({
    log: log.child("ipc"),
    isTrustedSender: (event) => {
      const frame = event.senderFrame;
      if (!frame || frame.parent !== null) return false;
      const win = windows.fromContentsId(event.sender.id);
      if (!win) return false;
      if (isAppUrl(frame.url)) return true;
      return devServerUrl !== undefined && frame.url.startsWith(devServerUrl);
    },
  });

  handleMain(mainCalls["app.ping"], () => ok({ process: "main", at: Date.now() }));
  handleMain(mainCalls["settings.get"], () => ok(settings.get()));
  handleMain(mainCalls["settings.set"], (_ctx, patch) => ok(settings.set(patch)));
  handleMain(mainCalls["folder.choose"], async (ctx) => {
    const path = await opener.choose(windows.fromContentsId(ctx.windowId));
    return ok(path === null ? null : { path });
  });
  handleMain(mainCalls["folder.openRecent"], async (_ctx, request) => {
    if (!recent.has(request.path)) {
      return err("invalidRequest", "That folder is not in the recent folders.");
    }
    const opened = await opener.openRecent(request.path);
    return opened ? ok({}) : err("invalidRequest", "That folder no longer exists.");
  });
  handleMain(mainCalls["folder.open"], async (_ctx, request) => {
    const opened = await opener.open(request.path);
    return opened ? ok({}) : err("invalidRequest", "Only an existing folder can be opened.");
  });
  handleMain(mainCalls["window.state"], (ctx, request) => {
    const win = windows.fromContentsId(ctx.windowId);
    if (!win || !windows.setUi(win, request.ui)) {
      return err("invalidRequest", "Only a scan window has a layout to save.");
    }
    return ok({});
  });

  settings.onChange((next, previous) => {
    if (next.appearance !== previous.appearance) applyAppearance(next.appearance);
    if (next.gitPath !== previous.gitPath) supervisor.setGitPathOverride(next.gitPath);
    // Every settings write parses a fresh list, so compare contents, not identity.
    if (next.recentFolders.join("\0") !== previous.recentFolders.join("\0")) refreshMenu();
  });

  onThemeChanged((state) => {
    for (const win of windows.all()) {
      const had = vibrancy.get(win);
      if (had !== undefined && had !== wantsVibrancy()) {
        // "Reduce transparency" changed: swap the material and tell the page.
        vibrancy.set(win, wantsVibrancy());
        win.setVibrancy(wantsVibrancy() ? "sidebar" : null);
        emitToWindow(win, mainEvents["window.scanRoot"], windowState(win), log);
      }
      win.setBackgroundColor(vibrancy.get(win) ? "#00000000" : WINDOW_BACKGROUND[state.resolved]);
      emitToWindow(win, mainEvents["theme.changed"], state, log);
    }
  });

  supervisor.onState((state) => {
    for (const win of windows.all()) emitToWindow(win, mainEvents["core.state"], { state }, log);
  });
  supervisor.onGitState((state) => {
    for (const win of windows.all()) emitToWindow(win, mainEvents["git.state"], state, log);
  });

  let quitting = false;
  void loginEnv.then((env) => {
    if (quitting) return;
    supervisor.setLoginPath(env.PATH ?? null);
    supervisor.start();
  });

  void openInitialWindows(windows, opener).then(() => {
    droppedFolders.drainInto((path) => void opener.open(path));
  });

  app.on("second-instance", () => {
    const win = windows.all()[0] ?? windows.openWelcomeWindow();
    focusWindow(win);
    log.info("second instance launched; focused the existing window");
  });

  app.on("activate", () => {
    if (windows.all().length === 0) windows.openWelcomeWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    windows.beginQuit();
    supervisor.stop();
  });
}

/**
 * The test hook's folders, the windows saved at the last quit, or the welcome window. A
 * Dock drop that launched the app opens on top of whichever of these applies.
 */
async function openInitialWindows(windows: AppWindows, opener: FolderOpener): Promise<void> {
  const testFolders = process.env.NODE_ENV === "test" ? process.env[E2E_OPEN_ENV] : undefined;
  if (testFolders) {
    let opened = 0;
    for (const path of testFolders.split(delimiter).filter(Boolean)) {
      if (await opener.open(path)) opened += 1;
    }
    if (opened === 0) windows.openWelcomeWindow();
    return;
  }
  const restored = await windows.restore(resolveFolder);
  if (restored === 0 && windows.all().length === 0) windows.openWelcomeWindow();
}
