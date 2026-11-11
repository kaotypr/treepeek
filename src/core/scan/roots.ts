import type { ScanRootProblem } from "../../shared/domain/scan";
import { isWithin } from "../sessions/path-rule";
import { checkScanRoot } from "./root";

export type ScanRootsCheck =
  | { ok: true; roots: string[] }
  | { ok: false; path: string; problem: ScanRootProblem };

/**
 * Checks every folder a session is asked to scan (`checkScanRoot`) and answers the roots
 * to walk: real paths, each once, without a root that lies inside another. The first root
 * that cannot be scanned fails the whole check, naming it as it was given.
 */
export async function checkScanRoots(paths: readonly string[]): Promise<ScanRootsCheck> {
  const checked = await Promise.all(paths.map(async (path) => ({ path, check: await checkScanRoot(path) })));
  const reals: string[] = [];
  for (const { path, check } of checked) {
    if (!check.ok) return { ok: false, path, problem: check.problem };
    reals.push(check.real);
  }
  return { ok: true, roots: outermostRoots(reals) };
}

/**
 * The roots to walk, in the order given: each real path once, and none that lies inside
 * another, since the outer root's walk covers it. Walking both would list its checkouts
 * twice.
 */
export function outermostRoots(reals: readonly string[]): string[] {
  const unique = [...new Set(reals)];
  return unique.filter(
    (root) => !unique.some((other) => other !== root && isWithin(root, other)),
  );
}
