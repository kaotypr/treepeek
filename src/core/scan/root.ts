import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ScanRootProblem } from "../../shared/domain/scan";

export type ScanRootCheck = { ok: true; real: string } | { ok: false; problem: ScanRootProblem };

/**
 * Whether a folder can be scanned: it exists, is a folder, and its entries can be listed.
 * A folder the person may not read (no permission, or one macOS's privacy controls guard)
 * is `unreadable`; the window then offers to choose another folder instead of reporting
 * an empty scan.
 */
export async function checkScanRoot(path: string): Promise<ScanRootCheck> {
  if (!isAbsolute(path) || path.includes("\0")) return { ok: false, problem: "missing" };
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return { ok: false, problem: isDenied(error) ? "unreadable" : "missing" };
  }
  try {
    if (!(await stat(real)).isDirectory()) return { ok: false, problem: "notAFolder" };
    const dir = await opendir(real);
    await dir.close();
  } catch (error) {
    return { ok: false, problem: isDenied(error) ? "unreadable" : "missing" };
  }
  return { ok: true, real };
}

function isDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}
