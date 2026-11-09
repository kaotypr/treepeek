import { useMemo } from "react";
import type { FileChange } from "../../../shared/domain/compare";
import { useUi } from "../../state/ui-store";
import type { ComparisonRequest } from "../keys";
import { useComparison } from "./useComparison";
import { useCheckout } from "./useScan";

/** The comparison the settings describe, or `null` while `base` waits for its ref. */
export function useComparisonRequest(): ComparisonRequest | null {
  const kind = useUi((state) => state.comparisonKind);
  const ref = useUi((state) => state.comparisonRef);
  const startOverride = useUi((state) => state.comparisonStartOverride);
  return useMemo(() => {
    if (kind === "base" && !ref) return null;
    return {
      kind,
      ...(kind === "base" && ref ? { ref } : {}),
      ...(startOverride && kind !== "base" && kind !== "upstream" && kind !== "working"
        ? { startOverride }
        : {}),
    };
  }, [kind, ref, startOverride]);
}

/**
 * The selected checkout's current comparison. It is asked for only once the scan has
 * reported that checkout, since the core service accepts only scanned paths.
 */
export function useSelectedComparison() {
  const selected = useUi((state) => state.selectedCheckout);
  const checkout = useCheckout(selected);
  const request = useComparisonRequest();
  const checkoutPath = checkout ? checkout.path : null;
  const query = useComparison(checkoutPath, request);
  return { checkoutPath, checkout, request, query };
}

export function matchesSelection(
  file: FileChange,
  selection: { path: string; category?: string } | null,
): boolean {
  return (
    selection !== null &&
    file.path === selection.path &&
    (file.category ?? undefined) === (selection.category ?? undefined)
  );
}

/** The comparison's files narrowed by the filter (case-insensitive, on old and new paths). */
export function filterFiles(files: readonly FileChange[], filter: string): FileChange[] {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return [...files];
  return files.filter(
    (file) =>
      file.path.toLowerCase().includes(needle) ||
      (file.oldPath?.toLowerCase().includes(needle) ?? false),
  );
}

/** The files the list shows, in its order. */
export function useVisibleFiles(): FileChange[] {
  const { query } = useSelectedComparison();
  const filter = useUi((state) => state.fileFilter);
  const files = query.data?.files;
  return useMemo(() => filterFiles(files ?? [], filter), [files, filter]);
}

/** The selected file's entry in the current comparison, if it is still listed. */
export function useSelectedFile(): FileChange | undefined {
  const { query } = useSelectedComparison();
  const selection = useUi((state) => state.selectedFile);
  return useMemo(
    () => query.data?.files.find((file) => matchesSelection(file, selection)),
    [query.data, selection],
  );
}
