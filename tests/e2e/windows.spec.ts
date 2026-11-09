import { expect, type Page, test } from "@playwright/test";
import { type Fixture, fixture } from "../support/git-fixture";
import {
  launchApp,
  launchWithFolder,
  newUserDataDir,
  target,
  waitFor,
  windowKind,
} from "./support/app";

/** The scan root a scan window shows, or `null` for the welcome window. */
function scanRootOf(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector('[data-testid="scan-window"]')?.getAttribute("data-scan-root") ?? null,
  );
}

const DARK_LIMIT = 80;

test.describe(`windows (${target})`, () => {
  let fx: Fixture;

  test.beforeAll(() => {
    fx = fixture();
    for (const name of ["one", "two", "three"]) {
      fx.repo(name).commit({ "README.md": `${name}\n` });
    }
  });

  test.afterAll(() => fx?.cleanup());

  test("one window per folder: opening a folder again opens no second window", async () => {
    const app = await launchWithFolder(fx.path("one"));
    try {
      await expect.poll(() => scanRootOf(app.page)).toBe(fx.path("one"));
      const opened = await app.page.evaluate(
        (path) => window.treepeek.main.folder.open({ path }),
        fx.path("two"),
      );
      expect(opened).toEqual({ ok: true, value: {} });
      await app.waitForPage(
        async (page) => (await scanRootOf(page)) === fx.path("two"),
        "folder two",
      );
      expect(app.pages()).toHaveLength(2);

      const again = await app.page.evaluate(
        (path) =>
          Promise.all([
            window.treepeek.main.folder.open({ path }),
            window.treepeek.main.folder.openRecent({ path }),
          ]),
        fx.path("one"),
      );
      expect(again).toEqual([
        { ok: true, value: {} },
        { ok: true, value: {} },
      ]);
      await app.page.waitForTimeout(500);
      expect(app.pages()).toHaveLength(2);
      expect(app.log("main")).not.toContain("not opening");
    } finally {
      await app.close();
    }
  });

  test("open windows come back on relaunch, and saved bounds are used", async () => {
    const userDataDir = newUserDataDir();
    const folders = [fx.path("one"), fx.path("two"), fx.path("three")];
    const first = await launchWithFolder(folders, { userDataDir });
    try {
      await waitFor(async () => first.pages().length === 3, 20_000, "three scan windows");
      // Window positions are written shortly after they settle.
      await first.page.waitForTimeout(1_200);
    } finally {
      await first.close();
    }
    const second = await launchApp({ userDataDir });
    try {
      await waitFor(
        async () =>
          second.pages().length === 3 &&
          (await Promise.all(second.pages().map((page) => scanRootOf(page)))).every(Boolean),
        20_000,
        "three restored windows",
      );
      const roots = await Promise.all(second.pages().map((page) => scanRootOf(page)));
      expect(roots.sort()).toEqual([...folders].sort());
    } finally {
      await second.close();
    }

    const bounds = [
      { x: 60, y: 120, width: 1000, height: 640 },
      { x: 90, y: 150, width: 1100, height: 700 },
      { x: 120, y: 180, width: 960, height: 600 },
    ];
    const seeded = await launchApp({
      settings: {
        version: 1,
        appearance: "system",
        windows: folders.map((scanRoot, index) => ({ scanRoot, bounds: bounds[index], ui: null })),
      },
    });
    try {
      await waitFor(
        async () =>
          seeded.pages().length === 3 &&
          (await Promise.all(seeded.pages().map((page) => scanRootOf(page)))).every(Boolean),
        20_000,
        "three seeded windows",
      );
      for (const page of seeded.pages()) {
        const root = await scanRootOf(page);
        const want = bounds[folders.indexOf(root ?? "")];
        const got = await page.evaluate(() => ({
          x: window.screenX,
          y: window.screenY,
          width: window.outerWidth,
          height: window.outerHeight,
        }));
        expect(got, `bounds of ${root}`).toEqual(want);
      }
    } finally {
      await seeded.close();
    }
  });

  test("a folder that no longer exists is skipped on relaunch, leaving the welcome window", async () => {
    const app = await launchApp({
      settings: {
        version: 1,
        appearance: "system",
        windows: [{ scanRoot: fx.path("gone"), bounds: null, ui: null }],
      },
    });
    try {
      await expect.poll(() => windowKind(app.page)).toBe("welcome");
      expect(app.pages()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  test("closing the last scan window shows the welcome window, and the app keeps running", async () => {
    const app = await launchWithFolder(fx.path("one"));
    try {
      await expect.poll(() => windowKind(app.page)).toBe("scan");
      await app.page.close();
      const welcome = await app.waitForPage(
        async (page) => (await windowKind(page)) === "welcome",
        "the welcome window",
      );
      expect(app.process.exitCode).toBeNull();
      await expect(welcome.getByRole("button", { name: "Open Folder…" })).toBeVisible();
      // The folder is now a recent one, and opening it replaces the welcome window.
      await expect(welcome.getByRole("button", { name: /one/ })).toBeVisible();
      await welcome.getByRole("button", { name: /one/ }).click();
      await app.waitForPage(
        async (page) => (await scanRootOf(page)) === fx.path("one"),
        "folder one",
      );
      await waitFor(async () => app.pages().length === 1, 5_000, "the welcome window to close");
    } finally {
      await app.close();
    }
  });

  test("a scan window opened in dark mode never paints white", async () => {
    const app = await launchWithFolder(fx.path("two"), {
      settings: { version: 1, appearance: "dark" },
    });
    try {
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
          [Math.floor(image.width / 2), Math.floor(image.height / 2)],
          [Math.floor(image.width / 5), Math.floor(image.height / 2)],
        ];
        return points.map(([x, y]) => Array.from(context.getImageData(x ?? 0, y ?? 0, 1, 1).data));
      }, png.toString("base64"));
      expect(early).toBe(true);
      expect(samples.length).toBeGreaterThan(0);
      for (const [r = 255, g = 255, b = 255] of samples) {
        expect(Math.max(r, g, b)).toBeLessThan(DARK_LIMIT);
      }
    } finally {
      await app.close();
    }
  });
});
