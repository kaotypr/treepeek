import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLoginEnv, parseMarkedEnv } from "../../../src/main/shell-env";
import { createLogger, type Logger } from "../../../src/shared/log";

let dir: string;

/** A fake login shell: runs the `-c` command with sh after doing `before`. */
function shell(name: string, before: string): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\n${before}\n[ "$1" = "-l" ] && [ "$2" = "-c" ] || exit 64\nexec /bin/sh -c "$3"\n`,
    {
      mode: 0o755,
    },
  );
  return file;
}

function memoryLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ scope: "test", sink: (line) => lines.push(line) }), lines };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-shell-env-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = { PATH: "/usr/bin:/bin", HOME: "/Users/test", SECRET_TOKEN: "s3cret" };

describe("loadLoginEnv", () => {
  it("reads the environment a login shell builds, ignoring what profiles print", async () => {
    const login = shell(
      "profile.sh",
      [
        'echo "Welcome back!"',
        "export PATH=/opt/homebrew/bin:$PATH",
        "export MULTILINE='first line",
        "second line'",
        "export WITH_EQUALS='a=b=c'",
      ].join("\n"),
    );
    const { log, lines } = memoryLog();
    const env = await loadLoginEnv({ shell: login, env: base, log });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/test");
    expect(env.MULTILINE).toBe("first line\nsecond line");
    expect(env.WITH_EQUALS).toBe("a=b=c");
    expect(lines.join("")).toContain("read the login shell environment");
    expect(lines.join("")).not.toContain("s3cret");
    expect(lines.join("")).not.toContain("/opt/homebrew/bin");
  });

  it("falls back to the app's environment, with a warning, when the shell hangs", async () => {
    const hang = shell("hang.sh", "exec sleep 30");
    const { log, lines } = memoryLog();
    const started = Date.now();
    const env = await loadLoginEnv({ shell: hang, env: base, log, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(env).toEqual(base);
    expect(lines.join("")).toMatch(/WARN.*could not read the login shell environment/);
    expect(lines.join("")).not.toContain("s3cret");
  });

  it("falls back when the shell fails, is missing or prints no environment", async () => {
    for (const login of [
      shell("fails.sh", "exit 3"),
      join(dir, "missing-shell"),
      shell("silent.sh", "exit 0"),
      "relative/shell",
    ]) {
      expect(await loadLoginEnv({ shell: login, env: base }), login).toEqual(base);
    }
  });
});

describe("parseMarkedEnv", () => {
  it("reads only between the markers and needs a PATH", () => {
    const marker = "__M__";
    expect(parseMarkedEnv(`noise${marker}PATH=/bin\0A=1\0${marker}tail`, marker)).toEqual({
      PATH: "/bin",
      A: "1",
    });
    expect(parseMarkedEnv(`${marker}A=1\0${marker}`, marker)).toBeNull();
    expect(parseMarkedEnv("PATH=/bin", marker)).toBeNull();
  });
});
