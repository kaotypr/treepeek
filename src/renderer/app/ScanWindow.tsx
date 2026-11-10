import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Group, type Layout, Panel, Separator } from "react-resizable-panels";
import type { FileDiff } from "../../shared/domain/diff";
import type { Result } from "../../shared/ipc/result";
import { installKeymap } from "../commands/keymap";
import { checkedCommands, startCommandReport } from "../commands/menu-state";
import { useCommand } from "../commands/registry";
import { main } from "../data/client";
import { useLatestEvent } from "../data/events";
import { firstChangedLine } from "../data/first-changed-line";
import { ScanContext, type ScanContextValue, useScan, useScanContext } from "../data/hooks/useScan";
import {
  matchesSelection,
  useSelectedComparison,
  useSelectedFile,
  useVisibleFiles,
} from "../data/hooks/useSelection";
import { comparisonKey, keys } from "../data/keys";
import { orderedCheckouts, repositoryNeighbours, type ScanData } from "../data/scan-model";
import { type ScanStream, startScan } from "../data/scan-stream";
import { Navigator } from "../panels/navigator/Navigator";
import { Preview } from "../panels/preview/Preview";
import { Toolbar } from "../panels/Toolbar";
import { TimelinePanel } from "../panels/timeline/TimelinePanel";
import { GitSetup } from "../screens/git-setup/GitSetup";
import { ScanError } from "../screens/scan-error/ScanError";
import { persistUi, uiStore, useUi } from "../state/ui-store";
import { ConnectionBanner } from "./ConnectionBanner";
import { NoticeBar } from "./NoticeBar";

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
  useEffect(
    () =>
      startCommandReport({
        send: (state) => void main().window.commands(state),
        checked: () => checkedCommands(uiStore.getState()),
        subscribe: (listener) => uiStore.subscribe(listener),
      }),
    [],
  );

  // Settings › Review: the comparison the next selected checkout starts on.
  const settings = useLatestEvent("settings.changed");
  useEffect(() => {
    if (settings) uiStore.getState().setDefaultComparison(settings.defaultComparison);
  }, [settings]);

  const git = useLatestEvent("git.state");
  const gitFound = git?.found;
  const hadNoGit = useRef(false);
  useEffect(() => {
    if (gitFound === false) hadNoGit.current = true;
    // Git was found after all (picked, installed, Try again): scan what was waiting.
    if (gitFound === true && hadNoGit.current) {
      hadNoGit.current = false;
      void rescan();
    }
  }, [gitFound, rescan]);

  return (
    <ScanContext.Provider value={context}>
      <div
        className="relative flex h-full flex-col"
        data-testid="scan-window"
        data-scan-root={scanRoot}
      >
        <ConnectionBanner onReconnected={() => void rescan()} />
        <Toolbar onRefresh={() => void rescan()} />
        <WindowBody git={git} onRescan={() => void rescan()} />
        <NoticeBar />
      </div>
    </ScanContext.Provider>
  );
}

/**
 * What fills the window under the toolbar: the git setup screen while no usable git is
 * found, the scan error when the folder itself cannot be scanned, and the panels otherwise.
 */
function WindowBody({
  git,
  onRescan,
}: {
  git: ReturnType<typeof useLatestEvent<"git.state">>;
  onRescan: () => void;
}) {
  const { scanRoot } = useScanContext();
  const rootProblem = useScan(
    useCallback(
      (scan: ScanData) =>
        scan.phase === "failed" && scan.error?.scanRoot
          ? { problem: scan.error.scanRoot, message: scan.error.message }
          : null,
      [],
    ),
  );
  if (git && !git.found) return <GitSetup state={git} />;
  if (rootProblem) {
    return (
      <>
        <WindowCommands onRefresh={onRescan} />
        <ScanError
          scanRoot={scanRoot}
          problem={rootProblem.problem}
          message={rootProblem.message}
          onRetry={onRescan}
        />
      </>
    );
  }
  return (
    <>
      <WindowCommands onRefresh={onRescan} />
      <Panels />
    </>
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

  useCheckoutCommands();
  return null;
}

/** Reports a failed native action in the notice bar; a success says `done` when given. */
function report(result: Result<unknown>, done?: string): void {
  if (!result.ok) uiStore.getState().showNotice(result.error.message, "error");
  else if (done) uiStore.getState().showNotice(done);
}

/**
 * The selected checkout's commands: Set Start…, "Open in…" (editor, terminal, Finder) and
 * copying its path, branch or full commit id. The editor opens the selected file at its
 * first changed line when its diff is loaded; with no file selected, the checkout folder.
 */
function useCheckoutCommands(): void {
  const queryClient = useQueryClient();
  const { checkout, query } = useSelectedComparison();
  const file = useSelectedFile();
  const ui = uiStore.getState;
  const has = checkout !== undefined;

  const editorTarget = (): { path: string; line?: number } | null => {
    if (!checkout) return null;
    if (!file || file.status === "deleted") return { path: checkout.path };
    const result = query.data;
    const diff = result
      ? queryClient.getQueryData<FileDiff>(
          keys.fileDiff(checkout.path, comparisonKey(result.comparison), file, file.resultHash),
        )
      : undefined;
    const line = diff ? firstChangedLine(diff) : undefined;
    return { path: `${checkout.path}/${file.path}`, ...(line === undefined ? {} : { line }) };
  };

  useCommand(
    "checkout.setStart",
    () => {
      ui().setFocusPreview(false);
      ui().setComparisonOpen(false);
      ui().setStartDialogOpen(true);
    },
    () => has,
  );
  useCommand(
    "checkout.revealInFinder",
    () => {
      if (checkout)
        void main()
          .openIn.finder({ path: checkout.path })
          .then((r) => report(r));
    },
    () => has,
  );
  useCommand(
    "checkout.openInEditor",
    () => {
      const target = editorTarget();
      if (target)
        void main()
          .openIn.editor(target)
          .then((r) => report(r));
    },
    () => has,
  );
  useCommand(
    "checkout.openInTerminal",
    () => {
      if (checkout)
        void main()
          .openIn.terminal({ path: checkout.path })
          .then((r) => report(r));
    },
    () => has,
  );
  useCommand(
    "checkout.copyPath",
    () => {
      if (!checkout) return;
      void main()
        .clipboard.copy({ text: checkout.path, kind: "path" })
        .then((r) => report(r, "Copied the path."));
    },
    () => has,
  );
  useCommand(
    "checkout.copyBranch",
    () => {
      if (!checkout?.branch) return;
      void main()
        .clipboard.copy({ text: checkout.branch, kind: "branch" })
        .then((r) => report(r, "Copied the branch name."));
    },
    () => !!checkout?.branch,
  );
  useCommand(
    "checkout.copyCommit",
    () => {
      if (!checkout?.head) return;
      void main()
        .clipboard.copy({ text: checkout.head, kind: "commit" })
        .then((r) => report(r, "Copied the commit id."));
    },
    () => !!checkout?.head,
  );
}
