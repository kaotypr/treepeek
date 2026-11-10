import { useCallback, useMemo } from "react";
import { type ReviewStatus, reviewProgress } from "../../../shared/domain/review";
import { useCachedReviewStatuses } from "../../data/hooks/useReviewStatus";
import { useScan } from "../../data/hooks/useScan";
import { relativePath, type ScanData } from "../../data/scan-model";
import { useUi } from "../../state/ui-store";
import { folderRows } from "./folder-rows";

/**
 * The default navigator: a tree-shaped select of the checkouts (the prototype's picker).
 * Folders that only hold checkouts are listed, disabled, to show where each one sits. A
 * native select shows text only, so each checkout's review progress follows its name: a
 * check mark at 100%, the percentage before, a dot when a file changed since viewed.
 */
export function FolderPicker() {
  const rows = useScan(useCallback((scan: ScanData) => pickerOptions(scan), []));
  const paths = useMemo(() => rows.map((row) => row.value).filter(Boolean), [rows]);
  const statuses = useCachedReviewStatuses(paths);
  const progress = new Map(paths.map((path, index) => [path, progressText(statuses[index])]));
  const selected = useUi((state) => state.selectedCheckout);
  const selectCheckout = useUi((state) => state.selectCheckout);
  const value = selected !== null && rows.some((row) => row.value === selected) ? selected : "";

  return (
    <select
      aria-label="Git folder"
      data-testid="folder-picker"
      className="h-7 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      value={value}
      onChange={(event) => selectCheckout(event.target.value || null)}
    >
      <option value="">{rows.length === 0 ? "No Git folders yet" : "Select a Git folder"}</option>
      {rows.map((row) => (
        <option key={row.key} value={row.value} disabled={row.value === ""}>
          {row.label}
          {progress.get(row.value) ?? ""}
        </option>
      ))}
    </select>
  );
}

/** A checkout's progress after its name in the picker. */
export function progressText(status: ReviewStatus | undefined): string {
  if (!status) return "";
  const progress = reviewProgress(status);
  if (progress.empty) return "";
  const changed = progress.changed ? " •" : "";
  return progress.reviewed ? `  ✓${changed}` : `  ${progress.percent}%${changed}`;
}

interface PickerOption {
  key: string;
  value: string;
  label: string;
}

function pickerOptions(scan: ScanData): PickerOption[] {
  // The scan root itself is not a row unless it is a checkout.
  return folderRows(scan, null)
    .filter((row) => row.depth > 0 || row.checkoutPath !== null)
    .map((row) => {
      const depth = Math.max(0, row.depth - 1);
      const prefix = row.depth === 0 ? "" : `${"  ".repeat(depth)}${row.isLast ? "└─ " : "├─ "}`;
      const name =
        row.checkoutPath !== null ? relativePath(scan.scanRoot, row.checkoutPath) : row.folder.name;
      return {
        key: row.folder.relativePath,
        value: row.checkoutPath ?? "",
        label: `${prefix}${row.checkoutPath !== null && row.depth > 1 ? row.folder.name : name}`,
      };
    });
}
