import { useCallback } from "react";
import { shortcutLabel } from "../../commands/keymap";
import { TreeIcon } from "../../components/icons";
import { useCheckout, useScan } from "../../data/hooks/useScan";
import { quantity, type ScanData } from "../../data/scan-model";
import { cn } from "../../lib/utils";
import { useUi } from "../../state/ui-store";
import { CheckoutDetails } from "./CheckoutDetails";
import { FileList } from "./FileList";
import { FolderPicker } from "./FolderPicker";
import { FolderTree } from "./FolderTree";

/**
 * The middle panel: the folder picker (or the full tree), the selected checkout's details,
 * and its changed files.
 */
export function Navigator() {
  const mode = useUi((state) => state.navigatorMode);
  const setMode = useUi((state) => state.setNavigatorMode);
  const selected = useUi((state) => state.selectedCheckout);
  const checkout = useCheckout(selected);
  const status = useScan(useCallback((scan: ScanData) => scanStatus(scan), []));
  const tree = mode === "tree";

  return (
    <nav aria-label="Navigator" className="flex h-full min-h-0 flex-col" data-testid="navigator">
      <div className="flex items-center gap-2 border-border border-b px-3 py-2">
        <FolderPicker />
        <button
          type="button"
          aria-pressed={tree}
          aria-label="Tree view"
          aria-keyshortcuts="Meta+Shift+T"
          title={`Tree view (${shortcutLabel("view.tree")})`}
          onClick={() => setMode(tree ? "picker" : "tree")}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-input bg-card px-2 text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
            tree && "bg-selection text-selection-foreground",
          )}
          data-testid="tree-toggle"
        >
          <TreeIcon className="size-3.5" />
          Tree
        </button>
      </div>
      <p
        className={cn(
          "px-3 py-1 text-xs",
          status.error ? "text-destructive" : "text-muted-foreground",
        )}
        aria-live="polite"
        data-testid="scan-status"
      >
        {status.text}
      </p>
      {tree && (
        <div className="h-[40%] min-h-24 shrink-0 border-border border-y">
          <FolderTree />
        </div>
      )}
      {checkout ? (
        <>
          <CheckoutDetails checkout={checkout} />
          <FileList />
        </>
      ) : (
        <p className="p-4 text-muted-foreground text-xs">
          {status.count === 0 ? " " : "Select a Git folder to review its changes."}
        </p>
      )}
    </nav>
  );
}

function scanStatus(scan: ScanData): { text: string; count: number; error: boolean } {
  const count = Object.keys(scan.checkouts).length;
  switch (scan.phase) {
    case "opening":
    case "walking":
      return {
        text: count > 0 ? `Scanning… ${quantity(count, "checkout")}` : "Scanning…",
        count,
        error: false,
      };
    case "resolving":
      return { text: `Scanning… ${quantity(count, "checkout")} found`, count, error: false };
    case "done":
      return {
        text:
          count === 0
            ? "No Git checkouts found beneath this folder."
            : `${quantity(count, "Git checkout")}${scan.problems.length > 0 ? ` · ${quantity(scan.problems.length, "folder")} could not be read` : ""}`,
        count,
        error: false,
      };
    case "failed":
      return {
        text:
          scan.error?.code === "coreUnavailable"
            ? "Waiting for the background service…"
            : (scan.error?.message ?? "The scan failed."),
        count,
        error: scan.error?.code !== "coreUnavailable",
      };
  }
}
