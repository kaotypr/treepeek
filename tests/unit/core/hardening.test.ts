import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComparisonResult,
  type FileChange,
  LISTABLE_COMPARISON_KINDS,
  type ListableComparisonKind,
} from "../../../src/shared/domain/compare";
import type { FileDiff } from "../../../src/shared/domain/diff";
import type { Result } from "../../../src/shared/ipc";
import { resetGitRuntime, setTestGit } from "../../support/core-git";
import { tempStore } from "../../support/core-scan";
import { type Client, type Harness, harness } from "../../support/core-session";
import { gitIn } from "../../support/git";
import {
  DEFAULT_MALICIOUS_VECTORS,
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../support/git-fixture";

/**
 * The git-service design's hardening check: a repository whose own config points
 * `core.fsmonitor`, `diff.external`, a textconv driver, a diff command, `core.pager`,
 * `gpg.program` (for signed commits) and a filter driver at a script that writes a marker
 * file. A scan, every comparison kind, and `diff.file` on every file those comparisons
 * list (text, untracked, binary, a type change, a path back on disk) must leave no marker.
 * Then the inputs a window could forge: refs that look like options, `../` paths, and
 * symlinks that point out of the checkout.
 */

const LONG = Array.from({ length: 12 }, (_, i) => `back on disk ${i}\n`).join("");
const BINARY_1 = new Uint8Array([0, 1, 2, 3, 0, 255, 10]);
const BINARY_2 = new Uint8Array([0, 9, 9, 9, 0, 255, 10]);

let fx: Fixture;
let marker: string;
let pwned: string;
let repo: FixtureRepo;
let topic: FixtureCheckout;
let created: Harness;
let client: Client;
let store: ReturnType<typeof tempStore>;
let requests = 0;

beforeAll(async () => {
  setTestGit();
  fx = fixture();
  marker = fx.outsidePath("marker.log");
  pwned = fx.outsidePath("pwned.txt");
  repo = fx.repo("trapped").commit({
    "a.txt": "a1\n",
    "b.txt": "b1\n",
    "c.txt": "c1\n",
    "bin.dat": BINARY_1,
    "gone.txt": "gone\n",
    "type.txt": "a file\n",
    "back.txt": LONG,
  });
  repo.git(["switch", "--quiet", "-c", "next"], { records: true });
  repo.commit({ "b.txt": "b2\n" });
  repo.git(["switch", "--quiet", "main"], { records: true });
  topic = repo.worktree("trapped-topic", { from: "next", branch: "topic" });
  topic.commit({
    "c.txt": "c2\n",
    "bin.dat": BINARY_2,
    "gone.txt": null,
    "type.txt": { symlink: "a.txt" },
  });
  topic.git(["branch", "--quiet", "--set-upstream-to=next"]);
  // Every trap, the filter driver included, in the repository's own config.
  repo.maliciousConfig(marker, { vectors: [...DEFAULT_MALICIOUS_VECTORS, "filter"] });
  topic.signedCommit();
  // Same-size edits, so Git must read the files through the filter to compare them.
  topic.write({ "a.txt": "a3\n", "b.txt": "b3\n" }).stage(["b.txt"]);
  topic.write({ "c.txt": "c3\n", "new.txt": "new\n", "new.bin": BINARY_1 });
  topic.git(["rm", "--quiet", "--cached", "--", "back.txt"]);
  topic.write({ "back.txt": `${LONG}edited\n` });
  writeFileSync(fx.outsidePath("secret.txt"), "outside\n");
  symlinkSync(fx.outsidePath("secret.txt"), join(topic.path, "leak"));
  symlinkSync(fx.outside, join(topic.path, "leak-dir"));
  repo.write({ "a.txt": "a4\n", "u.txt": "u\n" });

  store = tempStore();
  created = harness(() => store.store);
  client = created.open(1).client;
  await client.call("session.open", { scanRoots: [fx.root] });
  await client.call("scan.start", { requestId: "scan" });
  await client.waitForEvent("scan.done");
});
afterAll(() => {
  created.dispose();
  store.dispose();
  fx.cleanup();
  resetGitRuntime();
});

function request(kind: ListableComparisonKind): { kind: ListableComparisonKind; ref?: string } {
  return kind === "base" ? { kind, ref: "main" } : { kind };
}

function diffFile(
  checkout: FixtureCheckout,
  comparison: { kind: ListableComparisonKind; ref?: string; startOverride?: string },
  path: string,
  category?: FileChange["category"],
): Promise<Result<FileDiff>> {
  requests += 1;
  return client.call<FileDiff>("diff.file", {
    requestId: `diff-${requests}`,
    checkoutPath: checkout.path,
    comparison,
    path,
    ...(category === undefined ? {} : { category }),
  });
}

describe("a repository whose own config tries to run programs", () => {
  it("runs none of them: a scan, every comparison kind, and diff.file on every listed file", async () => {
    const diffs = new Map<string, FileDiff>();
    for (const checkout of [topic, repo]) {
      for (const kind of LISTABLE_COMPARISON_KINDS) {
        const listed = await client.call<ComparisonResult>("comparison.list", {
          checkoutPath: checkout.path,
          ...request(kind),
        });
        if (!listed.ok) {
          // The main checkout has no upstream and no direct previous checkout.
          expect(checkout, `${kind}: ${listed.error.message}`).toBe(repo);
          continue;
        }
        for (const file of listed.value.files) {
          const result = await diffFile(checkout, request(kind), file.path, file.category);
          const what = `${checkout === topic ? "topic" : "main"} ${kind} ${file.category ?? ""} ${file.path}`;
          if (file.path === "leak" || file.path === "leak-dir") {
            expect(result, what).toMatchObject({ ok: false, error: { code: "notInScan" } });
            continue;
          }
          if (!result.ok) throw new Error(`${what}: ${result.error.code} ${result.error.message}`);
          diffs.set(what, result.value);
        }
      }
    }
    // The cases the design names: a text file, an untracked file, a binary file.
    expect(diffs.get("topic review  a.txt")).toMatchObject({ binary: false, right: "a3\n" });
    expect(diffs.get("topic working untracked new.txt")).toMatchObject({
      status: "untracked",
      right: "new\n",
    });
    expect(diffs.get("topic review  new.bin")).toMatchObject({ binary: true });
    expect(diffs.get("topic worktree  bin.dat")).toMatchObject({ binary: true });
    expect(diffs.get("topic review  type.txt")).toMatchObject({ status: "typeChanged" });
    expect(diffs.get("topic review  back.txt")).toMatchObject({ right: `${LONG}edited\n` });
    expect(diffs.size).toBeGreaterThan(20);
    expect(existsSync(marker)).toBe(false);

    // The traps are armed: plain git sets them off.
    gitIn(topic.path, ["status", "--porcelain"]);
    expect(existsSync(marker), "plain git status should fire the traps").toBe(true);
    rmSync(marker, { force: true });
    gitIn(topic.path, ["diff", "next", "--", "c.txt"]);
    expect(existsSync(marker), "plain git diff should fire the traps").toBe(true);
    rmSync(marker, { force: true });
  });
});

describe("inputs a window could forge", () => {
  it("refuses refs that look like options before git runs", async () => {
    for (const ref of ["-x", `--output=${pwned}`, "-h", `--exec=touch ${pwned}`]) {
      expect(
        await client.call("comparison.list", { checkoutPath: topic.path, kind: "base", ref }),
        ref,
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(
        await client.call("comparison.list", {
          checkoutPath: topic.path,
          kind: "review",
          startOverride: ref,
        }),
        ref,
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(await diffFile(topic, { kind: "base", ref }, "c.txt"), ref).toMatchObject({
        ok: false,
        error: { code: "invalidRequest" },
      });
      expect(
        await client.call("start.override", { checkoutPath: topic.path, commit: ref }),
        ref,
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    }
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses ../ paths with notInScan", async () => {
    for (const path of ["../trapped/a.txt", "../../outside/secret.txt", "a/../../x", ".."]) {
      expect(await diffFile(topic, { kind: "review" }, path), path).toMatchObject({
        ok: false,
        error: { code: "notInScan" },
      });
    }
    const outsideRoot = join(fx.root, "..", fx.outside.split("/").at(-1) ?? "");
    for (const checkoutPath of [`${fx.root}/..`, outsideRoot, `${topic.path}/../..`]) {
      expect(
        await client.call("comparison.list", { checkoutPath, kind: "review" }),
        checkoutPath,
      ).toMatchObject({ ok: false, error: { code: "notInScan" } });
      expect(
        await client.call("start.override", { checkoutPath, commit: null }),
        checkoutPath,
      ).toMatchObject({ ok: false, error: { code: "notInScan" } });
      expect(
        await client.call("diff.file", {
          requestId: `up-${checkoutPath}`,
          checkoutPath,
          comparison: { kind: "review" },
          path: "a.txt",
        }),
        checkoutPath,
      ).toMatchObject({ ok: false, error: { code: "notInScan" } });
    }
  });

  it("refuses symlinks that point out of the checkout with notInScan", async () => {
    for (const path of ["leak", "leak-dir/secret.txt", "leak-dir"]) {
      for (const comparison of [{ kind: "review" }, { kind: "worktree" }] as const) {
        expect(await diffFile(topic, comparison, path), path).toMatchObject({
          ok: false,
          error: { code: "notInScan" },
        });
      }
    }
    expect(await diffFile(topic, { kind: "working" }, "leak", "untracked")).toMatchObject({
      ok: false,
      error: { code: "notInScan" },
    });
    // A checkout path that is a link out of the scan is refused as well.
    const link = fx.path("link-out");
    symlinkSync(fx.outside, link);
    expect(
      await client.call("comparison.list", { checkoutPath: link, kind: "review" }),
    ).toMatchObject({ ok: false, error: { code: "notInScan" } });
  });
});
