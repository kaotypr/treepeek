import type { Session } from "../sessions/session";

/**
 * Answers main's `paths.validate` (the checks behind "Open in…"): `true` for a path only
 * when some session's scan holds it under the path rule.
 */
export async function validatePaths(
  sessions: readonly Session[],
  paths: readonly string[],
): Promise<boolean[]> {
  return Promise.all(
    paths.map(async (path) => {
      for (const session of sessions) {
        if (await session.isInScan(path)) return true;
      }
      return false;
    }),
  );
}
