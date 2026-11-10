import { accessSync, constants, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { contrastViolations } from "./support/a11y";
import {
  type App,
  launchApp,
  newUserDataDir,
  showWindows,
  spawnApp,
  target,
  waitFor,
} from "./support/app";

type Probe = { states: Array<[string, number]> };

const LIGHT_BACKGROUND = "rgb(244, 246, 243)";
const DARK_BACKGROUND = "rgb(14, 22, 19)";

/** The git on the test runner's PATH, as an absolute path. */
function gitOnPath(): string {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    try {
      accessSync(join(folder, "git"), constants.X_OK);
      return join(folder, "git");
    } catch {
      // Keep looking.
    }
  }
  throw new Error("The end-to-end tests need git on the PATH");
}

/** The welcome window is up and the core service answers. */
async function waitForReady(page: Page): Promise<void> {
  await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 15_000 });
  await waitFor(
    async () => (await page.evaluate(() => window.treepeek.core.app.ping())).ok,
    15_000,
    "the core service",
  );
}

test.describe(`foundation (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let app: App;

  test.beforeAll(async () => {
    app = await launchApp();
    await waitForReady(app.page);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("opens the welcome window, served from app://, when there is nothing to restore", async () => {
    const { page } = app;
    expect(page.url()).toBe("app://treepeek/index.html");
    await expect(page).toHaveTitle("Treepeek");
    await expect(page.getByRole("heading", { name: "Treepeek" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open Folder/ })).toBeVisible();
  });

  test("test runs keep the window in the background without focus", async () => {
    test.skip(showWindows, "TREEPEEK_E2E_SHOW=1 shows windows normally");
    // Shown to Chromium, so it renders like a real window...
    expect(await app.page.evaluate(() => document.visibilityState)).toBe("visible");
    // ...yet main sees it transparent and unfocused. `document.hasFocus()` cannot tell:
    // Playwright emulates focus for every page it attaches to.
    expect(app.log("main")).toContain(
      'window shown in background mode {"focused":false,"opacity":0,"scanRoot":null}',
    );
  });

  test("window.treepeek is frozen and exposes only contract methods", async () => {
    const shape = await app.page.evaluate(() => {
      const api = window.treepeek as unknown as Record<string, Record<string, object>>;
      const keys = (value: object) => Object.keys(value).sort();
      const before = api.main?.app;
      let assignmentThrew = false;
      try {
        (api.main as Record<string, unknown>).app = { ping: () => "hijacked" };
      } catch {
        assignmentThrew = true;
      }
      (window as unknown as Record<string, unknown>).treepeek = "replaced";
      return {
        frozen: [
          Object.isFrozen(api),
          Object.isFrozen(api.main),
          Object.isFrozen(api.core),
          Object.isFrozen(api.main?.app),
          Object.isFrozen(api.core?.app),
        ],
        top: keys(api),
        main: keys(api.main ?? {}),
        mainApp: keys(api.main?.app ?? {}),
        mainSettings: keys(api.main?.settings ?? {}),
        mainFolder: keys(api.main?.folder ?? {}),
        mainWindow: keys(api.main?.window ?? {}),
        mainOpenIn: keys(api.main?.openIn ?? {}),
        mainGit: keys(api.main?.git ?? {}),
        core: keys(api.core ?? {}),
        coreApp: keys(api.core?.app ?? {}),
        coreRequest: keys(api.core?.request ?? {}),
        coreComparison: keys(api.core?.comparison ?? {}),
        coreDiff: keys(api.core?.diff ?? {}),
        coreReview: keys(api.core?.review ?? {}),
        unchanged: api.main?.app === before && typeof window.treepeek === "object",
        assignmentThrew,
      };
    });
    expect(shape.frozen).toEqual([true, true, true, true, true]);
    expect(shape.top).toEqual(["core", "main", "off", "on"]);
    expect(shape.main).toEqual([
      "about",
      "app",
      "clipboard",
      "folder",
      "git",
      "integrations",
      "logs",
      "openIn",
      "settings",
      "window",
    ]);
    expect(shape.mainApp).toEqual(["ping"]);
    expect(shape.mainSettings).toEqual(["get", "open", "set"]);
    expect(shape.mainFolder).toEqual(["choose", "open", "openRecent"]);
    expect(shape.mainWindow).toEqual(["commands", "state"]);
    expect(shape.mainOpenIn).toEqual(["editor", "finder", "terminal"]);
    expect(shape.mainGit).toEqual(["choose", "detect"]);
    expect(shape.core).toEqual([
      "app",
      "comparison",
      "diff",
      "request",
      "review",
      "scan",
      "session",
      "start",
    ]);
    expect(shape.coreApp).toEqual(["info", "ping"]);
    expect(shape.coreRequest).toEqual(["cancel"]);
    expect(shape.coreComparison).toEqual(["list"]);
    expect(shape.coreDiff).toEqual(["file"]);
    expect(shape.coreReview).toEqual(["clearAll", "mark", "markAll", "status", "storeUsage"]);
    expect(shape.unchanged).toBe(true);
  });

  test("require, process and eval are unavailable in the renderer", async () => {
    // DevTools' Runtime.evaluate suspends CSP's eval block while it runs, so the eval
    // attempts run afterwards in an ordinary page task, the way renderer code would.
    const result = await app.page.evaluate(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          const attempt = (fn: () => unknown) => {
            try {
              fn();
              return "allowed";
            } catch (error) {
              return (error as Error).name;
            }
          };
          setTimeout(() => {
            resolve({
              require: typeof (globalThis as Record<string, unknown>).require,
              process: typeof (globalThis as Record<string, unknown>).process,
              // biome-ignore lint/security/noGlobalEval: proves the CSP blocks eval
              eval: attempt(() => globalThis.eval("1 + 1")),
              functionConstructor: attempt(() => new Function("return 1")()),
              unknownEvent: attempt(() => window.treepeek.on("fs.changed" as never, () => {})),
            });
          }, 0);
        }),
    );
    expect(result).toEqual({
      require: "undefined",
      process: "undefined",
      eval: "EvalError",
      functionConstructor: "EvalError",
      unknownEvent: "Error",
    });
  });

  test("navigating away and opening windows are blocked", async () => {
    const { page, browser } = app;
    const opened = await page.evaluate(() => window.open("https://example.com/") === null);
    await page.evaluate(() => {
      window.location.href = "https://example.com/";
    });
    await page.waitForTimeout(1_000);
    expect(opened).toBe(true);
    expect(page.url()).toBe("app://treepeek/index.html");
    const pages = browser.contexts().flatMap((context) => context.pages());
    expect(pages).toHaveLength(1);
  });

  test("every response carries the strict CSP, and nothing outside the renderer is served", async () => {
    const result = await app.page.evaluate(async () => {
      const response = await fetch("app://treepeek/index.html");
      const traversal = await fetch("app://treepeek/..%2F..%2Fpackage.json").catch(() => null);
      const otherHost = await fetch("app://elsewhere/index.html").catch(() => null);
      const inline = document.createElement("script");
      inline.textContent = "window.__inlineRan = true";
      document.head.append(inline);
      return {
        csp: response.headers.get("content-security-policy"),
        traversalStatus: traversal?.status ?? 0,
        otherHostStatus: otherHost?.status ?? 0,
        inlineRan: (window as unknown as Record<string, unknown>).__inlineRan === true,
      };
    });
    expect(result.csp).toContain("default-src 'self'");
    expect(result.csp).toContain("script-src 'self'");
    expect(result.csp).not.toContain("unsafe-eval");
    expect(result.csp).not.toMatch(/https?:/);
    expect(result.traversalStatus).not.toBe(200);
    expect(result.otherHostStatus).not.toBe(200);
    expect(result.inlineRan).toBe(false);
  });

  test("app.ping round-trips to main and to the core service", async () => {
    const result = await app.page.evaluate(async () => ({
      main: await window.treepeek.main.app.ping(),
      core: await window.treepeek.core.app.ping(),
    }));
    expect(result.main).toMatchObject({ ok: true, value: { process: "main" } });
    expect(result.core).toMatchObject({ ok: true, value: { process: "core" } });
  });

  test("invalid payloads return invalidRequest instead of throwing", async () => {
    const result = await app.page.evaluate(async () => ({
      main: await window.treepeek.main.settings.set({ appearance: "neon" } as never),
      core: await window.treepeek.core.request.cancel({} as never),
    }));
    expect(result.main).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(result.core).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });

  test("the page cannot name recent folders, save a layout for the welcome window, or open a non-folder", async () => {
    const result = await app.page.evaluate(async () => ({
      recent: await window.treepeek.main.settings.set({ recentFolders: ["/etc"] } as never),
      openRecent: await window.treepeek.main.folder.openRecent({ path: "/etc" }),
      open: await window.treepeek.main.folder.open({ path: "/etc/hosts" }),
      state: await window.treepeek.main.window.state({
        ui: {
          timelineOpen: true,
          navigatorMode: "tree",
          timelineGrouping: "all",
          timelineOrder: "oldest",
          previewMode: "split",
          timelineWidth: null,
          navigatorWidth: null,
          selectedCheckout: null,
        },
      }),
    }));
    expect(result.recent).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(result.openRecent).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(result.open).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(result.state).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(app.pages()).toHaveLength(1);
  });

  test("git.state reports the git the core service found, and the renderer cannot change it", async () => {
    const { page } = app;
    const state = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const stop = window.treepeek.on("git.state", (payload) => {
            stop();
            resolve(payload);
          });
        }),
    );
    console.log(`[${target}] git.state:`, JSON.stringify(state));
    expect(state).toMatchObject({ found: true, path: expect.stringMatching(/^\//) });
    const version = (state as { version: string }).version.split(".").map(Number);
    expect(version[0] ?? 0).toBeGreaterThanOrEqual(2);
    if (version[0] === 2) expect(version[1] ?? 0).toBeGreaterThanOrEqual(36);

    const set = await page.evaluate(() =>
      window.treepeek.main.settings.set({ gitPath: "/tmp/evil" } as never),
    );
    expect(set).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    const settings = await page.evaluate(() => window.treepeek.main.settings.get());
    expect(settings).toMatchObject({ ok: true, value: { gitPath: null } });
  });

  test("the sqlite probe result is reported", async () => {
    const info = await app.page.evaluate(() => window.treepeek.core.app.info());
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    test.info().annotations.push({
      type: "node:sqlite",
      description: JSON.stringify({ target, ...info.value.sqlite, node: info.value.versions.node }),
    });
    console.log(`[${target}] core service node:sqlite probe:`, JSON.stringify(info.value.sqlite));
    expect(typeof info.value.sqlite.available).toBe("boolean");
    expect(info.value.versions.electron).toMatch(/^45\./);
  });

  test("the theme switches live and both themes pass the AA contrast check", async () => {
    const { page } = app;
    for (const [appearance, isDark, background] of [
      ["light", false, LIGHT_BACKGROUND],
      ["dark", true, DARK_BACKGROUND],
    ] as const) {
      const started = Date.now();
      const set = await page.evaluate(
        (next) => window.treepeek.main.settings.set({ appearance: next }),
        appearance,
      );
      expect(set).toMatchObject({ ok: true, value: { appearance } });
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        isDark,
        { timeout: 1_000 },
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(painted).toBe(background);

      const violations = await contrastViolations(page);
      expect(violations.map((violation) => `${appearance}: ${violation}`)).toEqual([]);
    }
    await page.evaluate(() => window.treepeek.main.settings.set({ appearance: "system" }));
  });

  test("the core service restarts after it is killed, and the window's port works again", async () => {
    const { page } = app;
    await page.evaluate(() => {
      const probe: Probe = { states: [] };
      (window as unknown as { __probe: Probe }).__probe = probe;
      window.treepeek.on("core.state", (payload) => probe.states.push([payload.state, Date.now()]));
    });
    const before = await page.evaluate(() => window.treepeek.core.app.info());
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const killedAt = Date.now();
    process.kill(before.value.pid, "SIGKILL");

    await page.waitForFunction(
      (since) => {
        const states = (window as unknown as { __probe: Probe }).__probe.states;
        const restarting = states.findIndex(([state, at]) => state === "restarting" && at >= since);
        return restarting >= 0 && states.slice(restarting + 1).some(([state]) => state === "ready");
      },
      killedAt,
      { timeout: 3_000 },
    );
    const readyAt = await page.evaluate((since) => {
      const states = (window as unknown as { __probe: Probe }).__probe.states;
      return states.filter(([state, at]) => state === "ready" && at >= since).at(-1)?.[1] ?? 0;
    }, killedAt);
    expect(readyAt - killedAt).toBeLessThan(3_000);

    await waitFor(
      async () => {
        const ping = await page.evaluate(() => window.treepeek.core.app.ping());
        return ping.ok && ping.value.pid !== before.value.pid;
      },
      3_000,
      "a ping answered by the restarted core service",
    );
  });

  test("a second launch focuses the running app instead of starting another", async () => {
    const second = spawnApp(app.userDataDir);
    const code = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => resolveExit(-1), 15_000);
      second.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolveExit(exitCode);
      });
    });
    expect(code).toBe(0);
    await waitFor(
      () =>
        Promise.resolve(
          app.log("main").includes("second instance launched; focused the existing window"),
        ),
      5_000,
      "the running app to log the hand-over",
    );
    expect(app.browser.contexts().flatMap((context) => context.pages())).toHaveLength(1);
  });
});

test.describe(`launch behaviour (${target})`, () => {
  test("a new window in dark mode never paints white", async () => {
    const app = await launchApp({ settings: { version: 1, appearance: "dark" } });
    try {
      // As early as the page is reachable, before waiting for React.
      const early = await app.page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      const png = await app.page.screenshot();
      const samples = await app.page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) return [];
        context.drawImage(image, 0, 0);
        const points = [
          [4, image.height - 4],
          [image.width - 4, image.height - 4],
          [Math.floor(image.width / 2), Math.floor(image.height - 10)],
          [Math.floor(image.width / 4), Math.floor(image.height / 2)],
        ];
        return points.map(([x, y]) => Array.from(context.getImageData(x ?? 0, y ?? 0, 1, 1).data));
      }, png.toString("base64"));
      expect(early).toBe(true);
      expect(samples.length).toBeGreaterThan(0);
      for (const [r = 255, g = 255, b = 255] of samples) {
        expect(Math.max(r, g, b)).toBeLessThan(80);
      }
    } finally {
      await app.close();
    }
  });

  test("the git override from settings is tried first, and a missing one falls back", async () => {
    const realGit = gitOnPath();
    const folder = mkdtempSync(join(tmpdir(), "treepeek-e2e-git-"));
    const override = join(folder, "git");
    symlinkSync(realGit, override);
    const readGitState = (page: Page) =>
      page.evaluate(
        () =>
          new Promise<unknown>((resolve) => {
            const stop = window.treepeek.on("git.state", (payload) => {
              stop();
              resolve(payload);
            });
          }),
      );
    try {
      const withOverride = await launchApp({
        settings: { appearance: "system", gitPath: override },
      });
      try {
        expect(await readGitState(withOverride.page)).toMatchObject({
          found: true,
          path: override,
        });
      } finally {
        await withOverride.close();
      }
      const missing = join(folder, "missing", "git");
      const withMissing = await launchApp({ settings: { appearance: "system", gitPath: missing } });
      try {
        const state = await readGitState(withMissing.page);
        expect(state).toMatchObject({ found: true });
        expect(state).not.toMatchObject({ path: missing });
      } finally {
        await withMissing.close();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("the appearance setting survives a restart", async () => {
    const userDataDir = newUserDataDir();
    const first = await launchApp({ userDataDir });
    try {
      const set = await first.page.evaluate(() =>
        window.treepeek.main.settings.set({ appearance: "light" }),
      );
      expect(set).toMatchObject({ ok: true });
    } finally {
      await first.close();
    }
    const second = await launchApp({ userDataDir });
    try {
      const settings = await second.page.evaluate(() => window.treepeek.main.settings.get());
      expect(settings).toMatchObject({ ok: true, value: { appearance: "light", gitPath: null } });
      await expect
        .poll(() => second.page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(false);
    } finally {
      await second.close();
    }
  });
});
