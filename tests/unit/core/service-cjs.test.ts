/**
 * The core service bundled as CommonJS, the way a VS Code extension bundles it with
 * esbuild: no `import.meta` (which CommonJS leaves empty), nothing from Electron, and
 * `node:sqlite` found, or missed cleanly, at run time.
 *
 * esbuild because it is the bundler that shows the problem: Rollup and Vite fill in
 * `import.meta.url` in CommonJS output, so a bundle built with them would load either way.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { type BuildResult, build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ServiceModule from "../../../src/core/service";
import type { GitState } from "../../../src/shared/domain/git";
import { adapt, client } from "../../support/core-session";
import { testGitPath } from "../../support/git";

const root = resolve(import.meta.dirname, "../../..");
const requireBundle = createRequire(import.meta.url);

let workDir: string;
let bundle: string;
let built: BuildResult<{ metafile: true }>;
let copies = 0;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "treepeek-service-cjs-"));
  bundle = join(workDir, "service.cjs");
  built = await build({
    entryPoints: [join(root, "src/core/service.ts")],
    outfile: bundle,
    bundle: true,
    format: "cjs",
    platform: "node",
    external: ["@parcel/watcher"],
    metafile: true,
    logLevel: "silent",
    // esbuild reports an `import.meta` inside a `try` block at debug level only; raised
    // here, one left anywhere in the graph shows up as a warning.
    logOverride: { "empty-import-meta": "warning" },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Loads a fresh copy of the bundle: `node:sqlite` is looked up once per module instance,
 * so a test that changes what the runtime offers needs its own instance.
 */
function loadFreshCopy(): typeof ServiceModule {
  copies += 1;
  const copy = join(workDir, `service-${copies}.cjs`);
  copyFileSync(bundle, copy);
  return requireBundle(copy) as typeof ServiceModule;
}

/** Starts a service from the bundle and waits for its first git discovery. */
async function start(module: typeof ServiceModule, lines: string[]) {
  let reported!: (state: GitState) => void;
  const discovered = new Promise<GitState>((resolve) => {
    reported = resolve;
  });
  const service = module.createCoreService({
    dataDir: mkdtempSync(join(workDir, "data-")),
    logSink: (line) => lines.push(line),
    gitPathOverride: testGitPath(),
    loginPath: null,
    watchBackends: [],
    onGitState: (state) => reported(state),
  });
  await discovered;
  return service;
}

describe("the core service as a CommonJS bundle", () => {
  it("builds with no warnings and nothing from Electron", () => {
    expect(built.warnings.map((warning) => warning.text)).toEqual([]);
    expect(built.errors).toEqual([]);
    const inputs = Object.keys(built.metafile.inputs);
    expect(inputs).toContain("src/core/service.ts");
    expect(inputs.filter((input) => input.includes("node_modules/electron"))).toEqual([]);
  });

  it("opens the SQLite store", async () => {
    const lines: string[] = [];
    const service = await start(loadFreshCopy(), lines);
    await service.dispose();
    expect(lines.some((line) => line.includes('local store opened {"engine":"sqlite"}'))).toBe(
      true,
    );
  });

  it("falls back to the JSON store when the runtime has no node:sqlite", async () => {
    const builtin = process.getBuiltinModule.bind(process);
    const lookup = vi
      .spyOn(process, "getBuiltinModule")
      .mockImplementation(((id: string) =>
        id === "node:sqlite" ? undefined : builtin(id)) as typeof process.getBuiltinModule);

    const lines: string[] = [];
    const service = await start(loadFreshCopy(), lines);
    expect(lookup).toHaveBeenCalledWith("node:sqlite");
    expect(lines.some((line) => line.includes('local store opened {"engine":"json"}'))).toBe(true);

    const { port1, port2 } = new MessageChannel();
    service.attachSession(1, adapt(port1));
    const info = await client(port2).call<{ sqlite: { available: boolean } }>("app.info", {});
    expect(info).toMatchObject({ ok: true, value: { sqlite: { available: false } } });

    await service.dispose();
    port2.close();
  });
});
