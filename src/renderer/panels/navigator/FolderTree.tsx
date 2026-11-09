import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ChevronIcon } from "../../components/icons";
import { useScan } from "../../data/hooks/useScan";
import { folderAncestors, quantity, repositoryName, type ScanData } from "../../data/scan-model";
import { cn } from "../../lib/utils";
import { uiStore, useUi } from "../../state/ui-store";
import { type FolderRow, folderRows } from "./folder-rows";

const ROW_HEIGHT = 26;

/**
 * The full folder tree: folders show how many checkouts they hold, checkouts are leaves.
 * Arrow keys move through it, Left and Right collapse and expand, Enter selects.
 */
export function FolderTree() {
  const selected = useUi((state) => state.selectedCheckout);
  const revealRequest = useUi((state) => state.revealRequest);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);

  // Ancestors of the selected checkout open whenever it changes, so it is always visible.
  const ancestors = useScan(
    useCallback((scan: ScanData) => (selected ? folderAncestors(scan, selected) : []), [selected]),
  );
  useEffect(() => {
    if (ancestors.length === 0) return;
    setExpanded((current) =>
      ancestors.every((path) => current.has(path)) ? current : new Set([...current, ...ancestors]),
    );
  }, [ancestors]);

  const rows = useScan(useCallback((scan: ScanData) => treeRows(scan, expanded), [expanded]));
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const selectedIndex = rows.findIndex(
    (row) => row.checkoutPath !== null && row.checkoutPath === selected,
  );
  const activeIndex = Math.max(
    0,
    active === null ? selectedIndex : rows.findIndex((row) => row.key === active),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls on each reveal request
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [revealRequest, selectedIndex >= 0]);

  const toggle = (key: string, open?: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });

  const activate = (row: TreeRow) => {
    setActive(row.key);
    if (row.checkoutPath !== null) uiStore.getState().selectCheckout(row.checkoutPath);
    else if (row.hasChildren) toggle(row.key);
  };

  const move = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setActive(row.key);
    virtualizer.scrollToIndex(rows.indexOf(row), { align: "auto" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const row = rows[activeIndex];
    switch (event.key) {
      case "ArrowDown":
        move(activeIndex + 1);
        break;
      case "ArrowUp":
        move(activeIndex - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (row && row.checkoutPath === null && row.hasChildren) {
          if (!expanded.has(row.key)) toggle(row.key, true);
          else move(activeIndex + 1);
        }
        break;
      case "ArrowLeft":
        if (row && row.checkoutPath === null && expanded.has(row.key) && row.hasChildren) {
          toggle(row.key, false);
        } else if (row?.parentKey !== null && row?.parentKey !== undefined) {
          move(rows.findIndex((item) => item.key === row.parentKey));
        }
        break;
      case "Enter":
      case " ":
        if (row) activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const activeRow = rows[activeIndex];
  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Folders"
      tabIndex={0}
      aria-activedescendant={activeRow ? treeItemId(activeRow.key) : undefined}
      onKeyDown={onKeyDown}
      className="h-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      data-testid="folder-tree"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const isSelected = row.checkoutPath !== null && row.checkoutPath === selected;
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: the tree holds focus and points at the active row with aria-activedescendant
            // biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles the keyboard for every row
            <div
              key={row.key}
              id={treeItemId(row.key)}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={
                row.checkoutPath === null && row.hasChildren ? expanded.has(row.key) : undefined
              }
              aria-label={row.ariaLabel}
              data-checkout-path={row.checkoutPath ?? undefined}
              className={cn(
                "absolute left-0 flex w-full cursor-default items-center gap-1.5 pr-2 text-xs",
                isSelected ? "bg-selection text-selection-foreground" : "hover:bg-hover",
                item.index === activeIndex && "outline-1 outline-ring -outline-offset-1",
              )}
              style={{
                top: item.start,
                height: ROW_HEIGHT,
                paddingLeft: 8 + row.depth * 14,
              }}
              onClick={() => activate(row)}
            >
              {row.checkoutPath === null ? (
                <ChevronIcon
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground transition-transform",
                    expanded.has(row.key) && "rotate-90",
                    !row.hasChildren && "invisible",
                  )}
                />
              ) : (
                <span aria-hidden="true" className="w-3 shrink-0 text-center text-primary-strong">
                  ◆
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="shrink-0 text-muted-foreground">{row.badge}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface TreeRow extends FolderRow {
  key: string;
  parentKey: string | null;
  name: string;
  badge: string;
  ariaLabel: string;
}

function treeRows(scan: ScanData, expanded: ReadonlySet<string>): TreeRow[] {
  return folderRows(scan, expanded).map((row) => {
    const isCheckout = row.checkoutPath !== null;
    const name =
      row.folder.depth === 0 && !isCheckout
        ? `${row.folder.name} (scanned folder)`
        : row.folder.name;
    const badge = isCheckout
      ? repositoryName(scan, row.checkoutPath ?? "")
      : quantity(row.count, "checkout");
    return {
      ...row,
      key: row.folder.relativePath,
      parentKey: row.folder.parent,
      name,
      badge,
      ariaLabel: isCheckout
        ? `${row.folder.name}, ${badge} checkout`
        : `${row.folder.name}, ${badge}`,
    };
  });
}

function treeItemId(key: string): string {
  return `tree-item-${encodeURIComponent(key) || "root"}`;
}
