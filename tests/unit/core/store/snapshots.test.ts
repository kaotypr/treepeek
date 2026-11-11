import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotFolder } from "../../../../src/core/store/snapshots";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const bytes = new Uint8Array([1, 2, 3]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treepeek-snapshots-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function backdate(name: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(join(dir, name), then, then);
}

describe("SnapshotFolder", () => {
  it("put says whether it wrote the file, and the time the file got", () => {
    const folder = new SnapshotFolder(dir);
    const first = folder.put(H1, bytes);
    expect(first).toEqual({ size: 3, modifiedMs: statSync(join(dir, H1)).mtimeMs });
    expect(folder.put(H1, bytes)).toEqual({ size: 3, modifiedMs: null });
    expect(folder.list()[0]?.modifiedMs).toBe(first.modifiedMs);
  });

  it("touch makes a snapshot recent and answers its new time", () => {
    const folder = new SnapshotFolder(dir);
    folder.put(H1, bytes);
    backdate(H1, 60_000);
    const touched = folder.touch(H1);
    expect(touched).toBe(statSync(join(dir, H1)).mtimeMs);
    expect(Date.now() - (touched ?? 0)).toBeLessThan(5_000);
    expect(folder.touch(H2)).toBeNull();
    expect(folder.touch("../escape")).toBeNull();
  });

  it("removes a snapshot only while its time is the one given", () => {
    const folder = new SnapshotFolder(dir);
    folder.put(H1, bytes);
    const listed = folder.list()[0]?.modifiedMs ?? 0;
    backdate(H1, 60_000);
    expect(folder.remove(H1, listed)).toBe(false);
    expect(folder.has(H1)).toBe(true);
    expect(folder.remove(H1, statSync(join(dir, H1)).mtimeMs)).toBe(true);
    expect(folder.has(H1)).toBe(false);
    folder.put(H2, bytes);
    expect(folder.remove(H2)).toBe(true);
    expect(folder.has(H2)).toBe(false);
  });

  it("removes every temporary file by default", () => {
    const folder = new SnapshotFolder(dir);
    writeFileSync(join(dir, `.${H1}.123.tmp`), "half");
    expect(folder.list()).toEqual([]);
    expect(existsSync(join(dir, `.${H1}.123.tmp`))).toBe(false);
  });

  it("with temporaryMinAgeMs, leaves young temporary files to their writer", () => {
    const folder = new SnapshotFolder(dir, { temporaryMinAgeMs: 60_000 });
    const young = `.${H1}.123.tmp`;
    const old = `.${H2}.456.tmp`;
    writeFileSync(join(dir, young), "in flight");
    writeFileSync(join(dir, old), "left by a crash");
    backdate(old, 120_000);
    folder.list();
    expect(existsSync(join(dir, young))).toBe(true);
    expect(existsSync(join(dir, old))).toBe(false);
    folder.put(H1, bytes);
    folder.clear();
    expect(folder.has(H1)).toBe(false);
    expect(existsSync(join(dir, young))).toBe(true);
    backdate(young, 120_000);
    folder.clear();
    expect(existsSync(join(dir, young))).toBe(false);
  });
});
