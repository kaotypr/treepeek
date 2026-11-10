import type { TimelineEntry } from "../../../shared/domain/scan";
import type { TimelineGrouping, TimelineOrder } from "../../../shared/settings";
import { parentFolder, relativePath, repositoryName, type ScanData } from "../../data/scan-model";

export interface TimelineGroup {
  key: string;
  /** `null` when everything is one list (grouping `all`). */
  title: string | null;
  entries: TimelineEntry[];
}

/**
 * The timeline as the panel lists it (the prototype's grouping and order): one list, or
 * one group per repository or per containing folder. Groups are ordered by their earliest
 * entry (their latest when newest first); entries keep the timeline's numbering either way.
 */
export function groupTimeline(
  scan: ScanData,
  grouping: TimelineGrouping,
  order: TimelineOrder,
): TimelineGroup[] {
  const entries = scan.timeline.filter((entry) => entry.checkoutPath in scan.checkouts);
  const groups = new Map<string, TimelineGroup>();
  for (const entry of entries) {
    const key =
      grouping === "repository"
        ? entry.commonDir
        : grouping === "folder"
          ? parentFolder(relativePath(scan.scanRoot, entry.checkoutPath))
          : "all";
    let group = groups.get(key);
    if (!group) {
      const title =
        grouping === "repository"
          ? repositoryName(scan, entry.checkoutPath)
          : grouping === "folder"
            ? key === "."
              ? "Scanned folder"
              : key
            : null;
      group = { key, title, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const newest = order === "newest";
  const list = [...groups.values()];
  for (const group of list) {
    group.entries.sort((a, b) => (newest ? b.sequence - a.sequence : a.sequence - b.sequence));
  }
  const edge = (group: TimelineGroup) =>
    newest
      ? Math.max(...group.entries.map((entry) => entry.sequence))
      : Math.min(...group.entries.map((entry) => entry.sequence));
  list.sort((a, b) => (newest ? edge(b) - edge(a) : edge(a) - edge(b)));
  return list;
}
