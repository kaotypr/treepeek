import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walk } from "../../../../src/core/scan/walk";
import { MAX_SCAN_DEPTH, SKIP_DIRS } from "../../../../src/shared/constants";

let root: string;
const live = () => new AbortController().signal;
const options = () => ({ maxDepth: MAX_SCAN_DEPTH, skip: SKIP_DIRS, signal: live() });

function folder(relative: string): string {
  const path = join(root, relative);
  mkdirSync(path, { recursive: true });
  return path;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-walk-")));
});
afterEach(() => {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("walk", () => {
  it("stops at .git markers, file or folder, and does not enter the checkout", async () => {
    mkdirSync(join(folder("a"), ".git"));
    writeFileSync(join(folder("b/c"), ".git"), "gitdir: /nowhere\n");
    mkdirSync(join(folder("a/nested"), ".git"));
    const result = await walk(root, options());
    expect(result.candidates).toEqual([join(root, "a"), join(root, "b/c")]);
    expect(result.folders.map((node) => node.relativePath)).toEqual(["", "a", "b", "b/c"]);
    expect(result.folders.find((node) => node.relativePath === "b/c")?.checkoutPath).toBe(
      join(root, "b/c"),
    );
    expect(result.folders.find((node) => node.relativePath === "b")?.checkoutPath).toBeNull();
  });

  it("reads folders at the depth limit but lists nothing deeper", async () => {
    mkdirSync(join(folder("1/2/3/4/5/6/7"), ".git"));
    mkdirSync(join(folder("x/2/3/4/5/6/7/8"), ".git"));
    const result = await walk(root, options());
    expect(result.candidates).toEqual([join(root, "1/2/3/4/5/6/7")]);
    const deepest = Math.max(...result.folders.map((node) => node.depth));
    expect(deepest).toBe(7);
    expect(result.folders.map((node) => node.relativePath)).not.toContain("x/2/3/4/5/6/7/8");
  });

  it("skips listed names and never follows symlinks", async () => {
    mkdirSync(join(folder("node_modules/pkg"), ".git"));
    mkdirSync(join(folder("dist/out"), ".git"));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-walk-elsewhere-")));
    try {
      mkdirSync(join(elsewhere, "repo/.git"), { recursive: true });
      symlinkSync(join(elsewhere, "repo"), join(root, "linked"));
      symlinkSync(root, join(root, "loop"));
      const result = await walk(root, options());
      expect(result.candidates).toEqual([]);
      expect(result.folders.map((node) => node.relativePath)).toEqual([""]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("lists a bare repository's folder but does not enter it", async () => {
    const bare = folder("svc.git");
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(bare, "objects/ab"), { recursive: true });
    mkdirSync(join(bare, "refs/heads"), { recursive: true });
    const result = await walk(root, options());
    expect(result.folders.map((node) => node.relativePath)).toEqual(["", "svc.git"]);
  });

  it("lists an unreadable folder and moves on", async () => {
    const locked = folder("locked");
    mkdirSync(join(locked, "inside"));
    folder("open");
    chmodSync(locked, 0o000);
    try {
      const result = await walk(root, options());
      expect(result.folders.map((node) => node.relativePath)).toEqual(["", "locked", "open"]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("treats a root with a .git marker as the only candidate", async () => {
    mkdirSync(join(root, ".git"));
    folder("src");
    const result = await walk(root, options());
    expect(result.candidates).toEqual([root]);
    expect(result.folders).toEqual([
      {
        name: root.split("/").at(-1),
        relativePath: "",
        depth: 0,
        parent: null,
        checkoutPath: root,
      },
    ]);
  });

  it("throws cancelled once its signal aborts", async () => {
    folder("a/b");
    const controller = new AbortController();
    controller.abort();
    await expect(walk(root, { ...options(), signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});
