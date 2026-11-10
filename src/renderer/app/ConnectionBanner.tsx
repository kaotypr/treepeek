import { useEffect, useRef } from "react";
import type { CoreState } from "../../shared/ipc/contract";
import { useLatestEvent } from "../data/events";

/**
 * "Reconnecting…" while the core service restarts. The new service knows nothing of this
 * window, so once it is ready again `onReconnected` reopens the session and rescans.
 */
export function ConnectionBanner({ onReconnected }: { onReconnected: () => void }) {
  const state = useLatestEvent("core.state")?.state ?? null;
  const previous = useRef<CoreState | null>(null);
  const reconnected = useRef(onReconnected);
  reconnected.current = onReconnected;

  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (state === "ready" && (before === "restarting" || before === "failed")) {
      reconnected.current();
    }
  }, [state]);

  if (state !== "restarting" && state !== "failed") return null;
  return (
    <div
      role="status"
      data-testid="connection-banner"
      className="shrink-0 border-border border-b bg-review-changed-surface px-4 py-1 text-center text-review-changed text-xs"
    >
      {state === "restarting"
        ? "Reconnecting…"
        : "The background service stopped after repeated failures. Quit and reopen Treepeek."}
    </div>
  );
}
