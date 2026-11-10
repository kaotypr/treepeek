import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gitIn } from "../../../support/git";
import {
  DEFAULT_MALICIOUS_VECTORS,
  type Fixture,
  fixture,
  removeFixtures,
} from "../../../support/git-fixture";

/** `git worktree list --porcelain` paths, the way a person would run it. */
function listedPaths(cwd: string): string[] {
  return gitIn(cwd, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function reflogDates(cwd: string): string[] {
  const out = gitIn(cwd, ["reflog", "show", "--date=iso-strict", "--format=%gd", "HEAD"], {
    okExitCodes: [0, 128],
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => utc(line.slice(line.indexOf("{") + 1, -1)));
}

/** Git prints UTC as `+00:00` or, in newer versions, `Z`. */
function utc(date: string): string {
  return new Date(date).toISOString().replace(".000Z", "Z");
}

let fx: Fixture;
beforeAll(() => {
  fx = fixture({ start: "2025-02-01T08:00:00Z", stepSeconds: 60 });
});
afterAll(() => removeFixtures());

describe("fixture", () => {
  it("builds a main checkout and linked worktrees, including one from another's branch", () => {
    const app = fx.repo("app").commit({ "README.md": "hello\n" });
    const a = app.worktree("work/feature-a", { from: "main" });
    a.commit({ "a.txt": "a\n" });
    const b = app.worktree("work/feature-b", { from: "feature-a", branch: "feature-b" });
    expect(b.head()).toBe(a.head());
    expect(gitIn(b.path, ["branch", "--show-current"]).trim()).toBe("feature-b");
    expect(listedPaths(app.path)).toEqual([app.path, a.path, b.path]);
    expect(app.commonDir).toBe(join(app.path, ".git"));
    expect(app.worktrees).toEqual([a, b]);
  });

  it("dates every change one step after the previous, so timeline order is build order", () => {
    const clock = fixture({ start: "2025-05-01T00:00:00Z", stepSeconds: 120 });
    try {
      const repo = clock.repo("r").commit({ "a.txt": "1\n" });
      expect(clock.now()).toBe("2025-05-01T00:02:00Z");
      clock.advance(3600);
      const wt = repo.worktree("r-wt", { from: "main" });
      expect(reflogDates(repo.path)).toEqual(["2025-05-01T00:00:00Z"]);
      // `worktree add -b` may write more than one HEAD entry; all carry the same time.
      expect(new Set(reflogDates(wt.path))).toEqual(new Set(["2025-05-01T01:02:00Z"]));
      expect(utc(gitIn(repo.path, ["log", "-1", "--format=%cI"]).trim())).toBe(
        "2025-05-01T00:00:00Z",
      );
    } finally {
      clock.cleanup();
    }
    expect(existsSync(clock.root)).toBe(false);
    expect(existsSync(clock.outside)).toBe(false);
  });

  it("detaches HEAD, in the main checkout or a new worktree", () => {
    const repo = fx.repo("detach").commit({ "a.txt": "1\n" }).commit({ "a.txt": "2\n" });
    const wt = repo.worktree("detach-wt", { from: "HEAD~1", detach: true });
    expect(gitIn(wt.path, ["branch", "--show-current"]).trim()).toBe("");
    expect(wt.head()).toBe(repo.rev("HEAD~1"));
    repo.detach("HEAD~1");
    expect(gitIn(repo.path, ["branch", "--show-current"]).trim()).toBe("");
  });

  it("turns a repository bare, named <name>.git, with worktrees", () => {
    const svc = fx.repo("svc").commit({ "a.txt": "1\n" }).bare();
    expect(svc.isBare).toBe(true);
    expect(svc.commonDir).toBe(fx.path("svc.git"));
    expect(existsSync(fx.path("svc"))).toBe(false);
    expect(() => svc.path).toThrow(/bare/);
    expect(gitIn(svc.commonDir, ["config", "core.bare"]).trim()).toBe("true");
    const main = svc.worktree("svc-main", { from: "main", branch: "work" });
    expect(readFileSync(join(main.path, "a.txt"), "utf8")).toBe("1\n");
    expect(listedPaths(main.path)).toEqual([svc.commonDir, main.path]);
  });

  it("leaves stale .git files that Git's worktree list does not include", () => {
    const repo = fx.repo("stale").commit({ "a.txt": "1\n" });
    repo.staleGitFile("stale-dangling").staleGitFile("stale-copied", { kind: "copied" });
    const dangling = fx.path("stale-dangling");
    const copied = fx.path("stale-copied");
    expect(statSync(join(dangling, ".git")).isFile()).toBe(true);
    // Git 2.56 words it "gitfile does not point to a valid repository".
    expect(() => gitIn(dangling, ["rev-parse", "--show-toplevel"])).toThrow(
      /not a git repository|gitfile does not point to a valid repository/,
    );
    expect(gitIn(copied, ["rev-parse", "--show-toplevel"]).trim()).toBe(copied);
    const listed = listedPaths(repo.path);
    expect(listed).not.toContain(dangling);
    expect(listed).not.toContain(copied);
    // The copy's original lives outside the scan root.
    expect(listed.filter((path) => path.startsWith(fx.root))).toEqual([repo.path]);
  });

  it("expires the reflog of every worktree", () => {
    const repo = fx.repo("expire").commit({ "a.txt": "1\n" }).commit({ "a.txt": "2\n" });
    const wt = repo.worktree("expire-wt", { from: "main" });
    expect(reflogDates(repo.path)).toHaveLength(2);
    repo.expireReflog();
    expect(reflogDates(repo.path)).toEqual([]);
    expect(reflogDates(wt.path)).toEqual([]);
    // HEAD still resolves; only the history of where it was is gone.
    expect(repo.head()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("writes modes, symlinks, binary content, deletions and awkward names", () => {
    const repo = fx.repo("files").commit({
      "run.sh": { content: "echo hi\n", executable: true },
      link: { symlink: "target.txt" },
      "data.bin": new Uint8Array([0, 159, 146, 150]),
      "no-newline.txt": "last line",
      "with space é/日本\nnewline.txt": "x\n",
      "gone.txt": "bye\n",
    });
    expect(statSync(join(repo.path, "run.sh")).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(repo.path, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repo.path, "link"))).toBe("target.txt");
    expect([...readFileSync(join(repo.path, "data.bin"))]).toEqual([0, 159, 146, 150]);
    expect(readFileSync(join(repo.path, "no-newline.txt"), "utf8")).toBe("last line");
    repo.commit({ "gone.txt": null }).rename("no-newline.txt", "moved/no-newline.txt");
    const tracked = gitIn(repo.path, ["ls-files", "-z"]).split("\0").filter(Boolean);
    expect(tracked).toContain("with space é/日本\nnewline.txt");
    expect(tracked).toContain("moved/no-newline.txt");
    expect(tracked).not.toContain("gone.txt");
    expect(gitIn(repo.path, ["ls-files", "-s", "run.sh"])).toMatch(/^100755 /);
    expect(gitIn(repo.path, ["ls-files", "-s", "link"])).toMatch(/^120000 /);
  });

  it("stages without committing, and makes a signed commit", () => {
    const repo = fx.repo("stage").commit({ "a.txt": "1\n", "b.txt": "1\n" });
    repo.write({ "a.txt": "2\n", "b.txt": "2\n" }).stage(["a.txt"]);
    expect(gitIn(repo.path, ["diff", "--cached", "--name-only"]).trim()).toBe("a.txt");
    expect(gitIn(repo.path, ["diff", "--name-only"]).trim()).toBe("b.txt");
    const before = repo.head();
    repo.signedCommit();
    expect(gitIn(repo.path, ["cat-file", "commit", "HEAD"])).toContain(
      "gpgsig -----BEGIN PGP SIGNATURE-----",
    );
    expect(repo.rev("HEAD~1")).toBe(before);
  });

  describe("maliciousConfig", () => {
    const marker = () => fx.outsidePath("marker.log");
    afterEach(() => rmSync(marker(), { force: true }));

    it("arms every default trap without firing it while the fixture builds", () => {
      const repo = fx.repo("trap").commit({ "a.txt": "1\n" });
      repo.maliciousConfig(marker());
      const wt = repo.worktree("trap-wt", { from: "main" });
      wt.commit({ "b.txt": "1\n" });
      repo.write({ "a.txt": "2\n" }).stage().commit().signedCommit();
      expect(existsSync(marker())).toBe(false);
      expect(DEFAULT_MALICIOUS_VECTORS).not.toContain("filter");

      const config = gitIn(repo.path, [
        "config",
        "--file",
        join(repo.commonDir, "config"),
        "--list",
      ]);
      for (const key of [
        "core.fsmonitor=",
        "diff.external=",
        "core.pager=",
        "diff.evil.textconv=",
        "diff.evil.command=",
        "log.showsignature=true",
        "gpg.program=",
      ]) {
        expect(config, key).toContain(key);
      }
      expect(readFileSync(join(repo.commonDir, "info", "attributes"), "utf8")).toBe(
        "* diff=evil\n",
      );
    });

    it("fires when plain git runs: the traps are real", () => {
      const repo = fx.repo("armed").commit({ "a.txt": "1\n" });
      repo.maliciousConfig(marker()).signedCommit();
      repo.write({ "a.txt": "2\n" });
      gitIn(repo.path, ["diff"]);
      gitIn(repo.path, ["log", "-1"]);
      const fired = readFileSync(marker(), "utf8");
      // diff.external runs with seven arguments, the path first; gpg verifies the signature.
      expect(fired).toMatch(/trap-\d+\.sh a\.txt /);
      expect(fired).toMatch(/--verify/);
    });

    it("arms the filter trap only when asked", () => {
      const repo = fx.repo("filtered").commit({ "a.txt": "1\n" });
      repo.maliciousConfig(marker(), { vectors: ["filter"] });
      repo.write({ "a.txt": "2\n" }).stage().commit();
      expect(existsSync(marker())).toBe(false);
      repo.write({ "a.txt": "3\n" });
      gitIn(repo.path, ["status", "--porcelain"]);
      expect(readFileSync(marker(), "utf8")).toMatch(/trap-\d+\.sh/);
    });
  });
});
