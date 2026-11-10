import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { testGitPath } from "../support/git";
import { type Fixture, fixture } from "../support/git-fixture";
import { type App, launchApp, launchWithFolder, target, windowKind } from "./support/app";
import { waitForScan } from "./support/review";

/**
 * The special screens: git setup when no usable git is found, a folder that cannot be
 * read, Git's `safe.directory` refusal, and About. Discovery is limited to the git override
 * (`TREEPEEK_E2E_GIT_OVERRIDE_ONLY`), as on a Mac with no git anywhere else, and native
 * dialogs answer through `TREEPEEK_E2E_DIALOG`.
 */

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as { version: string };

/** Written by `bun run notices`, which `bun run package` runs first. */
const GENERATED_NOTICES = resolve(import.meta.dirname, "../../build/THIRD_PARTY_NOTICES");

function savedGitPath(app: App): unknown {
  return JSON.parse(readFileSync(join(app.userDataDir, "settings.json"), "utf8")).gitPath;
}

test.describe(`special screens (${target})`, () => {
  let fx: Fixture;
  let oldGit: string;

  test.beforeAll(() => {
    fx = fixture();
    fx.repo("app").commit({ "a.txt": "a\n" });
    mkdirSync(join(fx.outside, "old"));
    oldGit = join(fx.outside, "old", "git");
    writeFileSync(oldGit, '#!/bin/sh\necho "git version 2.30.2"\n', { mode: 0o755 });
  });

  test.afterAll(() => fx?.cleanup());

  test("with no git anywhere, the setup screen shows; Try Again finds one installed since", async () => {
    const missing = join(fx.outside, "later", "git");
    const app = await launchWithFolder(fx.root, {
      settings: { version: 1, gitPath: missing },
      env: { TREEPEEK_E2E_GIT_OVERRIDE_ONLY: "1" },
    });
    try {
      const { page } = app;
      await expect(page.getByTestId("git-setup")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("git-setup-problem")).toHaveText(
        "Treepeek could not find Git on this Mac.",
      );
      await expect(page.getByTestId("git-setup")).toContainText("xcode-select --install");
      await expect(page.getByTestId("git-setup")).toContainText("brew install git");
      await expect(page.getByTestId("navigator")).toHaveCount(0);

      // Nothing has changed yet: looking again finds nothing, and the screen stays.
      await page.getByTestId("git-try-again").click();
      await expect(page.getByTestId("git-try-again")).toHaveText("Try Again");
      await expect(page.getByTestId("git-setup")).toBeVisible();

      // Git arrives where the setting points, and Try Again starts the scan.
      mkdirSync(join(fx.outside, "later"));
      symlinkSync(testGitPath(), missing);
      await page.getByTestId("git-try-again").click();
      await expect(page.getByTestId("git-setup")).toHaveCount(0);
      await waitForScan(page, 1);
    } finally {
      await app.close();
    }
  });

  test("picking a git: one too old is named on the screen, a usable one starts the scan", async () => {
    const real = testGitPath();
    const app = await launchWithFolder(fx.root, {
      settings: { version: 1, gitPath: join(fx.outside, "nowhere", "git") },
      env: {
        TREEPEEK_E2E_GIT_OVERRIDE_ONLY: "1",
        TREEPEEK_E2E_DIALOG: [oldGit, real].join(delimiter),
      },
    });
    try {
      const { page } = app;
      await expect(page.getByTestId("git-setup")).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("git-choose").click();
      await expect(page.getByTestId("git-setup-picked")).toContainText(
        `Git 2.30.2 at ${oldGit} is older than 2.36.0`,
      );
      await expect(page.getByTestId("git-setup")).toBeVisible();
      expect(savedGitPath(app)).toBe(join(fx.outside, "nowhere", "git"));

      await page.getByTestId("git-choose").click();
      await expect(page.getByTestId("git-setup")).toHaveCount(0);
      await waitForScan(page, 1);
      expect(savedGitPath(app)).toBe(real);
    } finally {
      await app.close();
    }
  });

  test("a folder Treepeek cannot read shows why, and Choose Another Folder replaces it", async () => {
    const locked = join(fx.outside, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const app = await launchWithFolder(locked, { env: { TREEPEEK_E2E_DIALOG: fx.root } });
    try {
      const { page } = app;
      await expect(page.getByTestId("scan-error")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("scan-error")).toContainText("Treepeek can't read this folder");
      await expect(page.getByTestId("scan-error")).toContainText(locked);
      await expect(page.getByTestId("navigator")).toHaveCount(0);

      await page.getByTestId("choose-another-folder").click();
      const opened = await app.waitForPage(
        async (candidate) =>
          (await candidate.getByTestId("scan-window").getAttribute("data-scan-root")) === fx.root,
        "the chosen folder's window",
      );
      await waitForScan(opened, 1);
      // The window that could not scan its folder has closed.
      await expect
        .poll(async () =>
          Promise.all(
            app.pages().map((candidate) =>
              candidate
                .getByTestId("scan-window")
                .getAttribute("data-scan-root", { timeout: 1_000 })
                .catch(() => null),
            ),
          ),
        )
        .toEqual([fx.root]);
    } finally {
      chmodSync(locked, 0o755);
      await app.close();
    }
  });

  test("Git's safe.directory refusal is explained, with the command and nothing changed", async () => {
    const other = fixture();
    try {
      other.repo("mine").commit({ "a.txt": "a\n" });
      const notMine = other.repo("not-mine").commit({ "b.txt": "b\n" });
      // A git that answers for `not-mine` exactly as Git does for a repository another user
      // owns, and is the real git for everything else.
      const wrapper = join(other.outside, "wrapper", "git");
      mkdirSync(join(other.outside, "wrapper"));
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          'for arg in "$@"; do',
          '  case "$arg" in',
          "    */not-mine*)",
          `      echo "fatal: detected dubious ownership in repository at '$arg'" >&2`,
          '      echo "To add an exception for this directory, call:" >&2',
          `      echo "	git config --global --add safe.directory $arg" >&2`,
          "      exit 128;;",
          "  esac",
          "done",
          `exec '${testGitPath()}' "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const app = await launchWithFolder(other.root, {
        settings: { version: 1, gitPath: wrapper },
        env: { TREEPEEK_E2E_GIT_OVERRIDE_ONLY: "1" },
      });
      try {
        const { page } = app;
        await expect(page.getByTestId("scan-status")).toHaveText(
          "1 Git checkout · 1 folder could not be read",
          { timeout: 30_000 },
        );
        const row = page.getByTestId("dubious-ownership-row");
        await expect(row).toContainText("not-mine");
        await expect(row).toContainText("belongs to another user");
        await expect(row).toContainText("Treepeek never changes Git's settings");
        await expect(row.getByTestId("copy-command-text")).toHaveText(
          `git config --global --add safe.directory '${notMine.path}'`,
        );
      } finally {
        await app.close();
      }
    } finally {
      other.cleanup();
    }
  });

  test("About shows the version, the license, the copyright and the notices, as one window", async () => {
    const app = await launchApp({ env: { TREEPEEK_E2E_MENU: "about,help.acknowledgements" } });
    try {
      const about = await app.waitForPage(
        async (page) => (await windowKind(page)) === "about",
        "the About window",
      );
      await expect(about.getByTestId("about-version")).toHaveText(`Version ${packageJson.version}`);
      await expect(about.getByTestId("about-license")).toHaveText(
        "Licensed under the Apache License, Version 2.0.",
      );
      await expect(about.getByTestId("about-copyright")).toHaveText(
        "Copyright 2026 Adhitya Yosua Sanjaya Andaria",
      );
      const acknowledgements = about.getByTestId("acknowledgements");
      await expect(acknowledgements).toContainText("Acknowledgements");
      // The NOTICE file: the packaged app carries it in Contents/Resources, a source build
      // reads it from the checkout.
      await expect(acknowledgements).toContainText(
        "Treepeek — Copyright 2026 Adhitya Yosua Sanjaya Andaria",
      );
      await expect(about.getByTestId("acknowledgements-missing")).toHaveCount(0);
      // The generated third-party notices: always in a package (`bun run package` generates
      // them first), and in a source build once `bun run notices` has written them.
      if (target === "packaged" || existsSync(GENERATED_NOTICES)) {
        await expect(acknowledgements).toContainText("THIRD-PARTY SOFTWARE NOTICES");
        await expect(acknowledgements).toContainText(/^@pierre\/diffs \d/m);
        await expect(acknowledgements).toContainText("Syntax grammars bundled through Shiki");
      }
      await expect.poll(() => app.log("main")).toContain("focused the about window");
      const kinds = await Promise.all(app.pages().map((page) => windowKind(page)));
      expect(kinds.filter((kind) => kind === "about")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
