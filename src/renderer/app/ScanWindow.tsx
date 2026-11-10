import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Group, type Layout, Panel, Separator } from "react-resizable-panels";
import { installKeymap } from "../commands/keymap";
import { useCommand } from "../commands/registry";
import { main } from "../data/client";
import { useLatestEvent } from "../data/events";
import { ScanContext, type ScanContextValue, useScan } from "../data/hooks/useScan";
import { matchesSelection, useSelectedFile, useVisibleFiles } from "../data/hooks/useSelection";
import { orderedCheckouts, repositoryNeighbours, type ScanData } from "../data/scan-model";
import { type ScanStream, startScan } from "../data/scan-stream";
import { Navigator } from "../panels/navigator/Navigator";
import { Preview } from "../panels/preview/Preview";
import { Toolbar } from "../panels/Toolbar";
import { TimelinePanel } from "../panels/timeline/TimelinePanel";
import { persistUi, uiStore, useUi } from "../state/ui-store";
import { ConnectionBanner } from "./ConnectionBanner";
import { GitMissingNotice } from "./GitMissingNotice";

const DEFAULT_TIMELINE_WIDTH = 300;
const DEFAULT_NAVIGATOR_WIDTH = 340;

/**
 * One folder's window: toolbar, then the timeline (optional), the navigator and the
 * preview side by side. It runs the folder's scan, owns the window-wide commands, and saves
 * its layout per window.
 */
export function ScanWindow({ scanRoot }: { scanRoot: string }) {
  const queryClient = useQueryClient();
  const streamRef = useRef<ScanStream | null>(null);

  useEffect(() => {
    const stream = startScan(queryClient, scanRoot, {
      onSettled: (scan) => {
        keepSelection(scan);
        // File lists are fetched again once the scan that may have changed them is done,
        // and only then: a restarted core service knows a checkout only once it is scanned.
        if (scan.phase === "done") void queryClient.invalidateQueries({ queryKey: ["comparison"] });
      },
    });
    streamRef.current = stream;
    return () => {
      stream.stop();
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [queryClient, scanRoot]);

  const rescan = useCallback(async () => {
    await streamRef.current?.rescan();
  }, []);

  const context = useMemo<ScanContextValue>(() => ({ scanRoot, rescan }), [scanRoot, rescan]);

  useEffect(() => persistUi(uiStore, (ui) => void main().window.state({ ui })), []);
  useEffect(() => installKeymap(window), []);

  const git = useLatestEvent("git.state");

  return (
    <ScanContext.Provider value={context}>
      <div className="flex h-full flex-col" data-testid="scan-window" data-scan-root={scanRoot}>
        <ConnectionBanner onReconnected={() => void rescan()} />
        <Toolbar onRefresh={() => void rescan()} />
        {git && !git.found ? (
          <GitMissingNotice problem={git.problem} {...(git.detail ? { detail: git.detail } : {})} />
        ) : (
          <>
            <WindowCommands onRefresh={() => void rescan()} />
            <Panels />
          </>
        )}
      </div>
    </ScanContext.Provider>
  );
}

/** After a scan: a selected checkout the scan no longer reports is deselected. */
function keepSelection(scan: ScanData): void {
  if (scan.phase !== "done") return;
  const selected = uiStore.getState().selectedCheckout;
  if (selected !== null && !(selected in scan.checkouts)) uiStore.getState().selectCheckout(null);
}

function Panels() {
  const timelineOpen = useUi((state) => state.timelineOpen);
  const focusPreview = useUi((state) => state.focusPreview);
  const timelineWidth = useUi((state) => state.timelineWidth);
  const navigatorWidth = useUi((state) => state.navigatorWidth);
  const setPanelWidths = useUi((state) => state.setPanelWidths);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const showTimeline = timelineOpen && !focusPreview;
  const showNavigator = !focusPreview;

  const onLayoutChanged = (layout: Layout, meta: { isUserInteraction: boolean }) => {
    const width = groupRef.current?.clientWidth ?? 0;
    if (!meta.isUserInteraction || width === 0) return;
    const px = (percent: number | undefined) =>
      percent === undefined ? undefined : Math.round((percent / 100) * width);
    const timeline = px(layout["timeline-panel"]);
    const navigator = px(layout["navigator-panel"]);
    setPanelWidths({
      ...(timeline === undefined ? {} : { timelineWidth: timeline }),
      ...(navigator === undefined ? {} : { navigatorWidth: navigator }),
    });
  };

  return (
    <Group
      orientation="horizontal"
      className="min-h-0 flex-1"
      elementRef={groupRef}
      onLayoutChanged={onLayoutChanged}
      disableCursor
    >
      {showTimeline && (
        <>
          <Panel
            id="timeline-panel"
            defaultSize={`${timelineWidth ?? DEFAULT_TIMELINE_WIDTH}px`}
            minSize="220px"
            maxSize="40%"
            className="side-panel"
          >
            <TimelinePanel />
          </Panel>
          <Separator className="panel-separator" aria-label="Resize the timeline" />
        </>
      )}
      {showNavigator && (
        <>
          <Panel
            id="navigator-panel"
            defaultSize={`${navigatorWidth ?? DEFAULT_NAVIGATOR_WIDTH}px`}
            minSize="260px"
            maxSize="55%"
            className="side-panel"
          >
            <Navigator />
          </Panel>
          <Separator className="panel-separator" aria-label="Resize the navigator" />
        </>
      )}
      <Panel id="preview-panel" minSize="320px" className="bg-background">
        <Preview />
      </Panel>
    </Group>
  );
}

/**
 * Window-wide commands. File and checkout navigation live here rather than in the lists,
 * so ⌥↓ and ⌘] keep working with the navigator hidden by Focus preview.
 */
function WindowCommands({ onRefresh }: { onRefresh: () => void }) {
  const selected = useUi((state) => state.selectedCheckout);
  const order = useScan(orderedCheckouts);
  const neighbours = useScan(
    useCallback(
      (scan: ScanData) =>
        selected ? repositoryNeighbours(scan, selected) : { previous: null, next: null },
      [selected],
    ),
  );
  const files = useVisibleFiles();
  const selectedFile = useSelectedFile();
  // Commands read the store when they run, so they always act on the latest state.
  const ui = uiStore.getState;

  useCommand("scan.refresh", onRefresh);
  useCommand("view.timeline", () => ui().setTimelineOpen(!ui().timelineOpen));
  useCommand("view.tree", () => {
    ui().setFocusPreview(false);
    ui().setNavigatorMode(ui().navigatorMode === "tree" ? "picker" : "tree");
  });
  useCommand("preview.focus", () => ui().setFocusPreview(!ui().focusPreview));
  useCommand("preview.split", () => ui().setPreviewMode("split"));
  useCommand("preview.unified", () => ui().setPreviewMode("unified"));
  useCommand(
    "preview.result",
    () => ui().setPreviewMode("result"),
    () => selectedFile?.status !== "deleted",
  );

  useCommand(
    "checkout.previous",
    () => {
      if (neighbours.previous) ui().selectCheckout(neighbours.previous, { reveal: true });
    },
    () => neighbours.previous !== null,
  );
  useCommand(
    "checkout.next",
    () => {
      if (neighbours.next) ui().selectCheckout(neighbours.next, { reveal: true });
    },
    () => neighbours.next !== null,
  );

  const step = (delta: 1 | -1) => {
    const index = files.findIndex((file) => matchesSelection(file, ui().selectedFile));
    const nextIndex =
      index < 0
        ? delta > 0
          ? 0
          : files.length - 1
        : Math.min(files.length - 1, Math.max(0, index + delta));
    const next = files[nextIndex];
    if (next)
      ui().selectFile({ path: next.path, ...(next.category ? { category: next.category } : {}) });
  };
  useCommand(
    "file.next",
    () => step(1),
    () => files.length > 0,
  );
  useCommand(
    "file.previous",
    () => step(-1),
    () => files.length > 0,
  );

  useCommand(
    "files.filter",
    () => {
      ui().setFocusPreview(false);
      ui().requestFilterFocus();
    },
    () => selected !== null,
  );
  useCommand(
    "comparison.settings",
    () => {
      ui().setFocusPreview(false);
      ui().setComparisonOpen(!ui().comparisonOpen);
    },
    () => selected !== null && order.includes(selected),
  );
  return null;
}
