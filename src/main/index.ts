import { delimiter, join } from "node:path";
import { app, BrowserWindow, Menu, nativeTheme, session, shell } from "electron";
import type { CheckableCommandId, CommandId } from "../shared/commands";
import { err, mainCalls, mainEvents, ok, type WindowKind } from "../shared/ipc";
import type { Settings } from "../shared/settings";
import { WINDOW_BACKGROUND } from "../shared/theme";
import { ABOUT_WINDOW_SIZE, AboutWindow, COPYRIGHT, LICENSE, readNotices } from "./about";
import { AppWindows } from "./app-windows";
import { CoreSupervisor } from "./core-supervisor";
import { openDialog } from "./dialogs";
import { FolderOpener, PendingFolders, RecentFolders, resolveFolder } from "./folders";
import { emitToWindow, handleMain, installMainIpc } from "./ipc";
import { createLogger, logsDir } from "./log";
import {
  applyCommandState,
  buildMenu,
  type CommandState,
  checkAppearance,
  HELP_LINKS,
} from "./menu";
import { systemDetectDeps } from "./open-in/detect";
import { OpenIn } from "./open-in/index";
import { type Launcher, recordingLauncher, systemLauncher } from "./open-in/launcher";
import { APP_URL, isAppUrl, registerAppProtocol, registerAppSchemePrivileged } from "./protocol";
import { SettingsStore } from "./settings";
import { SETTINGS_WINDOW_SIZE, SettingsWindow } from "./settings-window";
import { loadLoginEnv } from "./shell-env";
import { testLaunchLog, testMenuClicks } from "./test-hooks";
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

  // Read once, while the first window loads; the core service waits for it to find git,
  // and "Open in…" starts programs with it, so `PATH` finds `code` and friends.
  let loginEnvironment: NodeJS.ProcessEnv = process.env;
  const loginEnv = loadLoginEnv({ log: log.child("shell-env") });
  void loginEnv.then((env) => {
    loginEnvironment = env;
  });

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
  /** Windows whose page has loaded at least once, so they can take events. */
  const loaded = new WeakSet<BrowserWindow>();

  /** Sends what every page needs once it has loaded: theme, what it shows, git, settings. */
  const greet = (win: BrowserWindow) => {
    loaded.add(win);
    emitToWindow(win, mainEvents["theme.changed"], themeState(), log);
    emitToWindow(win, mainEvents["window.scanRoot"], windowState(win), log);
    const state = supervisor.state;
    if (state) emitToWindow(win, mainEvents["core.state"], { state }, log);
    const git = supervisor.gitState;
    if (git) emitToWindow(win, mainEvents["git.state"], git, log);
    emitToWindow(win, mainEvents["settings.changed"], settings.get(), log);
  };

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
      win.webContents.on("did-finish-load", () => greet(win));
      supervisor.attach(win);
      return win;
    },
  });

  /**
   * A Settings or About window: no scan. Settings gets a core service port for the review
   * store (its usage and "Clear review data…"), which only the core service owns.
   */
  const createUtilityWindow = (
    title: string,
    size: { width: number; height: number; minWidth: number; minHeight: number },
    onLoad?: (win: BrowserWindow) => void,
    options: { core?: boolean } = {},
  ) => {
    const win = createWindow({
      theme: resolvedTheme(),
      preload: join(outDir, "preload", "index.cjs"),
      url: devServerUrl ?? APP_URL,
      title,
      size,
    });
    win.webContents.on("did-finish-load", () => {
      greet(win);
      onLoad?.(win);
    });
    if (options.core) supervisor.attach(win);
    return win;
  };

  let pendingSection: Parameters<SettingsWindow["open"]>[0] | null = null;
  const settingsWindow = new SettingsWindow({
    log: log.child("settings-window"),
    create: () =>
      createUtilityWindow(
        "Settings",
        SETTINGS_WINDOW_SIZE,
        (win) => {
          if (pendingSection) {
            emitToWindow(win, mainEvents["settings.section"], { section: pendingSection }, log);
            pendingSection = null;
          }
        },
        { core: true },
      ),
    showSection: (win, section) => {
      // A page still loading cannot take events yet; it gets the section once it has loaded.
      if (!loaded.has(win)) pendingSection = section;
      else emitToWindow(win, mainEvents["settings.section"], { section }, log);
    },
  });
  const aboutWindow = new AboutWindow({
    log: log.child("about"),
    create: () => createUtilityWindow(`About ${app.name}`, ABOUT_WINDOW_SIZE),
  });

  function kindOf(win: BrowserWindow): WindowKind {
    if (settingsWindow.get() === win) return "settings";
    if (aboutWindow.get() === win) return "about";
    return windows.scanRootOf(win) === null ? "welcome" : "scan";
  }

  function windowState(win: BrowserWindow) {
    return {
      kind: kindOf(win),
      scanRoot: windows.scanRootOf(win),
      ui: windows.uiOf(win),
      vibrancy: vibrancy.get(win) ?? false,
    };
  }

  /** Every window of the app: scan windows, the welcome window, Settings and About. */
  const everyWindow = (): BrowserWindow[] =>
    [...windows.all(), settingsWindow.get(), aboutWindow.get()].filter(
      (win): win is BrowserWindow => win !== null,
    );

  const fromContentsId = (id: number): BrowserWindow | null =>
    windows.fromContentsId(id) ??
    settingsWindow.fromContentsId(id) ??
    aboutWindow.fromContentsId(id);

  const dialog = openDialog();
  const recent = new RecentFolders(settings);
  const opener = new FolderOpener({
    recent,
    dialog,
    openScanWindow: (scanRoot) => windows.openScanWindow(scanRoot),
    log: log.child("folders"),
  });

  // "Open in…": end-to-end runs record what would run instead of opening apps.
  const launchLog = testLaunchLog();
  const launcher: Launcher = launchLog
    ? recordingLauncher(launchLog)
    : systemLauncher({ env: () => loginEnvironment, log: log.child("launcher") });
  const openIn = new OpenIn({
    validate: (paths) => supervisor.validatePaths(paths),
    launcher,
    settings: () => settings.get(),
    detect: systemDetectDeps(),
    log: log.child("open-in"),
  });

  // The menu: command items follow the focused scan window's report (`window.commands`).
  const commandStates = new Map<number, CommandState>();
  const syncMenu = () => {
    const win = BrowserWindow.getFocusedWindow();
    const state =
      win && !win.isDestroyed() && windows.scanWindows().includes(win)
        ? (commandStates.get(win.webContents.id) ?? null)
        : null;
    applyCommandState(Menu.getApplicationMenu(), state);
  };
  const runCommand = (win: BrowserWindow | null, id: CommandId) => {
    if (!win || !windows.scanWindows().includes(win)) return;
    emitToWindow(win, mainEvents["command.run"], { id }, log);
  };

  const refreshMenu = () => {
    Menu.setApplicationMenu(
      buildMenu({
        recentFolders: recent.list(),
        openFolder: (win) => void opener.choose(win && windows.has(win) ? win : null),
        openRecent: (path) => void opener.openRecent(path),
        clearRecent: () => recent.clear(),
        appearance: settings.get().appearance,
        setAppearance: (appearance) => settings.set({ appearance }),
        openSettings: () => settingsWindow.open(),
        openAbout: () => aboutWindow.open(),
        openHelpLink: (link) => void shell.openExternal(HELP_LINKS[link]),
        runCommand,
        undo: (win) => {
          if (!win || win.isDestroyed()) return;
          const state = commandStates.get(win.webContents.id);
          if (windows.scanWindows().includes(win) && state?.enabled.has("review.undo")) {
            runCommand(win, "review.undo");
          } else {
            win.webContents.undo();
          }
        },
      }),
    );
    syncMenu();
  };
  refreshMenu();
  app.on("browser-window-focus", syncMenu);
  app.on("browser-window-blur", syncMenu);

  // End-to-end runs: click menu items the way a person would (`test-hooks.ts`).
  let pendingMenuClicks = testMenuClicks();
  const clickTestMenuItems = (win: BrowserWindow | null) => {
    const ids = pendingMenuClicks;
    if (!ids) return;
    pendingMenuClicks = null;
    const menu = Menu.getApplicationMenu();
    applyCommandState(menu, win ? (commandStates.get(win.webContents.id) ?? null) : null);
    for (const id of ids) {
      const item = menu?.getMenuItemById(id);
      if (!item?.enabled) {
        log.info("test menu click skipped", { id, reason: item ? "disabled" : "unknown" });
        continue;
      }
      log.info("test menu click", { id });
      item.click(undefined, win ?? undefined, win?.webContents);
    }
    syncMenu();
  };

  installMainIpc({
    log: log.child("ipc"),
    isTrustedSender: (event) => {
      const frame = event.senderFrame;
      if (!frame || frame.parent !== null) return false;
      const win = fromContentsId(event.sender.id);
      if (!win) return false;
      if (isAppUrl(frame.url)) return true;
      return devServerUrl !== undefined && frame.url.startsWith(devServerUrl);
    },
  });

  handleMain(mainCalls["app.ping"], () => ok({ process: "main", at: Date.now() }));
  handleMain(mainCalls["settings.get"], () => ok(settings.get()));
  handleMain(mainCalls["settings.set"], (ctx, patch) => {
    // Editor and terminal name programs Treepeek runs, so only the Settings window, which
    // never shows repository content, may change them.
    const namesPrograms = patch.editor !== undefined || patch.terminal !== undefined;
    if (namesPrograms && settingsWindow.fromContentsId(ctx.windowId) === null) {
      return err("invalidRequest", "The editor and terminal are set in the Settings window.");
    }
    return ok(settings.set(patch));
  });
  handleMain(mainCalls["settings.open"], (_ctx, request) => {
    settingsWindow.open(request.section);
    return ok({});
  });
  handleMain(mainCalls["folder.choose"], async (ctx, request) => {
    const caller = windows.fromContentsId(ctx.windowId);
    const before = caller ? windows.scanRootOf(caller) : null;
    const path = await opener.choose(caller);
    // "Choose another folder" on a scan window that could not scan its own: once another
    // folder has opened, that window has nothing left to show.
    if (path !== null && request.replace && caller && before !== null && before !== path) {
      caller.close();
    }
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
  handleMain(mainCalls["window.commands"], (ctx, request) => {
    const win = windows.fromContentsId(ctx.windowId);
    if (!win || !windows.scanWindows().includes(win)) {
      return err("invalidRequest", "Only a scan window has commands.");
    }
    const id = win.webContents.id;
    if (!commandStates.has(id)) win.once("closed", () => commandStates.delete(id));
    commandStates.set(id, {
      enabled: new Set<CommandId>(request.enabled),
      checked: new Set<CheckableCommandId>(request.checked),
    });
    syncMenu();
    if (pendingMenuClicks && windows.scanWindows()[0] === win) {
      // After this report is answered, so the page is ready for the commands.
      setTimeout(() => clickTestMenuItems(win), 0);
    }
    return ok({});
  });

  handleMain(mainCalls["openIn.finder"], (_ctx, request) => openIn.finder(request.path));
  handleMain(mainCalls["openIn.editor"], (_ctx, request) =>
    openIn.editor(request.path, request.line),
  );
  handleMain(mainCalls["openIn.terminal"], (_ctx, request) => openIn.terminal(request.path));
  handleMain(mainCalls["clipboard.copy"], (_ctx, request) => openIn.copy(request.text));
  handleMain(mainCalls["integrations.detect"], async (_ctx, request) =>
    ok(await openIn.integrations(request.refresh === true)),
  );

  handleMain(mainCalls["git.choose"], async (ctx) => {
    const path = await dialog(fromContentsId(ctx.windowId), {
      title: "Choose Git",
      buttonLabel: "Use This Git",
      message: "Choose the git program Treepeek should run.",
      properties: ["openFile", "treatPackageAsDirectory", "showHiddenFiles"],
    });
    if (path === null) return ok(null);
    const state = await supervisor.probeGit(path);
    log.info("checked a chosen git", { path, state });
    // Only a usable git becomes the override; otherwise discovery would quietly move on
    // to another git and the person would never learn why theirs was not used.
    if (state.found) settings.set({ gitPath: path });
    return ok({ path, state });
  });
  handleMain(mainCalls["git.detect"], () => {
    supervisor.detectGitAgain();
    return ok({});
  });
  handleMain(mainCalls["logs.open"], async () => {
    try {
      await launcher.openFolder(logsDir());
      return ok({});
    } catch (error) {
      log.warn("could not open the logs folder", { error });
      return err("internal", "The logs folder could not be opened.");
    }
  });
  handleMain(mainCalls["about.info"], () =>
    ok({
      name: app.name,
      version: app.getVersion(),
      license: LICENSE,
      copyright: COPYRIGHT,
      ...readNotices({ dirs: [process.resourcesPath, app.getAppPath()] }),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }),
  );

  const broadcastTheme = (state: ReturnType<typeof themeState>) => {
    for (const win of everyWindow()) {
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
  };
  onThemeChanged(broadcastTheme);

  settings.onChange((next: Settings, previous: Settings) => {
    if (next.appearance !== previous.appearance) {
      applyAppearance(next.appearance);
      checkAppearance(Menu.getApplicationMenu(), next.appearance);
      // macOS reports nothing when the resolved theme stays the same (Dark → System on a
      // dark Mac), yet every window must learn the new setting.
      broadcastTheme(themeState());
    }
    if (next.gitPath !== previous.gitPath) supervisor.setGitPathOverride(next.gitPath);
    // Every settings write parses a fresh list, so compare contents, not identity.
    if (next.recentFolders.join("\0") !== previous.recentFolders.join("\0")) refreshMenu();
    for (const win of everyWindow()) {
      if (loaded.has(win)) emitToWindow(win, mainEvents["settings.changed"], next, log);
    }
  });

  supervisor.onState((state) => {
    for (const win of windows.all()) emitToWindow(win, mainEvents["core.state"], { state }, log);
  });
  supervisor.onGitState((state) => {
    for (const win of everyWindow()) emitToWindow(win, mainEvents["git.state"], state, log);
  });

  let quitting = false;
  void loginEnv.then((env) => {
    if (quitting) return;
    supervisor.setLoginPath(env.PATH ?? null);
    supervisor.start();
  });

  void openInitialWindows(windows, opener, settings.get().restoreWindows).then(() => {
    droppedFolders.drainInto((path) => void opener.open(path));
    if (pendingMenuClicks && windows.scanWindows().length === 0) {
      const welcome = windows.all()[0];
      if (!welcome || loaded.has(welcome)) clickTestMenuItems(null);
      else welcome.webContents.once("did-finish-load", () => clickTestMenuItems(null));
    }
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
 * The test hook's folders, the windows saved at the last quit (unless the person turned
 * restoring off), or the welcome window. A Dock drop that launched the app opens on top of
 * whichever of these applies.
 */
async function openInitialWindows(
  windows: AppWindows,
  opener: FolderOpener,
  restoreWindows: boolean,
): Promise<void> {
  const testFolders = process.env.NODE_ENV === "test" ? process.env[E2E_OPEN_ENV] : undefined;
  if (testFolders) {
    let opened = 0;
    for (const path of testFolders.split(delimiter).filter(Boolean)) {
      if (await opener.open(path)) opened += 1;
    }
    if (opened === 0) windows.openWelcomeWindow();
    return;
  }
  const restored = restoreWindows ? await windows.restore(resolveFolder) : 0;
  if (restored === 0 && windows.all().length === 0) windows.openWelcomeWindow();
}
