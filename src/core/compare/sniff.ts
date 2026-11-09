import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DIFF_LIMITS } from "../../shared/constants";
import { isWithin } from "../sessions/path-rule";

/**
 * Whether a working-tree file looks binary: a NUL byte in its first
 * `DIFF_LIMITS.binarySniffBytes` (diff pipeline, "Binary detection"). A symlink is never
 * binary, since Git stores its target text. A file that is gone, unreadable, not a regular
 * file, or resolves outside the checkout counts as not binary: nothing is read from it.
 *
 * `checkoutPath` is a real path; `path` is repository-relative, from Git's own output.
 */
export async function sniffBinary(checkoutPath: string, path: string): Promise<boolean> {
  const file = join(checkoutPath, path);
  try {
    if (!(await lstat(file)).isFile()) return false;
    if (!isWithin(await realpath(file), checkoutPath)) return false;
    // `O_NOFOLLOW`: if the file was swapped for a symlink since, open fails.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(DIFF_LIMITS.binarySniffBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
