import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isIpcFailure } from "../../data/client";
import { useFileDiff } from "../../data/hooks/useFileDiff";
import { useSelectedComparison, useSelectedFile } from "../../data/hooks/useSelection";
import { DiffView } from "../../diff-view/DiffView";
import { DEFAULT_CONTEXT_LINES, type DiffAnchor, type DiffViewHandle } from "../../diff-view/types";
import { useResolvedTheme } from "../../lib/use-resolved-theme";
import { uiStore, useUi } from "../../state/ui-store";
import { PreviewHeader } from "./PreviewHeader";

/** Loading text waits this long, so a quick diff never flashes it. */
const LOADING_DELAY_MS = 150;

/**
 * The selected file's diff in the chosen mode. A mode change keeps the same lines in view;
 * selecting another file cancels the diff still being fetched for the previous one.
 */
export function Preview() {
  const { checkoutPath, request, query } = useSelectedComparison();
  const file = useSelectedFile();
  const mode = useUi((state) => state.previewMode);
  const theme = useResolvedTheme();
  const diff = useFileDiff(checkoutPath, request, query.data, file);
  const viewRef = useRef<DiffViewHandle>(null);
  const pendingAnchor = useRef<DiffAnchor | null>(null);

  // The anchor is read before React re-renders: the store's listeners run synchronously
  // when the mode changes, while the old view is still on screen.
  useEffect(
    () =>
      uiStore.subscribe((state, previous) => {
        if (state.previewMode !== previous.previewMode) {
          pendingAnchor.current = viewRef.current?.getAnchor() ?? null;
        }
      }),
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mode change, after the new view mounted
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (anchor !== null) viewRef.current?.restoreAnchor(anchor);
  }, [mode]);

  const showLoading = useDelayed(diff.isFetching && diff.data === undefined, LOADING_DELAY_MS);

  return (
    <section aria-label="Preview" className="flex h-full min-h-0 flex-col" data-testid="preview">
      <PreviewHeader file={file} stats={diff.data?.stats} />
      <div className="min-h-0 flex-1" data-testid="preview-body">
        {file === undefined ? (
          <Message>
            {checkoutPath
              ? "Select a file to see its changes."
              : "Select a Git folder, then a file, to see its changes."}
          </Message>
        ) : diff.data ? (
          <DiffView
            ref={viewRef}
            diff={diff.data}
            mode={mode}
            theme={theme}
            contextLines={DEFAULT_CONTEXT_LINES}
          />
        ) : diff.isError ? (
          <Message tone="error">
            {isIpcFailure(diff.error)
              ? diff.error.message
              : "This file's changes could not be read."}
          </Message>
        ) : showLoading ? (
          <Message>Loading diff…</Message>
        ) : null}
      </div>
    </section>
  );
}

function Message({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <p
      className={
        tone === "error" ? "p-6 text-destructive text-sm" : "p-6 text-muted-foreground text-sm"
      }
      data-testid="preview-message"
    >
      {children}
    </p>
  );
}

/** `value`, but `true` only once it has stayed true for `delayMs`. */
function useDelayed(value: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!value) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value && delayed;
}
