import type { RefreshPause } from "../../shared/domain/change";
import { shortcutLabel } from "../commands/keymap";
import { useScanContext } from "../data/hooks/useScan";
import { useRefreshPauses } from "../data/refresh-sync";
import { baseName, relativePath } from "../data/scan-model";

/**
 * Where live refresh is paused for this window (live-refresh design, "Floods, sleep and
 * failure"): a checkout whose working tree had an event storm ("Lots of changes in …"),
 * and folders no watcher could watch ("Live refresh unavailable for …"). Refresh lets live
 * refresh run again and rescans.
 */
export function RefreshBanner({ onRefresh }: { onRefresh: () => void }) {
  const { scanRoot } = useScanContext();
  const paused = useRefreshPauses();
  if (paused.length === 0) return null;
  const storms = paused.filter((item) => item.reason === "eventStorm");
  const unavailable = paused.filter((item) => item.reason === "watcherError");
  const name = (path: string) => {
    const relative = relativePath(scanRoot, path);
    return relative === "." ? baseName(scanRoot) : relative;
  };
  const shortcut = shortcutLabel("scan.refresh");
  return (
    <div
      role="status"
      data-testid="refresh-banner"
      className="flex shrink-0 items-center gap-3 border-border border-b bg-review-changed-surface px-4 py-1 text-review-changed text-xs"
    >
      <div className="min-w-0 flex-1">
        {storms.length > 0 && (
          <p data-testid="refresh-storm">
            Lots of changes in {listed(storms, name)} — refresh when ready
          </p>
        )}
        {unavailable.length > 0 && (
          <p data-testid="refresh-unavailable">
            Live refresh unavailable for {listed(unavailable, name)}
            {shortcut ? `. Refresh with ${shortcut} to see changes.` : "."}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        className="shrink-0 rounded-md border border-input bg-card px-2 py-0.5 text-foreground text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="refresh-resume"
      >
        Refresh
      </button>
    </div>
  );
}

/** `a`, `a and b`, or `a and 3 more`. */
function listed(items: readonly RefreshPause[], name: (path: string) => string): string {
  const [first, second] = items;
  if (!first) return "";
  if (!second) return name(first.path);
  if (items.length === 2) return `${name(first.path)} and ${name(second.path)}`;
  return `${name(first.path)} and ${items.length - 1} more`;
}
