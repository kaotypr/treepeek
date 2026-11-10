import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DiscoverDeps,
  type DiscoverOptions,
  discoverGit,
  KNOWN_GIT_LOCATIONS,
  parseGitVersion,
  probeGit,
  SYSTEM_GIT,
} from "../../../../src/core/git/discover";
import { observeSpawns } from "../../../../src/core/git/process";
import { MIN_GIT_VERSION } from "../../../../src/shared/domain/git";
import { testGitPath, testGitVersion } from "../../../support/git";

let root: string;

/** Writes `<root>/<folder>/git`, a script that prints `git version <version>`. */
function fakeGit(folder: string, version: string): string {
  const file = join(root, folder, "git");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho "git version ${version}"\n`, { mode: 0o755 });
  return file;
}

/** A fake `xcode-select -p`: prints `folder`, or fails like it does without the tools. */
function fakeXcodeSelect(name: string, folder: string | null): string {
  const file = join(root, "bin", name);
  mkdirSync(dirname(file), { recursive: true });
  const body =
    folder === null
      ? "echo 'xcode-select: error: unable to get active developer directory' >&2\nexit 2"
      : `echo '${folder}'`;
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** Runs discovery and records every executable it started. */
async function discover(options: Partial<DiscoverOptions>, deps: DiscoverDeps) {
  const spawned: string[] = [];
  const stop = observeSpawns((event) => {
    if (event.type === "spawn") spawned.push(event.file);
  });
  try {
    const state = await discoverGit(
      { override: null, loginPath: null, ...options },
      { platform: "darwin", knownLocations: [], ...deps },
    );
    return { state, spawned };
  } finally {
    stop();
  }
}

const NEW = "2.45.1";
const OLD = "2.30.2";

let systemGit: string;
let toolsMissing: string;
let toolsInstalled: string;
let toolsGone: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-discover-")));
  systemGit = fakeGit("usr-bin", "2.39.5 (Apple Git-154)");
  toolsMissing = fakeXcodeSelect("xcode-missing", null);
  mkdirSync(join(root, "CommandLineTools"));
  toolsInstalled = fakeXcodeSelect("xcode-installed", join(root, "CommandLineTools"));
  toolsGone = fakeXcodeSelect("xcode-gone", join(root, "no-such-folder"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseGitVersion", () => {
  it("reads the versions git prints on macOS, Homebrew and other builds", () => {
    expect(parseGitVersion("git version 2.55.0\n")).toEqual([2, 55, 0]);
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)\n")).toEqual([2, 39, 5]);
    expect(parseGitVersion("git version 2.45.0.windows.1")).toEqual([2, 45, 0]);
    expect(parseGitVersion("git version 2.36.0.rc1")).toEqual([2, 36, 0]);
    expect(parseGitVersion("git version 3.0")).toEqual([3, 0, 0]);
    expect(parseGitVersion("hub version 2.14.2")).toBeNull();
    expect(parseGitVersion("")).toBeNull();
  });

  it("has a minimum of 2.36.0", () => {
    expect(MIN_GIT_VERSION).toEqual([2, 36, 0]);
  });
});

describe("discoverGit", () => {
  it("uses the override first", async () => {
    const override = fakeGit("override", NEW);
    const onPath = fakeGit("path-a", "2.50.0");
    const { state, spawned } = await discover(
      { override, loginPath: dirname(onPath) },
      { systemGit, xcodeSelect: toolsInstalled },
    );
    expect(state).toEqual({ found: true, path: override, version: "2.45.1" });
    expect(spawned).toEqual([override]);
  });

  it("falls through an unusable override to git on the login PATH, in PATH order", async () => {
    const tooOld = fakeGit("override-old", OLD);
    const first = fakeGit("path-first", "2.40.0");
    const second = fakeGit("path-second", "2.50.0");
    const { state, spawned } = await discover(
      {
        override: tooOld,
        loginPath: [join(root, "missing"), "relative/bin", dirname(first), dirname(second)].join(
          ":",
        ),
      },
      { systemGit, xcodeSelect: toolsInstalled },
    );
    expect(state).toEqual({ found: true, path: first, version: "2.40.0" });
    expect(spawned).toEqual([tooOld, first]);
  });

  it("tries the known locations after the PATH", async () => {
    const homebrew = fakeGit("opt-homebrew-bin", NEW);
    const { state, spawned } = await discover(
      { loginPath: join(root, "empty") },
      {
        knownLocations: [join(root, "nowhere", "git"), homebrew],
        systemGit,
        xcodeSelect: toolsInstalled,
      },
    );
    expect(state).toMatchObject({ found: true, path: homebrew });
    expect(spawned).toEqual([homebrew]);
  });

  it("runs /usr/bin/git only after xcode-select names an existing folder", async () => {
    const { state, spawned } = await discover({}, { systemGit, xcodeSelect: toolsInstalled });
    expect(state).toEqual({ found: true, path: systemGit, version: "2.39.5" });
    expect(spawned).toEqual([toolsInstalled, systemGit]);
  });

  it("never runs /usr/bin/git when xcode-select fails", async () => {
    const { state, spawned } = await discover({}, { systemGit, xcodeSelect: toolsMissing });
    expect(spawned).toEqual([toolsMissing]);
    expect(spawned).not.toContain(systemGit);
    expect(state).toEqual({
      found: false,
      problem: "xcodeMissing",
      detail: `${systemGit} needs the Xcode Command Line Tools, which are not installed.`,
    });
  });

  it("never runs /usr/bin/git when xcode-select names a folder that does not exist", async () => {
    const { state, spawned } = await discover({}, { systemGit, xcodeSelect: toolsGone });
    expect(spawned).toEqual([toolsGone]);
    expect(state).toMatchObject({ found: false, problem: "xcodeMissing" });
  });

  it("guards /usr/bin/git wherever it turns up: on the PATH, as the override, or behind a symlink", async () => {
    const link = join(root, "linked-bin", "git");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(systemGit, link);
    const { state, spawned } = await discover(
      { override: systemGit, loginPath: `${dirname(link)}:${dirname(systemGit)}` },
      { systemGit, xcodeSelect: toolsMissing },
    );
    expect(spawned).toEqual([toolsMissing]);
    expect(state).toMatchObject({ found: false, problem: "xcodeMissing" });
  });

  it("runs xcode-select at most once and each binary at most once", async () => {
    const same = fakeGit("dedupe", OLD);
    const { spawned } = await discover(
      { override: same, loginPath: `${dirname(same)}:${dirname(same)}` },
      { knownLocations: [same], systemGit, xcodeSelect: toolsMissing },
    );
    expect(spawned).toEqual([same, toolsMissing]);
  });

  it("reports tooOld, naming the first old git, when nothing newer exists", async () => {
    const old = fakeGit("only-old", OLD);
    const { state } = await discover(
      { loginPath: dirname(old) },
      { systemGit, xcodeSelect: toolsMissing },
    );
    expect(state).toEqual({
      found: false,
      problem: "tooOld",
      detail: `Git 2.30.2 at ${old} is older than 2.36.0, the oldest version Treepeek supports.`,
    });
  });

  it("accepts exactly the minimum version", async () => {
    const minimum = fakeGit("minimum", "2.36.0");
    const { state } = await discover(
      { override: minimum },
      { systemGit, xcodeSelect: toolsMissing },
    );
    expect(state).toMatchObject({ found: true, version: "2.36.0" });
  });

  it("skips files that are not executable or do not print a version", async () => {
    const plain = join(root, "plain", "git");
    mkdirSync(dirname(plain), { recursive: true });
    writeFileSync(plain, "not a program\n", { mode: 0o644 });
    const liar = join(root, "liar", "git");
    mkdirSync(dirname(liar), { recursive: true });
    writeFileSync(liar, "#!/bin/sh\necho hello\n", { mode: 0o755 });
    const { state, spawned } = await discover(
      { override: plain, loginPath: dirname(liar) },
      { systemGit: join(root, "no-system-git"), xcodeSelect: toolsMissing },
    );
    expect(spawned).toEqual([liar]);
    expect(state).toEqual({ found: false, problem: "notFound" });
  });

  it("does not guard /usr/bin/git off macOS", async () => {
    const { state, spawned } = await discover(
      {},
      { systemGit, xcodeSelect: toolsMissing, platform: "linux" },
    );
    expect(spawned).toEqual([systemGit]);
    expect(state).toMatchObject({ found: true, path: systemGit });
  });

  it("finds the real git on a real PATH", async () => {
    const git = testGitPath();
    const state = await discoverGit(
      { override: null, loginPath: dirname(git) },
      { knownLocations: [], systemGit: join(root, "no-system-git") },
    );
    expect(state).toEqual({ found: true, path: git, version: testGitVersion() });
  });

  it("names the real macOS locations by default", () => {
    expect(KNOWN_GIT_LOCATIONS).toEqual(["/opt/homebrew/bin/git", "/usr/local/bin/git"]);
    expect(SYSTEM_GIT).toBe("/usr/bin/git");
  });
});

describe("probeGit", () => {
  const deps = (more: DiscoverDeps = {}): DiscoverDeps => ({
    platform: "darwin",
    systemGit: join(root, "no-system-git"),
    ...more,
  });

  it("accepts a git at least the minimum version", async () => {
    const git = fakeGit("probe-new", NEW);
    expect(await probeGit(git, null, deps())).toEqual({ found: true, path: git, version: NEW });
  });

  it("names a git below the minimum as too old, without looking anywhere else", async () => {
    const old = fakeGit("probe-old", OLD);
    fakeGit("probe-elsewhere", NEW);
    expect(await probeGit(old, join(root, "probe-elsewhere"), deps())).toEqual({
      found: false,
      problem: "tooOld",
      detail: expect.stringContaining(`Git ${OLD} at ${old} is older than`),
    });
  });

  it("refuses a missing file, a relative path and a program that is not git", async () => {
    const liar = join(root, "probe-liar", "git");
    mkdirSync(dirname(liar), { recursive: true });
    writeFileSync(liar, "#!/bin/sh\necho hello\n", { mode: 0o755 });
    for (const path of [join(root, "nowhere", "git"), "bin/git", liar]) {
      expect(await probeGit(path, null, deps())).toMatchObject({
        found: false,
        problem: "notFound",
      });
    }
  });

  it("does not run macOS's git shim without the Command Line Tools", async () => {
    const { state, spawned } = await (async () => {
      const seen: string[] = [];
      const stop = observeSpawns((event) => {
        if (event.type === "spawn") seen.push(event.file);
      });
      try {
        return {
          state: await probeGit(systemGit, null, deps({ systemGit, xcodeSelect: toolsMissing })),
          spawned: seen,
        };
      } finally {
        stop();
      }
    })();
    expect(state).toMatchObject({ found: false, problem: "xcodeMissing" });
    expect(spawned).toEqual([toolsMissing]);
  });
});
