import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  EXCLUDED_GRAMMARS,
  EXCLUDED_THEMES,
} from "../../src/renderer/diff-view/highlight/excluded-assets";
import { type Fixture, type FixtureCheckout, fixture } from "../support/git-fixture";
import { type App, launchWithFolder, target } from "./support/app";
import { renderedLines, selectCheckout, selectFile, waitForScan } from "./support/review";

/**
 * The Shiki grammars and themes the app does not ship (`excluded-assets.ts`): the build
 * leaves them out, and a file in one of those languages still shows, as plain text.
 */

const root = resolve(import.meta.dirname, "../..");
const CSP_STYLE_REFUSAL =
  /^Applying inline style violates the following Content Security Policy directive 'style-src 'self''/;
const ASSETS = join(root, "out/renderer/assets");

/** A grammar's own definition, as Shiki bundles it: its `scopeName` key and value. */
function grammarMarker(name: string): RegExp {
  const module = readFileSync(
    join(root, "node_modules/@shikijs/langs/dist", `${name}.mjs`),
    "utf8",
  );
  const scope = /scopeName\\?"\s*:\s*\\?"([^"\\]+)/.exec(module)?.[1];
  if (!scope) throw new Error(`no scopeName in @shikijs/langs/dist/${name}.mjs`);
  return new RegExp(`scopeName\\\\?"\\s*:\\s*\\\\?"${scope.replaceAll(".", "\\.")}\\\\?"`);
}

/** A Shiki theme's own definition: its `name` key and value. */
function themeMarker(name: string): RegExp {
  return new RegExp(`"?name\\\\?"\\s*:\\s*\\\\?"${name}\\\\?"`);
}

function bundledText(): string {
  return readdirSync(ASSETS)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(ASSETS, file), "latin1"))
    .join("\n");
}

// `bun run package` builds out/ right before packaging, so this checks what the package
// holds too.
test("the build bundles none of the excluded grammars and themes", () => {
  const text = bundledText();
  const found = (marker: RegExp) => marker.test(text);
  // The markers find what is shipped, so their absence below means something.
  expect(found(grammarMarker("yaml"))).toBe(true);
  expect(found(grammarMarker("cpp"))).toBe(true);
  expect(found(themeMarker("andromeeda"))).toBe(true);
  const bundled = [
    ...EXCLUDED_GRAMMARS.filter(({ name }) => found(grammarMarker(name))).map(
      ({ name }) => `grammar ${name}`,
    ),
    ...EXCLUDED_THEMES.filter(({ name }) => found(themeMarker(name))).map(
      ({ name }) => `theme ${name}`,
    ),
  ];
  expect(bundled).toEqual([]);
});

test.describe(`files in excluded languages (${target})`, () => {
  let app: App;
  let fx: Fixture;
  let checkout: FixtureCheckout;
  const errors: string[] = [];

  test.beforeAll(async () => {
    fx = fixture();
    const repo = fx.repo("langs").commit({
      "server.conf": "server {\n  listen 80;\n}\n",
      "main.adb": "procedure Main is\nbegin\n  null;\nend Main;\n",
      "app.ts": "export const answer = 1;\n",
    });
    checkout = repo.worktree("langs-wt", { from: "main" }).commit({
      "server.conf": "server {\n  listen 8080;\n}\n",
      "main.adb": 'procedure Main is\nbegin\n  Put_Line ("hi");\nend Main;\n',
      "app.ts": "export const answer: number = 42;\n",
    });
    app = await launchWithFolder(fx.root);
    app.page.on("console", (message) => {
      // The diff library's inline styles are refused by the CSP by design and re-applied
      // through the CSSOM (`pierre/csp-styles.ts`); every other error counts.
      if (message.type() === "error" && !CSP_STYLE_REFUSAL.test(message.text())) {
        errors.push(message.text());
      }
    });
    app.page.on("pageerror", (error) => errors.push(error.message));
    await waitForScan(app.page);
    await selectCheckout(app.page, checkout.path);
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  for (const [path, line] of [
    ["server.conf", "listen 8080;"],
    ["main.adb", 'Put_Line ("hi");'],
  ] as const) {
    test(`${path} shows as plain text, without an error`, async () => {
      const { page } = app;
      await selectFile(page, path);
      await expect.poll(async () => (await renderedLines(page)).join("\n")).toContain(line);
      // Highlighting lands asynchronously; give a request time to fail or to color tokens.
      await page.waitForTimeout(1_500);
      expect(await tokenColors(page)).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("a language the app ships is still highlighted", async () => {
    const { page } = app;
    await selectFile(page, "app.ts");
    await expect.poll(() => tokenColors(page)).not.toEqual([]);
    expect(errors).toEqual([]);
  });
});

/** The syntax colors of the rendered tokens; empty when the text is plain. */
function tokenColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = document.querySelector("diffs-container")?.shadowRoot;
    return [...(host?.querySelectorAll<HTMLElement>("[data-line] span") ?? [])]
      .map((span) => span.style.getPropertyValue("--diffs-token-light"))
      .filter((color) => color !== "");
  });
}
