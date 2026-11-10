import { expect, type Page, test } from "@playwright/test";
import { type Fixture, type FixtureRepo, fixture } from "../support/git-fixture";
import { type App, type LaunchRecord, launchLog, launchWithFolder, target } from "./support/app";
import { selectCheckout, selectFile, waitForScan } from "./support/review";

/**
 * "Open in…": Finder, the editor, the terminal and copying, from the shortcuts and the
 * Open in ▾ menu. The app runs with the test-only launch log, so nothing is opened and the
 * clipboard is left alone: each test asserts the exact program and arguments that would
 * have run.
 */

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
const EDITED = TEN_LINES.replace("line 6", "line six");

/** Waits until the launch log holds `count` records, and answers them. */
async function recorded(log: ReturnType<typeof launchLog>, count: number): Promise<LaunchRecord[]> {
  await expect.poll(() => log.read().length, { timeout: 5_000 }).toBe(count);
  return log.read();
}

async function openFileWithChange(page: Page, repo: FixtureRepo): Promise<void> {
  await selectCheckout(page, repo.path);
  await selectFile(page, "src/a.ts");
  // The diff is loaded, so the first changed line is known.
  await expect(page.getByTestId("preview-stats")).toBeVisible();
}

test.describe(`open in (${target})`, () => {
  test.describe.configure({ mode: "serial" });

  let app: App;
  let fx: Fixture;
  let repo: FixtureRepo;
  const log = launchLog();

  test.beforeAll(async () => {
    fx = fixture();
    repo = fx.repo("app").commit({ "src/a.ts": `${TEN_LINES}\n` });
    repo.write({ "src/a.ts": `${EDITED}\n` });
    app = await launchWithFolder(fx.root, {
      env: { TREEPEEK_E2E_LAUNCH_LOG: log.file },
      settings: {
        version: 1,
        editor: { kind: "custom", command: "myeditor --line {line} {path}" },
      },
    });
    await waitForScan(app.page, 1);
    await openFileWithChange(app.page, repo);
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  test("⌘⇧R reveals the checkout folder in Finder", async () => {
    const before = log.read().length;
    await app.page.keyboard.press("Meta+Shift+R");
    expect((await recorded(log, before + 1)).at(-1)).toEqual({
      action: "reveal",
      path: repo.path,
    });
  });

  test("⌘E opens the selected file at its first changed line, as an argument array", async () => {
    const before = log.read().length;
    await app.page.keyboard.press("Meta+E");
    expect((await recorded(log, before + 1)).at(-1)).toEqual({
      action: "run",
      command: "myeditor",
      args: ["--line", "6", `${repo.path}/src/a.ts`],
    });
  });

  test("⌘⇧E opens Terminal at the checkout folder", async () => {
    const before = log.read().length;
    await app.page.keyboard.press("Meta+Shift+E");
    expect((await recorded(log, before + 1)).at(-1)).toEqual({
      action: "run",
      command: "/usr/bin/open",
      args: ["-b", "com.apple.Terminal", repo.path],
    });
  });

  test("Open in ▾ copies the full commit id, the branch and the path", async () => {
    const { page } = app;
    const copy = async (label: string) => {
      await page.getByTestId("open-in-button").click();
      await page.getByTestId("open-in-menu").getByRole("menuitem", { name: label }).click();
      await expect(page.getByTestId("open-in-menu")).toBeHidden();
    };
    const before = log.read().length;
    await copy("Copy Commit");
    await expect(page.getByTestId("notice")).toHaveText("Copied the commit id.");
    await copy("Copy Branch");
    await copy("Copy Path");
    const head = repo.head();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect((await recorded(log, before + 3)).slice(before)).toEqual([
      { action: "copy", text: head },
      { action: "copy", text: "main" },
      { action: "copy", text: repo.path },
    ]);
  });

  test("Open in ▾ lists the editor, terminal and Finder with their shortcuts", async () => {
    const { page } = app;
    await page.getByTestId("open-in-button").click();
    const items = page.getByTestId("open-in-menu").getByRole("menuitem");
    await expect(items).toHaveText([
      "Open in Editor⌘E",
      "Open in Terminal⇧⌘E",
      "Reveal in Finder⇧⌘R",
      "Copy Path",
      "Copy Branch",
      "Copy Commit",
    ]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("open-in-menu")).toBeHidden();
  });

  test("a path in no scan is refused with notInScan, and nothing runs", async () => {
    const before = log.read().length;
    const outside = fx.outsidePath("elsewhere");
    const results = await app.page.evaluate(async (elsewhere) => {
      const main = window.treepeek.main;
      return [
        await main.openIn.finder({ path: "/etc" }),
        await main.openIn.editor({ path: `${elsewhere}/a.ts`, line: 2 }),
        await main.openIn.terminal({ path: "/Applications" }),
        await main.openIn.finder({ path: "/" }),
      ].map((result) => (result.ok ? "ok" : result.error.code));
    }, outside);
    expect(results).toEqual(["notInScan", "notInScan", "notInScan", "notInScan"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(log.read()).toHaveLength(before);
  });

  test("a terminal is never handed a file, even one in the scan", async () => {
    const before = log.read().length;
    const result = await app.page.evaluate(
      (path) => window.treepeek.main.openIn.terminal({ path }),
      `${repo.path}/src/a.ts`,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(log.read()).toHaveLength(before);
  });

  test("a scan window cannot change the editor or terminal command", async () => {
    const result = await app.page.evaluate(() =>
      window.treepeek.main.settings.set({
        editor: { kind: "custom", command: "/bin/sh -c 'touch /tmp/x' {path}" },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });
});

test.describe(`open in a detected editor (${target})`, () => {
  let app: App;
  let fx: Fixture;
  const log = launchLog();

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  test("the first detected editor opens the file at its line through its own CLI", async () => {
    fx = fixture();
    const repo = fx.repo("app").commit({ "src/a.ts": `${TEN_LINES}\n` });
    repo.write({ "src/a.ts": `${EDITED}\n` });
    app = await launchWithFolder(fx.root, { env: { TREEPEEK_E2E_LAUNCH_LOG: log.file } });
    await waitForScan(app.page, 1);
    const detected = await app.page.evaluate(() => window.treepeek.main.integrations.detect({}));
    if (!detected.ok) throw new Error(detected.error.message);
    const first = detected.value.editors[0];
    const cli =
      first?.bundleId === "com.microsoft.VSCode"
        ? "code"
        : first?.bundleId === "com.todesktop.230313mzl4w4u92"
          ? "cursor"
          : null;
    test.skip(cli === null, "needs VS Code or Cursor installed as the first detected editor");
    await openFileWithChange(app.page, repo);
    await app.page.keyboard.press("Meta+E");
    expect((await recorded(log, 1))[0]).toEqual({
      action: "run",
      command: `${first?.path}/Contents/Resources/app/bin/${cli}`,
      args: ["--goto", `${repo.path}/src/a.ts:6`],
    });
  });
});
