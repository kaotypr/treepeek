import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Appearance } from "../../shared/settings";
import { shortcutLabel } from "../commands/keymap";
import { useCommand } from "../commands/registry";
import { MoonIcon, RefreshIcon, SunIcon, SystemIcon, TimelineIcon } from "../components/icons";
import { main, unwrap } from "../data/client";
import { useLatestEvent } from "../data/events";
import { useScan, useScanContext } from "../data/hooks/useScan";
import { baseName } from "../data/scan-model";
import { cn } from "../lib/utils";
import { useUi } from "../state/ui-store";

const NEXT_APPEARANCE: Readonly<Record<Appearance, Appearance>> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const APPEARANCE_LABEL: Readonly<Record<Appearance, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * The window's toolbar, in the hidden-inset title bar: the scan root, the Timeline toggle,
 * Refresh, the update slot (filled by the release work) and the appearance toggle.
 */
export function Toolbar({ onRefresh }: { onRefresh: () => void }) {
  const { scanRoot } = useScanContext();
  const phase = useScan((scan) => scan.phase);
  const timelineOpen = useUi((state) => state.timelineOpen);
  const setTimelineOpen = useUi((state) => state.setTimelineOpen);
  const scanning = phase === "opening" || phase === "walking" || phase === "resolving";

  return (
    <header className="app-drag flex h-12 shrink-0 items-center gap-3 border-border border-b bg-chrome pr-3 pl-20 text-chrome-foreground">
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-semibold text-sm leading-tight" data-testid="scan-root-name">
          {baseName(scanRoot)}
        </h1>
        <p className="truncate text-chrome-muted text-xs leading-tight" title={scanRoot}>
          {scanRoot}
        </p>
      </div>
      <div className="app-no-drag flex items-center gap-1">
        <ToolbarButton
          label="Timeline"
          shortcut={shortcutLabel("view.timeline")}
          pressed={timelineOpen}
          onClick={() => setTimelineOpen(!timelineOpen)}
        >
          <TimelineIcon />
          <span className="text-xs">Timeline</span>
        </ToolbarButton>
        <ToolbarButton
          label={scanning ? "Scanning…" : "Refresh"}
          shortcut={shortcutLabel("scan.refresh")}
          onClick={onRefresh}
          busy={scanning}
        >
          <RefreshIcon className={cn(scanning && "motion-safe:animate-spin")} />
        </ToolbarButton>
        <div data-slot="update" className="contents" />
        <AppearanceToggle />
      </div>
    </header>
  );
}

function AppearanceToggle() {
  const queryClient = useQueryClient();
  const theme = useLatestEvent("theme.changed");
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => unwrap(await main().settings.get()),
  });
  const appearance = theme?.source ?? settings.data?.appearance ?? "system";
  const next = NEXT_APPEARANCE[appearance];

  const cycle = async () => {
    const result = await main().settings.set({ appearance: next });
    if (result.ok) queryClient.setQueryData(["settings"], result.value);
  };
  useCommand("appearance.cycle", () => void cycle());

  const Icon = appearance === "light" ? SunIcon : appearance === "dark" ? MoonIcon : SystemIcon;
  return (
    <ToolbarButton
      label={`Appearance: ${APPEARANCE_LABEL[appearance]}. Switch to ${APPEARANCE_LABEL[next]}.`}
      onClick={() => void cycle()}
      testId="appearance-toggle"
    >
      <Icon />
    </ToolbarButton>
  );
}

function ToolbarButton({
  label,
  shortcut,
  pressed,
  busy,
  onClick,
  children,
  testId,
}: {
  label: string;
  shortcut?: string | null;
  pressed?: boolean;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={busy}
      aria-keyshortcuts={shortcut ? toAriaShortcut(shortcut) : undefined}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-md px-1.5 text-chrome-foreground outline-none transition-colors hover:bg-chrome-hover focus-visible:ring-2 focus-visible:ring-chrome-ring",
        pressed && "bg-chrome-hover",
      )}
    >
      {children}
    </button>
  );
}

/** `⌘⇧T` → `Meta+Shift+T`, the form `aria-keyshortcuts` takes. */
export function toAriaShortcut(label: string): string {
  const parts: string[] = [];
  let rest = label;
  for (const [symbol, name] of [
    ["⌥", "Alt"],
    ["⇧", "Shift"],
    ["⌘", "Meta"],
  ] as const) {
    if (rest.includes(symbol)) {
      parts.push(name);
      rest = rest.replace(symbol, "");
    }
  }
  const key = rest === "↑" ? "ArrowUp" : rest === "↓" ? "ArrowDown" : rest;
  return [...parts, key].join("+");
}
