import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitError } from "../../../../src/core/git/errors";
import { HashObjectBatch } from "../../../../src/core/git/hash-object";
import type { ConfigEntry } from "../../../../src/core/git/parse/config-list";
import { observeSpawns } from "../../../../src/core/git/process";
import { runGit } from "../../../../src/core/git/run";
import {
  configOverrideEnv,
  filterDriverOverrides,
  MAX_CONFIG_OVERRIDES,
} from "../../../../src/core/git/untrusted-config";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { gitIn } from "../../../support/git";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

const signal = () => new AbortController().signal;

function entry(scope: string, key: string, value: string | null = "cmd"): ConfigEntry {
  return { scope, origin: "file:x", key, value, invalidUtf8: false };
}

describe("filterDriverOverrides", () => {
  it("empties every filter key set outside the user's config, keeping the user's own values", () => {
    const overrides = filterDriverOverrides([
      entry("global", "filter.lfs.clean", "git-lfs clean -- %f"),
      entry("global", "filter.lfs.process", "git-lfs filter-process"),
      entry("system", "filter.lfs.required", null),
      entry("local", "filter.lfs.process", "/tmp/evil"),
      entry("local", "filter.lfs.required", "true"),
      entry("local", "filter.evil.clean"),
      entry("local", "filter.evil.smudge"),
      entry("worktree", "filter.wt.process"),
      entry("local", "filter.a=b.c.d.required", "true"),
      entry("unknown", "filter.odd.clean"),
      entry("local", "filter.evil.clean", "again"),
    ]);
    expect(overrides).toEqual([
      { key: "filter.lfs.process", value: "git-lfs filter-process" },
      { key: "filter.lfs.required", value: "true" },
      { key: "filter.evil.clean", value: "" },
      { key: "filter.evil.smudge", value: "" },
      { key: "filter.wt.process", value: "" },
      { key: "filter.a=b.c.d.required", value: "false" },
      { key: "filter.odd.clean", value: "" },
    ]);
  });

  it("leaves other keys and Treepeek's own command line alone", () => {
    expect(
      filterDriverOverrides([
        entry("local", "core.fsmonitor"),
        entry("local", "filter.clean"),
        entry("local", "filter.x.unknownkey"),
        entry("local", "diff.evil.textconv"),
        entry("command", "filter.x.clean", ""),
        entry("global", "filter.lfs.clean"),
      ]),
    ).toEqual([]);
  });

  it("refuses a driver name it cannot pass back exactly, and too many keys", () => {
    expect(() =>
      filterDriverOverrides([{ ...entry("local", "filter.�.clean"), invalidUtf8: true }]),
    ).toThrow(GitError);
    const many = Array.from({ length: MAX_CONFIG_OVERRIDES + 1 }, (_, index) =>
      entry("local", `filter.n${index}.clean`),
    );
    expect(() => filterDriverOverrides(many)).toThrow(GitError);
    expect(filterDriverOverrides(many.slice(1))).toHaveLength(MAX_CONFIG_OVERRIDES);
  });
});

describe("configOverrideEnv", () => {
  it("numbers the overrides as GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n", () => {
    expect(configOverrideEnv([])).toEqual({});
    expect(
      configOverrideEnv([
        { key: "filter.a=b.clean", value: "" },
        { key: "filter.lfs.process", value: "git-lfs filter-process" },
      ]),
    ).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "filter.a=b.clean",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "filter.lfs.process",
      GIT_CONFIG_VALUE_1: "git-lfs filter-process",
    });
  });
});

let fx: Fixture;
let marker: string;
let trap: string;

beforeAll(() => {
  fx = fixture();
  marker = fx.outsidePath("marker.log");
  trap = fx.trapScript(marker);
});
afterEach(() => {
  rmSync(marker, { force: true });
  resetGitRuntime();
});
afterAll(() => fx.cleanup());

/** Sets `key` in a config file of the repository with plain git. */
function setConfig(file: string, key: string, value: string): void {
  gitIn(dirname(file), ["config", "--file", file, key, value]);
}

/** Adds attribute lines to the repository's `info/attributes`, for every worktree. */
function addAttributes(repo: FixtureRepo, lines: readonly string[]): void {
  const file = join(repo.commonDir, "info", "attributes");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${lines.join("\n")}\n`);
}

/** Rewrites tracked files with new content of the same size, so Git must read them again. */
function dirty(checkout: FixtureCheckout, files: Readonly<Record<string, string>>): void {
  checkout.write(files);
}

/** Every call that reads working-tree files through the conversion layer. */
async function readWorkingTree(checkout: FixtureCheckout, paths: readonly string[]) {
  const options = { signal: signal() };
  await runGit(
    checkout.path,
    ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--no-renames"],
    options,
  );
  await runGit(
    checkout.path,
    ["diff", "--raw", "-z", "--find-renames", "--abbrev=40", "HEAD"],
    options,
  );
  await runGit(checkout.path, ["diff", "--raw", "-z", "--find-renames", "--abbrev=40"], options);
  await runGit(checkout.path, ["diff", "-U3", "HEAD", "--", ...paths], options);
  const hasher = new HashObjectBatch(checkout.path);
  try {
    return await hasher.hash(paths, options);
  } finally {
    hasher.close();
  }
}

/** Counts the config listings started while `work` runs. */
async function countListings(work: () => Promise<unknown>): Promise<number> {
  let listings = 0;
  const stop = observeSpawns((event) => {
    if (event.type === "spawn" && event.args.includes("--show-scope")) listings += 1;
  });
  try {
    await work();
  } finally {
    stop();
  }
  return listings;
}

/** Plain git fires the trap: the test's setup is real. */
function expectPlainGitFires(checkout: FixtureCheckout, path: string): void {
  gitIn(checkout.path, ["hash-object", "--", path], { okExitCodes: [0, 128] });
  expect(existsSync(marker), "plain git should fire the trap").toBe(true);
}

describe("filter drivers in a repository's own config", () => {
  it("runs none of them: clean, smudge, process, odd names, worktree scope, includes", async () => {
    setTestGit();
    const repo = fx.repo("drivers").commit({
      "a.txt": "a1\n",
      "b.odd": "b1\n",
      "c.proc": "c1\n",
      "d.wt": "d1\n",
      "e.inc": "e1\n",
      "f.branch": "f1\n",
    });
    const wt = repo.worktree("drivers-wt", { from: "main", branch: "topic" });
    const local = join(repo.commonDir, "config");
    setConfig(local, "filter.evil.clean", trap);
    setConfig(local, "filter.evil.smudge", trap);
    setConfig(local, "filter.a=b.c.clean", trap);
    setConfig(local, "filter.a=b.c.required", "true");
    setConfig(local, "filter.proc.process", trap);
    setConfig(local, "extensions.worktreeConfig", "true");
    wt.git(["config", "--worktree", "filter.wtonly.clean", trap]);
    const included = fx.outsidePath("drivers-include.cfg");
    writeFileSync(included, `[filter "inc"]\n\tclean = ${trap}\n`);
    setConfig(local, "include.path", included);
    // Seen only in the worktree on `topic`: listing the main checkout would miss it.
    const branchOnly = fx.outsidePath("drivers-branch.cfg");
    writeFileSync(branchOnly, `[filter "onbranch"]\n\tclean = ${trap}\n`);
    setConfig(local, "includeIf.onbranch:topic.path", branchOnly);
    addAttributes(repo, [
      "*.txt filter=evil",
      "*.odd filter=a=b.c",
      "*.proc filter=proc",
      "*.wt filter=wtonly",
      "*.inc filter=inc",
      "*.branch filter=onbranch",
    ]);
    const paths = ["a.txt", "b.odd", "c.proc", "d.wt", "e.inc", "f.branch", "new.txt"];
    const changed = {
      "a.txt": "a2\n",
      "b.odd": "b2\n",
      "c.proc": "c2\n",
      "d.wt": "d2\n",
      "e.inc": "e2\n",
      "f.branch": "f2\n",
      "new.txt": "new\n",
    };
    for (const checkout of [repo, wt]) {
      dirty(checkout, changed);
      const hashes = await readWorkingTree(checkout, paths);
      // Without filters each file hashes as its own bytes.
      for (const path of paths) {
        expect(hashes.get(path), path).toBe(
          gitIn(checkout.path, ["hash-object", "--no-filters", "--", path]).trim(),
        );
      }
    }
    expect(existsSync(marker)).toBe(false);
    expectPlainGitFires(wt, "f.branch");
  });

  it("keeps the user's own drivers working, even when the repository redefines one", async () => {
    const globalConfig = fx.outsidePath("global.gitconfig");
    const trusted = fx.outsidePath("trusted.log");
    const upper = fx.outsidePath("upper.sh");
    writeFileSync(upper, `#!/bin/sh\necho clean >> '${trusted}'\ntr a-z A-Z\n`, { mode: 0o755 });
    writeFileSync(globalConfig, `[filter "lfsish"]\n\tclean = ${upper}\n`);
    setTestGit({ GIT_CONFIG_GLOBAL: globalConfig });
    try {
      const repo = fx.repo("trusted").commit({ "x.up": "lower\n" });
      setConfig(join(repo.commonDir, "config"), "filter.lfsish.clean", trap);
      setConfig(join(repo.commonDir, "config"), "filter.lfsish.smudge", trap);
      addAttributes(repo, ["*.up filter=lfsish"]);
      dirty(repo, { "x.up": "other\n" });
      const hashes = await readWorkingTree(repo, ["x.up"]);
      expect(hashes.get("x.up")).toBe(
        gitIn(repo.path, ["hash-object", "--stdin"], { input: "OTHER\n" }).trim(),
      );
      expect(existsSync(trusted)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(trusted, { force: true });
    }
  });

  it("lists a folder's config once, and again when the config or an include changes", async () => {
    setTestGit();
    const repo = fx.repo("cached").commit({ "a.txt": "a1\n", "b.txt": "b1\n" });
    const included = fx.outsidePath("cached-include.cfg");
    writeFileSync(included, "");
    setConfig(join(repo.commonDir, "config"), "include.path", included);
    addAttributes(repo, ["a.txt filter=late", "b.txt filter=later"]);
    const status = () =>
      runGit(repo.path, ["status", "--porcelain=v2", "-z", "--branch"], { signal: signal() });

    expect(await countListings(status)).toBe(1);
    expect(await countListings(status)).toBe(0);

    setConfig(join(repo.commonDir, "config"), "filter.late.clean", trap);
    dirty(repo, { "a.txt": "a2\n" });
    expect(await countListings(status)).toBe(1);
    expect(await countListings(status)).toBe(0);

    writeFileSync(included, `[filter "later"]\n\tclean = ${trap}\n`);
    dirty(repo, { "b.txt": "b2\n" });
    expect(await countListings(status)).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expectPlainGitFires(repo, "b.txt");
  });

  it("follows HEAD for onbranch includes, and never keeps a listing it cannot follow", async () => {
    setTestGit();
    const repo = fx.repo("branchy").commit({ "a.txt": "a1\n" });
    repo.git(["branch", "other"]);
    const local = join(repo.commonDir, "config");
    const branchOnly = fx.outsidePath("branchy.cfg");
    writeFileSync(branchOnly, `[filter "onother"]\n\tclean = ${trap}\n`);
    setConfig(local, "includeIf.onbranch:other.path", branchOnly);
    addAttributes(repo, ["* filter=onother"]);
    const status = () =>
      runGit(repo.path, ["status", "--porcelain=v2", "-z", "--branch"], { signal: signal() });
    expect(await countListings(status)).toBe(1);
    repo.git(["-c", "filter.onother.clean=", "switch", "--quiet", "other"]);
    dirty(repo, { "a.txt": "a2\n" });
    expect(await countListings(status)).toBe(1);
    expect(existsSync(marker)).toBe(false);

    setConfig(local, "include.path", "%(prefix)/etc/nothing.cfg");
    expect(await countListings(status)).toBe(1);
    expect(await countListings(status)).toBe(1);
  });

  it("starts a batch process again when the repository's drivers change under it", async () => {
    setTestGit();
    const repo = fx.repo("batchy").commit({ "a.txt": "a1\n" });
    const hasher = new HashObjectBatch(repo.path);
    try {
      await hasher.hash(["a.txt"], { signal: signal() });
      const first = hasher.pid;
      setConfig(join(repo.commonDir, "config"), "filter.added.clean", trap);
      addAttributes(repo, ["* filter=added"]);
      dirty(repo, { "a.txt": "a2\n" });
      const hashes = await hasher.hash(["a.txt"], { signal: signal() });
      expect(hasher.pid).not.toBeNull();
      expect(hasher.pid).not.toBe(first);
      expect(hashes.get("a.txt")).toBe(
        gitIn(repo.path, ["hash-object", "--no-filters", "--", "a.txt"]).trim(),
      );
    } finally {
      hasher.close();
    }
    expect(existsSync(marker)).toBe(false);
    expectPlainGitFires(repo, "a.txt");
  });

  it("refuses to run git where a driver name cannot be switched off", async () => {
    setTestGit();
    const repo = fx.repo("refused").commit({ "a.txt": "a1\n" });
    appendFileSync(
      join(repo.commonDir, "config"),
      Buffer.concat([
        Buffer.from('[filter "'),
        Buffer.from([0xff]),
        Buffer.from(`"]\n\tclean = ${trap}\n`),
      ]),
    );
    addAttributes(repo, []);
    appendFileSync(
      join(repo.commonDir, "info", "attributes"),
      Buffer.concat([Buffer.from("* filter="), Buffer.from([0xff]), Buffer.from("\n")]),
    );
    dirty(repo, { "a.txt": "a2\n" });
    await expect(
      runGit(repo.path, ["status", "--porcelain=v2", "-z"], { signal: signal() }),
    ).rejects.toMatchObject({ code: "internal", message: expect.stringMatching(/UTF-8/) });
    const hasher = new HashObjectBatch(repo.path);
    try {
      await expect(hasher.hash(["a.txt"], { signal: signal() })).rejects.toBeInstanceOf(GitError);
    } finally {
      hasher.close();
    }
    expect(existsSync(marker)).toBe(false);
    expectPlainGitFires(repo, "a.txt");
  });
});
