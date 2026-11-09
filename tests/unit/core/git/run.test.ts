import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitError } from "../../../../src/core/git/errors";
import { FORBIDDEN } from "../../../../src/core/git/guard";
import { observeSpawns, type SpawnEvent, spawnCount } from "../../../../src/core/git/process";
import { gitArgs, HARDENING_CONFIG, runGit } from "../../../../src/core/git/run";
import { setGitBinary } from "../../../../src/core/git/runtime";
import { GIT_CONCURRENCY } from "../../../../src/shared/constants";
import { resetGitRuntime, setFakeGit, setTestGit } from "../../../support/core-git";
import {
  commitAll,
  gitIn,
  makeTempRepo,
  removeTempRepos,
  type TempRepo,
  writeRepoFile,
} from "../../../support/git";
import { fixture } from "../../../support/git-fixture";

let scripts: string;
let repo: TempRepo;
let bigBlob: string;

function script(name: string, body: string): string {
  const file = join(scripts, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Collects spawn and exit events until `stop()`. */
function recordSpawns() {
  const events: SpawnEvent[] = [];
  const stop = observeSpawns((event) => events.push(event));
  return { events, stop };
}

const signal = () => new AbortController().signal;

beforeAll(() => {
  scripts = mkdtempSync(join(tmpdir(), "treepeek-fake-git-"));
  repo = makeTempRepo();
  writeRepoFile(repo, "small.txt", "hello\n");
  writeRepoFile(repo, "big.txt", "x".repeat(300_000));
  commitAll(repo, "one");
  bigBlob = gitIn(repo, ["rev-parse", "HEAD:big.txt"]).trim();
});
afterEach(() => resetGitRuntime());
afterAll(() => {
  removeTempRepos();
  rmSync(scripts, { recursive: true, force: true });
});

describe("gitArgs", () => {
  it("puts -C and the hardening config before the subcommand", () => {
    expect(gitArgs("/repo", ["status", "--porcelain=v2"])).toEqual([
      "-C",
      "/repo",
      ...HARDENING_CONFIG.flatMap((entry) => ["-c", entry]),
      "status",
      "--porcelain=v2",
    ]);
    expect(HARDENING_CONFIG).toEqual([
      "core.fsmonitor=false",
      "core.pager=cat",
      "color.ui=false",
      "diff.external=",
      "core.quotePath=false",
      "log.showSignature=false",
      "protocol.allow=never",
    ]);
  });

  it("pins external diff, textconv, colour and prefixes right after `diff`", () => {
    const args = gitArgs("/repo", ["diff", "--raw", "HEAD", "--", "a"]);
    const at = args.indexOf("diff");
    expect(args.slice(at)).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--raw",
      "HEAD",
      "--",
      "a",
    ]);
  });

  it("refuses a relative folder", () => {
    expect(() => gitArgs("repo", ["status"])).toThrow(GitError);
  });
});

describe("runGit", () => {
  it("runs the real git and returns stdout as bytes", async () => {
    setTestGit();
    const output = await runGit(repo.path, ["rev-parse", "--show-toplevel"], { signal: signal() });
    expect(output.code).toBe(0);
    expect(output.stdout.toString("utf8")).toBe(`${repo.path}\n`);
  });

  it("writes stdin and closes it", async () => {
    setTestGit();
    const output = await runGit(repo.path, ["hash-object", "--stdin"], {
      signal: signal(),
      stdin: "hello\n",
    });
    expect(output.stdout.toString("utf8").trim()).toBe(
      gitIn(repo, ["rev-parse", "HEAD:small.txt"]).trim(),
    );
  });

  it("accepts the exit codes the caller allows", async () => {
    setTestGit();
    const output = await runGit(repo.path, ["merge-base", "--is-ancestor", "HEAD", "HEAD~0"], {
      signal: signal(),
      okExitCodes: [0, 1],
    });
    expect(output.code).toBe(0);
    await expect(
      runGit(repo.path, ["diff", "--quiet", "HEAD"], { signal: signal() }),
    ).resolves.toMatchObject({ code: 0 });
  });

  it("refuses every forbidden subcommand before starting a process", async () => {
    setTestGit();
    const before = spawnCount();
    for (const entry of FORBIDDEN) {
      await expect(
        runGit(repo.path, entry.split(" "), { signal: signal() }),
        entry,
      ).rejects.toBeInstanceOf(GitError);
    }
    expect(spawnCount()).toBe(before);
  });

  it("kills a call that passes its byte cap and returns outputTooLarge", async () => {
    setTestGit();
    const { events, stop } = recordSpawns();
    try {
      await expect(
        runGit(repo.path, ["cat-file", "blob", bigBlob], { signal: signal(), maxBytes: 10_000 }),
      ).rejects.toMatchObject({ code: "outputTooLarge" });
    } finally {
      stop();
    }
    const spawned = events.find((event) => event.type === "spawn");
    expect(spawned).toBeDefined();
    expect(isAlive(spawned?.pid ?? -1)).toBe(false);
    // The same call within the default cap succeeds.
    const whole = await runGit(repo.path, ["cat-file", "blob", bigBlob], { signal: signal() });
    expect(whole.stdout.length).toBe(300_000);
  });

  it("times out a hanging command and kills it", async () => {
    setFakeGit(script("hang.sh", "exec sleep 30"));
    const { events, stop } = recordSpawns();
    const started = Date.now();
    try {
      await expect(
        runGit(repo.path, ["status"], { signal: signal(), timeoutMs: 200 }),
      ).rejects.toMatchObject({ code: "timeout" });
    } finally {
      stop();
    }
    expect(Date.now() - started).toBeLessThan(3_000);
    const pid = events.find((event) => event.type === "spawn")?.pid ?? -1;
    expect(isAlive(pid)).toBe(false);
  });

  it("kills the child when the signal aborts (its pid is gone)", async () => {
    setFakeGit(script("hang-abort.sh", "exec sleep 30"));
    const controller = new AbortController();
    let pid = -1;
    const stop = observeSpawns((event) => {
      if (event.type === "spawn") {
        pid = event.pid;
        setTimeout(() => controller.abort(), 50);
      }
    });
    try {
      await expect(
        runGit(repo.path, ["status"], { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      stop();
    }
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  });

  it("also kills what the child started (its process group)", async () => {
    const childPidFile = join(scripts, "grandchild.pid");
    setFakeGit(script("spawns.sh", `sleep 30 &\necho $! > '${childPidFile}'\nwait`));
    const controller = new AbortController();
    // A script macOS has not seen before can take a while to start, so wait for the
    // grandchild to exist rather than for a fixed time.
    const abortOnceStarted = () => {
      if (existsSync(childPidFile)) controller.abort();
      else setTimeout(abortOnceStarted, 20);
    };
    const stop = observeSpawns((event) => {
      if (event.type === "spawn") abortOnceStarted();
    });
    try {
      await expect(
        runGit(repo.path, ["status"], { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      stop();
    }
    const grandchild = Number(readFileSync(childPidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(grandchild)).toBe(false);
  });

  it("never runs more than GIT_CONCURRENCY processes at once", async () => {
    setFakeGit(script("slow.sh", "sleep 0.1\necho ok"));
    let running = 0;
    let peak = 0;
    const stop = observeSpawns((event) => {
      running += event.type === "spawn" ? 1 : -1;
      peak = Math.max(peak, running);
    });
    try {
      const calls = Array.from({ length: 20 }, () =>
        runGit(repo.path, ["status"], { signal: signal() }),
      );
      const outputs = await Promise.all(calls);
      expect(outputs.every((output) => output.stdout.toString("utf8") === "ok\n")).toBe(true);
    } finally {
      stop();
    }
    expect(peak).toBe(GIT_CONCURRENCY);
  });

  it("passes the argument array and environment through without a shell", async () => {
    setFakeGit(
      script(
        "echo.sh",
        `printf '%s\\0' "$@"; printf 'LOCKS=%s;LC=%s' "$GIT_OPTIONAL_LOCKS" "$LC_ALL"`,
      ),
    );
    const output = await runGit(repo.path, ["diff", "HEAD", "--", "a file; rm -rf /", "$(x)"], {
      signal: signal(),
    });
    const [argv = "", env = ""] = output.stdout.toString("utf8").split(/\0(?=LOCKS=)/);
    expect(argv.split("\0")).toEqual([
      ...gitArgs(repo.path, ["diff", "HEAD", "--", "a file; rm -rf /", "$(x)"]),
    ]);
    expect(env).toBe("LOCKS=0;LC=C");
  });

  it("fails with gitNotFound or gitTooOld when discovery found no usable git", async () => {
    resetGitRuntime();
    await expect(runGit(repo.path, ["status"], { signal: signal() })).rejects.toMatchObject({
      code: "gitNotFound",
    });
    setGitBinary({ found: false, problem: "tooOld", detail: "Git 2.30.0 is too old" }, {});
    await expect(runGit(repo.path, ["status"], { signal: signal() })).rejects.toMatchObject({
      code: "gitTooOld",
      message: "Git 2.30.0 is too old",
    });
  });

  it("fails with gitNotFound when the binary has gone", async () => {
    setFakeGit(join(scripts, "missing-git"));
    await expect(runGit(repo.path, ["status"], { signal: signal() })).rejects.toMatchObject({
      code: "gitNotFound",
    });
  });
});

describe("runGit hardening (smoke test; the full suite comes with the scan)", () => {
  it("fires none of the default traps in a repository's own config", async () => {
    const fx = fixture();
    try {
      const marker = fx.outsidePath("marker.log");
      const trapped = fx.repo("trapped").commit({ "a.txt": "1\n" });
      const start = trapped.head();
      trapped.maliciousConfig(marker).signedCommit();
      trapped.write({ "a.txt": "2\n", "new.txt": "n\n" });
      setTestGit();
      for (const args of [
        ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--no-renames"],
        ["reflog", "show", "--date=iso-strict", "--format=%H%x09%gd", "-z", "HEAD"],
        ["diff", "--raw", "-z", "--find-renames", "--abbrev=40", start],
        ["diff", "--find-renames", "-U3", start, "--", "a.txt"],
        ["diff", "--no-index", "-U3", "--", "/dev/null", "new.txt"],
      ]) {
        await runGit(trapped.path, args, { signal: signal(), okExitCodes: [0, 1] });
        expect(existsSync(marker), args.join(" ")).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });
});
