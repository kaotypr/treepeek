import { useEffect } from "react";
import { cn } from "../lib/utils";
import { uiStore, useUi } from "../state/ui-store";

const SHOW_MS = 4_000;

/**
 * A one-line message about the action that just ran ("Copied the commit id."), or why it
 * failed. It is a live region, so VoiceOver reads it, and it clears itself.
 */
export function NoticeBar() {
  const notice = useUi((state) => state.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      if (uiStore.getState().notice?.id === notice.id) uiStore.getState().clearNotice();
    }, SHOW_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute right-4 bottom-4 z-40"
    >
      {notice && (
        <p
          className={cn(
            "rounded-md border px-3 py-1.5 text-xs shadow-md",
            notice.tone === "error"
              ? "border-destructive bg-popover text-destructive"
              : "border-border bg-popover text-popover-foreground",
          )}
          data-testid="notice"
          data-tone={notice.tone}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
