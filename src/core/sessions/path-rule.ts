import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The real path of `path` for the path rule: every symlink resolved. A path that does not
 * exist yet (a deleted file) resolves through its nearest existing folder, since a missing
 * name cannot be a link. Returns `null` for a relative path, a path with a NUL byte, a
 * dangling symlink (it may point anywhere once its target appears), or a path that cannot
 * be read.
 */
export async function realPathOf(path: string): Promise<string | null> {
  if (!isAbsolute(path) || path.includes("\0")) return null;
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) return null;
      // A dangling link exists as a link even though its target does not.
      if (await exists(current)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Whether `path` is `folder` or lies inside it (both real, absolute paths). */
export function isWithin(path: string, folder: string): boolean {
  if (path === folder) return true;
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return path.startsWith(prefix);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
