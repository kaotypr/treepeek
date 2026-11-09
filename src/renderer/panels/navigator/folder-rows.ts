import type { FolderNode } from "../../../shared/domain/scan";
import { checkoutCounts, folderChildren, type ScanData } from "../../data/scan-model";

/** A folder the picker or the tree shows: one that holds or may still hold a checkout. */
export interface FolderRow {
  folder: FolderNode;
  depth: number;
  /** The checkout this folder is, once the scan has reported it. */
  checkoutPath: string | null;
  /** Checkouts the scan has reported in this folder and beneath it. */
  count: number;
  hasChildren: boolean;
  isLast: boolean;
}

/**
 * Folders with a checkout somewhere beneath them, in tree order (children sorted by name).
 * While the scan runs, a folder with an unconfirmed `.git` marker still counts; once it is
 * done, only reported checkouts do. `expanded` limits the rows to open folders (the tree);
 * `null` lists every folder (the picker).
 */
export function folderRows(scan: ScanData, expanded: ReadonlySet<string> | null): FolderRow[] {
  const children = folderChildren(scan.folders);
  const counts = checkoutCounts(scan);
  const done = scan.phase === "done";
  const candidates = new Map<string, number>();
  const countCandidates = (folder: FolderNode): number => {
    let total = folder.checkoutPath !== null ? 1 : 0;
    for (const child of children.get(folder.relativePath) ?? []) total += countCandidates(child);
    candidates.set(folder.relativePath, total);
    return total;
  };
  for (const root of children.get(null) ?? []) countCandidates(root);
  const visible = (folder: FolderNode) =>
    done
      ? (counts.get(folder.relativePath) ?? 0) > 0
      : (candidates.get(folder.relativePath) ?? 0) > 0;

  const rows: FolderRow[] = [];
  const visit = (folder: FolderNode, depth: number, isLast: boolean) => {
    const checkoutPath =
      folder.checkoutPath !== null && folder.checkoutPath in scan.checkouts
        ? folder.checkoutPath
        : null;
    const kids = (children.get(folder.relativePath) ?? []).filter(visible);
    rows.push({
      folder,
      depth,
      checkoutPath,
      count: counts.get(folder.relativePath) ?? 0,
      hasChildren: kids.length > 0,
      isLast,
    });
    if (checkoutPath !== null) return;
    if (expanded !== null && !expanded.has(folder.relativePath)) return;
    for (const [index, child] of kids.entries()) visit(child, depth + 1, index === kids.length - 1);
  };
  const roots = (children.get(null) ?? []).filter(visible);
  for (const [index, root] of roots.entries()) visit(root, 0, index === roots.length - 1);
  return rows;
}
