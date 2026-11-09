import { describe, expect, it } from "vitest";
import { GIT_ENV_OVERRIDES, gitEnv, gitEnvForLoginPath } from "../../../../src/core/git/env";

describe("gitEnv", () => {
  it("applies the design's table over the login environment", () => {
    const env = gitEnv({ HOME: "/Users/x", PATH: "/usr/bin", PAGER: "less", LC_ALL: "de_DE" });
    expect(env).toMatchObject({
      HOME: "/Users/x",
      PATH: "/usr/bin",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      LC_ALL: "C",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_NO_LAZY_FETCH: "1",
    });
    expect(env).not.toHaveProperty("GIT_CONFIG_NOSYSTEM");
  });

  it("drops GIT_ variables that redirect git or run programs, keeping config locations", () => {
    const env = gitEnv({
      GIT_DIR: "/tmp/other/.git",
      GIT_WORK_TREE: "/tmp/other",
      GIT_INDEX_FILE: "/tmp/index",
      GIT_EXTERNAL_DIFF: "/tmp/evil",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/tmp/evil'",
      GIT_CONFIG_COUNT: "1",
      GIT_TRACE: "/tmp/trace",
      GIT_CONFIG_GLOBAL: "/Users/x/.config/git/config",
      GIT_CONFIG_SYSTEM: "/etc/gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_EXTERNAL_DIFF",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_TRACE",
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    expect(env.GIT_CONFIG_GLOBAL).toBe("/Users/x/.config/git/config");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/etc/gitconfig");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("puts the login PATH in place of the process's", () => {
    expect(gitEnvForLoginPath("/opt/homebrew/bin:/usr/bin", { PATH: "/usr/bin" }).PATH).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
    expect(gitEnvForLoginPath(null, { PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
    expect(Object.isFrozen(GIT_ENV_OVERRIDES)).toBe(true);
  });
});
