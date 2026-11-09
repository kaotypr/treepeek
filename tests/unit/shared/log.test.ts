import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLogger,
  createRotatingFileSink,
  LOG_MAX_BYTES,
  LOG_MAX_FILES,
  REDACTED,
  redact,
} from "../../../src/shared/log";

const fs = { appendFileSync, mkdirSync, renameSync, rmSync, statSync };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-logs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("redact", () => {
  it("redacts every environment value but keeps the variable names", () => {
    const out = redact({
      cmd: "git",
      env: { HOME: "/Users/someone", GITHUB_TOKEN: "ghp_secret", PATH: "/usr/bin" },
    }) as { env: Record<string, string> };
    expect(out.env).toEqual({ HOME: REDACTED, GITHUB_TOKEN: REDACTED, PATH: REDACTED });
  });

  it("redacts secret-looking keys at any depth, and errors become plain objects", () => {
    const out = redact({
      nested: { password: "hunter2", apiKey: "k", authorization: "Bearer x" },
      list: [{ token: "t" }],
      error: new Error("failed"),
    }) as Record<string, unknown>;
    expect(out.nested).toEqual({ password: REDACTED, apiKey: REDACTED, authorization: REDACTED });
    expect(out.list).toEqual([{ token: REDACTED }]);
    expect(out.error).toMatchObject({ name: "Error", message: "failed" });
  });

  it("survives circular data", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(redact(value)).toEqual({ a: 1, self: "[circular]" });
  });
});

describe("logger", () => {
  it("writes redacted lines: environment values never reach the file", () => {
    const sink = createRotatingFileSink({ fs, join, dir, name: "main" });
    const log = createLogger({ scope: "git", sink });
    log.info("spawning git", {
      repository: "/Users/someone/code/treepeek",
      env: { GIT_ASKPASS: "/secret/helper", SSH_AUTH_SOCK: "/private/agent.sock" },
    });
    const text = readFileSync(join(dir, "main.log"), "utf8");
    expect(text).toContain("INFO [git] spawning git");
    expect(text).toContain("/Users/someone/code/treepeek");
    expect(text).not.toContain("/secret/helper");
    expect(text).not.toContain("/private/agent.sock");
    expect(text).toContain(`"GIT_ASKPASS":"${REDACTED}"`);
  });

  it("rotates at 5 MB and keeps 5 files", () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(LOG_MAX_FILES).toBe(5);
    const sink = createRotatingFileSink({ fs, join, dir, name: "core" });
    const megabyte = `${"x".repeat(1024 * 1024 - 1)}\n`;
    for (let i = 0; i < 5; i++) sink(megabyte);
    expect(statSync(join(dir, "core.log")).size).toBe(5 * 1024 * 1024);
    expect(existsSync(join(dir, "core.1.log"))).toBe(false);

    sink("next line\n");
    expect(statSync(join(dir, "core.1.log")).size).toBe(5 * 1024 * 1024);
    expect(readFileSync(join(dir, "core.log"), "utf8")).toBe("next line\n");
  });

  it("never keeps more than the configured number of files", () => {
    const sink = createRotatingFileSink({ fs, join, dir, name: "main", maxBytes: 10, maxFiles: 3 });
    for (let i = 0; i < 10; i++) sink(`line ${i} ..\n`);
    expect(existsSync(join(dir, "main.log"))).toBe(true);
    expect(existsSync(join(dir, "main.1.log"))).toBe(true);
    expect(existsSync(join(dir, "main.2.log"))).toBe(true);
    expect(existsSync(join(dir, "main.3.log"))).toBe(false);
  });

  it("continues an existing file's size after a restart", () => {
    createRotatingFileSink({ fs, join, dir, name: "main", maxBytes: 20 })("0123456789012345\n");
    const reopened = createRotatingFileSink({ fs, join, dir, name: "main", maxBytes: 20 });
    reopened("abcdef\n");
    expect(readFileSync(join(dir, "main.log"), "utf8")).toBe("abcdef\n");
    expect(readFileSync(join(dir, "main.1.log"), "utf8")).toBe("0123456789012345\n");
  });
});
