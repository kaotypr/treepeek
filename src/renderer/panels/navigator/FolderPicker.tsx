import { useCallback } from "react";
import { useScan } from "../../data/hooks/useScan";
import { relativePath, type ScanData } from "../../data/scan-model";
import { useUi } from "../../state/ui-store";
import { folderRows } from "./folder-rows";

/**
 * The default navigator: a tree-shaped select of the checkouts (the prototype's picker).
 * Folders that only hold checkouts are listed, disabled, to show where each one sits.
 */
export function FolderPicker() {
  const rows = useScan(useCallback((scan: ScanData) => pickerOptions(scan), []));
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
        </option>
      ))}
    </select>
  );
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
