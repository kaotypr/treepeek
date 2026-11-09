import { join } from "node:path";
import { app, BrowserWindow, Menu, session } from "electron";
import { mainCalls, mainEvents, ok } from "../shared/ipc";
import { WINDOW_BACKGROUND } from "../shared/theme";
import { CoreSupervisor } from "./core-supervisor";
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
  WindowRegistry,
} from "./windows";

// Tests point the app at a throwaway profile. Must happen before anything reads userData,
// including the single-instance lock, which is scoped to it.
const userDataOverride = process.env.TREEPEEK_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", userDataOverride);

// End-to-end runs: no Dock icon, and the app never becomes the active one, so it cannot
// take keyboard focus from whatever the person running the tests is doing.
if (inBackgroundMode() && process.platform === "darwin") app.setActivationPolicy("accessory");

registerAppSchemePrivileged();

const log = createLogger("main");
const outDir = join(import.meta.dirname, "..");
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

/** Key of the window that has no scan root yet (the placeholder screen). */
const HOME = "";

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
  Menu.setApplicationMenu(buildMenu());

  const supervisor = new CoreSupervisor({
    entry: join(outDir, "core", "index.js"),
    userDataDir: app.getPath("userData"),
    log: log.child("core-supervisor"),
    gitPathOverride: settings.get().gitPath,
  });

  const registry = new WindowRegistry(() => {
    const win = createWindow({
      theme: resolvedTheme(),
      preload: join(outDir, "preload", "index.cjs"),
      url: devServerUrl ?? APP_URL,
    });
    if (inBackgroundMode()) {
      // The page cannot see OS focus (DevTools emulates it), so main reports what it sees.
      win.once("show", () =>
        log.info("window shown in background mode", {
          focused: win.isFocused(),
          opacity: win.getOpacity(),
        }),
      );
    }
    win.webContents.on("did-finish-load", () => {
      emitToWindow(win, mainEvents["theme.changed"], themeState(), log);
      const state = supervisor.state;
      if (state) emitToWindow(win, mainEvents["core.state"], { state }, log);
      const git = supervisor.gitState;
      if (git) emitToWindow(win, mainEvents["git.state"], git, log);
    });
    supervisor.attach(win);
    return win;
  });

  installMainIpc({
    log: log.child("ipc"),
    isTrustedSender: (event) => {
      const frame = event.senderFrame;
      if (!frame || frame.parent !== null) return false;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !registry.has(win)) return false;
      if (isAppUrl(frame.url)) return true;
      return devServerUrl !== undefined && frame.url.startsWith(devServerUrl);
    },
  });

  handleMain(mainCalls["app.ping"], () => ok({ process: "main", at: Date.now() }));
  handleMain(mainCalls["settings.get"], () => ok(settings.get()));
  handleMain(mainCalls["settings.set"], (_ctx, patch) => ok(settings.set(patch)));

  settings.onChange((next, previous) => {
    if (next.appearance !== previous.appearance) applyAppearance(next.appearance);
    if (next.gitPath !== previous.gitPath) supervisor.setGitPathOverride(next.gitPath);
  });

  onThemeChanged((state) => {
    for (const win of registry.all()) {
      win.setBackgroundColor(WINDOW_BACKGROUND[state.resolved]);
      emitToWindow(win, mainEvents["theme.changed"], state, log);
    }
  });

  supervisor.onState((state) => {
    for (const win of registry.all()) emitToWindow(win, mainEvents["core.state"], { state }, log);
  });
  supervisor.onGitState((state) => {
    for (const win of registry.all()) emitToWindow(win, mainEvents["git.state"], state, log);
  });

  let quitting = false;
  void loginEnv.then((env) => {
    if (quitting) return;
    supervisor.setLoginPath(env.PATH ?? null);
    supervisor.start();
  });

  registry.openOrFocus(HOME);

  app.on("second-instance", () => {
    const win = registry.all()[0] ?? registry.openOrFocus(HOME);
    focusWindow(win);
    log.info("second instance launched; focused the existing window");
  });

  app.on("activate", () => {
    if (registry.all().length === 0) registry.openOrFocus(HOME);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    supervisor.stop();
  });
}
