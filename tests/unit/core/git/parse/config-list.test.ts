import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitParseError } from "../../../../../src/core/git/errors";
import { parseConfigList } from "../../../../../src/core/git/parse/config-list";
import { resetGitRuntime, setTestGit } from "../../../../support/core-git";
import { type Fixture, fixture } from "../../../../support/git-fixture";
import { git } from "./helpers";

let fx: Fixture;
beforeAll(() => {
  setTestGit();
  fx = fixture();
});
afterAll(() => {
  fx.cleanup();
  resetGitRuntime();
});

const LIST = ["config", "--show-scope", "--show-origin", "--list", "-z"];

describe("parseConfigList", () => {
  it("reads scope, origin, key and value of every entry, includes and worktree config too", async () => {
    const app = fx.repo("app").commit({ "a.txt": "1\n" });
    const wt = app.worktree("app-wt", { from: "main" });
    const included = fx.outsidePath("included.cfg");
    writeFileSync(included, '[filter "inc.with=dots"]\n\tclean = run me\n[flag]\n\tbare\n');
    app.git(["config", "include.path", included]);
    app.git(["config", "extensions.worktreeConfig", "true"]);
    wt.git(["config", "--worktree", "core.multi", "line one\nline two"]);

    const entries = parseConfigList(await git(wt.path, LIST));
    const own = entries.filter((entry) => entry.scope !== "command");
    const byKey = new Map(own.map((entry) => [entry.key, entry]));
    expect(byKey.get("core.repositoryformatversion")).toMatchObject({
      scope: "local",
      origin: `file:${join(app.commonDir, "config")}`,
      value: "0",
      invalidUtf8: false,
    });
    expect(byKey.get("filter.inc.with=dots.clean")).toEqual({
      scope: "local",
      origin: `file:${included}`,
      key: "filter.inc.with=dots.clean",
      value: "run me",
      invalidUtf8: false,
    });
    expect(byKey.get("flag.bare")).toMatchObject({ value: null });
    expect(byKey.get("core.multi")).toMatchObject({
      scope: "worktree",
      value: "line one\nline two",
    });
    // The wrapper's hardening options and its filter override show up as the command line's.
    const command = entries.filter((entry) => entry.scope === "command");
    expect(command).toContainEqual(
      expect.objectContaining({ key: "core.fsmonitor", value: "false" }),
    );
    expect(command).toContainEqual(
      expect.objectContaining({ key: "filter.inc.with=dots.clean", value: "" }),
    );
  });

  it("flags an entry that is not valid UTF-8 instead of altering it silently", () => {
    const bytes = Buffer.concat([
      Buffer.from("local\0file:.git/config\0filter."),
      Buffer.from([0xff]),
      Buffer.from(".clean\nx\0local\0file:.git/config\0core.bare\nfalse\0"),
    ]);
    const [bad, good] = parseConfigList(bytes);
    expect(bad).toMatchObject({ key: "filter.�.clean", invalidUtf8: true });
    expect(good).toMatchObject({ key: "core.bare", value: "false", invalidUtf8: false });
  });

  it("reads nothing as no entries, and refuses cut-off or malformed output", () => {
    expect(parseConfigList(Buffer.alloc(0))).toEqual([]);
    for (const text of [
      "local\0file:x\0core.bare\nfalse",
      "local\0file:x\0",
      "Local Scope\0file:x\0core.bare\nfalse\0",
      "local\0file:x\0\nvalue\0",
    ]) {
      expect(() => parseConfigList(Buffer.from(text)), JSON.stringify(text)).toThrow(GitParseError);
    }
  });
});
