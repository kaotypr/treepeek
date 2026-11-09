/**
 * The window's scan as the cache holds it, and what the panels derive from it. Pure
 * functions, so the derivations are tested without a window.
 */

import type {
  Checkout,
  FolderNode,
  Repository,
  ScanProblem,
  TimelineEntry,
} from "../../shared/domain/scan";
import type { IpcErrorCode } from "../../shared/ipc/result";

export type ScanPhase = "opening" | "walking" | "resolving" | "done" | "failed";

export interface ScanData {
  scanRoot: string;
  phase: ScanPhase;
  /** The folder tree, once the walk has finished. */
  folders: FolderNode[];
  depthLimit: number | null;
  /** Every checkout resolved so far, by path. */
  checkouts: Record<string, Checkout>;
  /** Paths in the order they resolved; the timeline order replaces it once the scan is done. */
  arrival: string[];
  timeline: TimelineEntry[];
  repositories: Repository[];
  problems: ScanProblem[];
  durationMs: number | null;
  error: { code: IpcErrorCode; message: string } | null;
}

export function emptyScan(scanRoot: string): ScanData {
  return {
    scanRoot,
    phase: "opening",
    folders: [],
    depthLimit: null,
    checkouts: {},
    arrival: [],
    timeline: [],
    repositories: [],
    problems: [],
    durationMs: null,
    error: null,
  };
}

/** The checkout's folder relative to the scan root, `/`-separated; `.` for the root itself. */
export function relativePath(scanRoot: string, path: string): string {
  if (path === scanRoot) return ".";
  const prefix = scanRoot.endsWith("/") ? scanRoot : `${scanRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The last path segment. */
export function baseName(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** The folder a checkout sits in, relative to the scan root (`.` for the root). */
export function parentFolder(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? "." : relative.slice(0, slash);
}

/** Checkout paths in timeline order once the scan is done, in arrival order before that. */
export function orderedCheckouts(scan: ScanData): string[] {
  if (scan.timeline.length > 0) {
    const ordered = scan.timeline
      .map((entry) => entry.checkoutPath)
      .filter((path) => path in scan.checkouts);
    const listed = new Set(ordered);
    return [...ordered, ...scan.arrival.filter((path) => !listed.has(path))];
  }
  return scan.arrival.filter((path) => path in scan.checkouts);
}

export function timelineEntry(scan: ScanData, path: string): TimelineEntry | undefined {
  return scan.timeline.find((entry) => entry.checkoutPath === path);
}

export function repositoryOf(scan: ScanData, path: string): Repository | undefined {
  const entry = timelineEntry(scan, path);
  if (entry) return scan.repositories.find((repo) => repo.commonDir === entry.commonDir);
  return scan.repositories.find((repo) => repo.checkouts.includes(path));
}

/** The repository's display name, or the checkout's folder name until the scan is done. */
export function repositoryName(scan: ScanData, path: string): string {
  return repositoryOf(scan, path)?.displayName ?? baseName(path);
}

/** The previous and next checkout of the same repository, in timeline order. */
export function repositoryNeighbours(
  scan: ScanData,
  path: string,
): { previous: string | null; next: string | null } {
  const entry = timelineEntry(scan, path);
  if (!entry) return { previous: null, next: null };
  const same = scan.timeline.filter((item) => item.commonDir === entry.commonDir);
  const index = same.findIndex((item) => item.checkoutPath === path);
  return {
    previous: same[index - 1]?.checkoutPath ?? null,
    next: same[index + 1]?.checkoutPath ?? null,
  };
}

/** How the timeline describes a checkout's relation to its predecessor (prototype wording). */
export function relationLabel(scan: ScanData, entry: TimelineEntry): string {
  if (entry.predecessor === null || entry.relation === "first") return "First in repository";
  const previous = relativePath(scan.scanRoot, entry.predecessor);
  return entry.relation === "after" ? `After ${previous}` : `Parallel to ${previous}`;
}

/** Folders by parent, each list sorted by name: the picker's and the tree's shape. */
export function folderChildren(folders: readonly FolderNode[]): Map<string | null, FolderNode[]> {
  const children = new Map<string | null, FolderNode[]>();
  for (const folder of folders) {
    const list = children.get(folder.parent);
    if (list) list.push(folder);
    else children.set(folder.parent, [folder]);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

/**
 * How many resolved checkouts each folder holds, itself and everything beneath it, keyed by
 * `relativePath`.
 */
export function checkoutCounts(scan: ScanData): Map<string, number> {
  const counts = new Map<string, number>();
  const byRelative = new Map(scan.folders.map((folder) => [folder.relativePath, folder]));
  for (const folder of scan.folders) {
    if (folder.checkoutPath === null || !(folder.checkoutPath in scan.checkouts)) continue;
    let current: FolderNode | undefined = folder;
    while (current) {
      counts.set(current.relativePath, (counts.get(current.relativePath) ?? 0) + 1);
      current = current.parent === null ? undefined : byRelative.get(current.parent);
    }
  }
  return counts;
}

/** The folder holding a checkout and all its ancestors, by `relativePath`. */
export function folderAncestors(scan: ScanData, checkoutPath: string): string[] {
  const byRelative = new Map(scan.folders.map((folder) => [folder.relativePath, folder]));
  const own = scan.folders.find((folder) => folder.checkoutPath === checkoutPath);
  const chain: string[] = [];
  let current = own?.parent === null || own === undefined ? undefined : byRelative.get(own.parent);
  while (current) {
    chain.push(current.relativePath);
    current = current.parent === null ? undefined : byRelative.get(current.parent);
  }
  return chain;
}

/** Uncommitted files in a checkout. */
export function uncommittedCount(checkout: Checkout): number {
  return checkout.working.staged + checkout.working.unstaged + checkout.working.untracked;
}

/** `1 file`, `2 files`. */
export function quantity(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
