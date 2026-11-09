/**
 * The diff lab: a development-only page that renders fixture diffs with the diff viewer, so
 * the viewer can be judged and tested without git or the review screen. It is never part
 * of a production build (see `dev/lab-enabled.ts`).
 */

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "../../../shared/domain/diff";
import { DiffView } from "../../diff-view/DiffView";
import { highlightRequestCount } from "../../diff-view/highlight/pool";
import type { DiffAnchor, DiffViewHandle, DiffViewMode } from "../../diff-view/types";
import { DEFAULT_CONTEXT_LINES } from "../../diff-view/types";
import { useResolvedTheme } from "../../lib/use-resolved-theme";
import { listLargeFixtures, loadLargeFixture, SMALL_FIXTURES } from "./fixtures";

const MODES: readonly DiffViewMode[] = ["split", "unified", "result"];
const RAPID_SWITCHES = 50;

interface Selection {
  name: string;
  diff: FileDiff;
}

/** What tests drive the lab through (`window.__diffLab`). */
export interface DiffLabControl {
  fixtures(): string[];
  select(name: string): Promise<void>;
  setMode(mode: DiffViewMode): void;
  /** Flips file and mode `RAPID_SWITCHES` times; `seed` varies where it ends. */
  rapidSwitch(seed?: number): Promise<{ name: string; mode: DiffViewMode }>;
  highlightRequests(): number;
  view(): DiffViewHandle | null;
  current(): { name: string; mode: DiffViewMode } | null;
}

declare global {
  interface Window {
    __diffLab?: DiffLabControl;
  }
}

export function DiffLab() {
  const theme = useResolvedTheme();
  const [large, setLarge] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection | null>(() => firstSmall());
  const [mode, setModeState] = useState<DiffViewMode>("split");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const viewRef = useRef<DiffViewHandle>(null);
  const pendingAnchor = useRef<DiffAnchor | null>(null);
  const hunkCursor = useRef(0);
  const stateRef = useRef({ name: selection?.name ?? "", mode });
  stateRef.current = { name: selection?.name ?? "", mode };

  useEffect(() => {
    void listLargeFixtures().then(setLarge);
  }, []);

  const names = useMemo(() => [...SMALL_FIXTURES.keys(), ...large], [large]);

  const select = useCallback(async (name: string) => {
    setError(null);
    const small = SMALL_FIXTURES.get(name);
    if (small !== undefined) {
      setSelection({ name, diff: small });
      return;
    }
    try {
      const diff = await loadLargeFixture(name);
      setSelection({ name, diff });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** Mode changes keep the first visible line in place, as the review screen will. */
  const setMode = useCallback((next: DiffViewMode) => {
    pendingAnchor.current = viewRef.current?.getAnchor() ?? null;
    setModeState(next);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mode change, after the new view mounted
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (anchor !== null) viewRef.current?.restoreAnchor(anchor);
  }, [mode]);

  const rapidSwitch = useCallback(async (seed = 0) => {
    setBusy(true);
    const smallNames = [...SMALL_FIXTURES.keys()];
    let last = { name: stateRef.current.name, mode: stateRef.current.mode };
    for (let i = 0; i < RAPID_SWITCHES; i += 1) {
      const name = smallNames[(i * 7 + 3 + seed) % smallNames.length] ?? last.name;
      const next = MODES[(i * 5 + 1 + seed) % MODES.length] ?? "split";
      const diff = SMALL_FIXTURES.get(name);
      if (diff !== undefined) setSelection({ name, diff });
      setModeState(next);
      last = { name, mode: next };
      // A macrotask between switches lets each one commit before the next arrives, well
      // before any highlight result can come back.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    setBusy(false);
    return last;
  }, []);

  useEffect(() => {
    window.__diffLab = {
      fixtures: () => names,
      select,
      setMode,
      rapidSwitch,
      highlightRequests: highlightRequestCount,
      view: () => viewRef.current,
      current: () => (stateRef.current.name === "" ? null : { ...stateRef.current }),
    };
    return () => {
      delete window.__diffLab;
    };
  }, [names, select, setMode, rapidSwitch]);

  const chooseTheme = (next: "light" | "dark") => {
    void window.treepeek.main.settings.set({ appearance: next });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-12 shrink-0 items-center gap-3 border-border border-b bg-chrome pr-4 pl-20 text-chrome-foreground">
        <span className="font-semibold text-sm tracking-tight">Diff lab</span>
        <span className="text-xs opacity-70">development only</span>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-border border-b bg-card px-4 py-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Fixture</span>
          <select
            className="rounded-md border border-input bg-background px-2 py-1"
            value={selection?.name ?? ""}
            data-testid="lab-fixture"
            onChange={(event) => void select(event.target.value)}
          >
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="flex gap-1">
          <legend className="sr-only">Mode</legend>
          {MODES.map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant="outline"
              aria-pressed={mode === candidate}
              className={cn(mode === candidate && "bg-accent text-accent-foreground")}
              onClick={() => setMode(candidate)}
            >
              {candidate}
            </Button>
          ))}
        </fieldset>

        <fieldset className="flex gap-1">
          <legend className="sr-only">Theme</legend>
          {(["light", "dark"] as const).map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant="outline"
              aria-pressed={theme === candidate}
              className={cn(
                "capitalize",
                theme === candidate && "bg-accent text-accent-foreground",
              )}
              onClick={() => chooseTheme(candidate)}
            >
              {candidate}
            </Button>
          ))}
        </fieldset>

        <Button
          size="sm"
          variant="outline"
          disabled={selection === null || selection.diff.hunks.length === 0}
          onClick={() => {
            const count = selection?.diff.hunks.length ?? 0;
            if (count === 0) return;
            hunkCursor.current = (hunkCursor.current + 1) % count;
            viewRef.current?.scrollToHunk(hunkCursor.current);
          }}
        >
          Next hunk
        </Button>

        <Button size="sm" variant="outline" disabled={busy} onClick={() => void rapidSwitch()}>
          Rapid switch ×{RAPID_SWITCHES}
        </Button>

        <span className="ml-auto text-muted-foreground text-xs" data-testid="lab-status">
          {selection === null
            ? "No fixture"
            : `${selection.diff.path} · +${selection.diff.stats.added} −${selection.diff.stats.removed}`}
        </span>
      </div>

      {error !== null && (
        <p className="shrink-0 px-4 py-2 text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      <main className="min-h-0 flex-1">
        {selection !== null && (
          <DiffView
            ref={viewRef}
            diff={selection.diff}
            mode={mode}
            theme={theme}
            contextLines={DEFAULT_CONTEXT_LINES}
          />
        )}
      </main>
    </div>
  );
}

function firstSmall(): Selection | null {
  const first = SMALL_FIXTURES.entries().next();
  if (first.done === true) return null;
  const [name, diff] = first.value;
  return { name, diff };
}
