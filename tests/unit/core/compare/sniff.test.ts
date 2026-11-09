import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniffBinary } from "../../../../src/core/compare/sniff";
import { DIFF_LIMITS } from "../../../../src/shared/constants";

let checkout: string;
let outside: string;

beforeAll(() => {
  checkout = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-sniff-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "treepeek-sniff-outside-")));
  const late = Buffer.alloc(DIFF_LIMITS.binarySniffBytes + 10, 0x61);
  late[DIFF_LIMITS.binarySniffBytes + 1] = 0;
  const early = Buffer.alloc(DIFF_LIMITS.binarySniffBytes, 0x61);
  early[DIFF_LIMITS.binarySniffBytes - 1] = 0;
  writeFileSync(join(checkout, "text.txt"), "plain text\n");
  writeFileSync(join(checkout, "nul.bin"), Buffer.from([0x61, 0, 0x62]));
  writeFileSync(join(checkout, "early.bin"), early);
  writeFileSync(join(checkout, "late.txt"), late);
  writeFileSync(join(checkout, "empty.txt"), "");
  writeFileSync(join(outside, "secret.bin"), Buffer.from([0, 0, 0]));
  symlinkSync("nul.bin", join(checkout, "link.bin"));
  symlinkSync(outside, join(checkout, "escape"));
  mkdirSync(join(checkout, "dir"));
});
afterAll(() => {
  rmSync(checkout, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("sniffBinary", () => {
  it("finds a NUL byte within the first binarySniffBytes and nowhere later", async () => {
    expect(await sniffBinary(checkout, "nul.bin")).toBe(true);
    expect(await sniffBinary(checkout, "early.bin")).toBe(true);
    expect(await sniffBinary(checkout, "late.txt")).toBe(false);
    expect(await sniffBinary(checkout, "text.txt")).toBe(false);
    expect(await sniffBinary(checkout, "empty.txt")).toBe(false);
  });

  it("reads nothing through symlinks, outside the checkout, or from what is not a file", async () => {
    expect(await sniffBinary(checkout, "link.bin")).toBe(false);
    expect(await sniffBinary(checkout, "escape/secret.bin")).toBe(false);
    expect(await sniffBinary(checkout, "dir")).toBe(false);
    expect(await sniffBinary(checkout, "missing.bin")).toBe(false);
  });
});
