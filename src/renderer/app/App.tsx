import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";
import { useEffect, useId, useState } from "react";
import type { CoreState } from "../../shared/ipc/contract";
import type { Appearance, ResolvedTheme } from "../../shared/settings";

type Ping =
  | { state: "pending" }
  | { state: "ok"; detail: string }
  | { state: "error"; detail: string };

const CORE_LABEL: Record<CoreState, string> = {
  ready: "Ready",
  restarting: "Reconnecting…",
  failed: "Stopped after repeated failures",
};

/**
 * Placeholder screen for the app foundation: shows that every process answers and lets the
 * appearance be switched. The review screen replaces it.
 */
export function App() {
  const [core, setCore] = useState<CoreState | null>(null);
  const [resolved, setResolved] = useState<ResolvedTheme | null>(null);
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  const [mainPing, setMainPing] = useState<Ping>({ state: "pending" });
  const [corePing, setCorePing] = useState<Ping>({ state: "pending" });
  const switchId = useId();

  useEffect(() => window.treepeek.on("core.state", (payload) => setCore(payload.state)), []);
  useEffect(
    () =>
      window.treepeek.on("theme.changed", (payload) => {
        setResolved(payload.resolved);
        setAppearance(payload.source);
      }),
    [],
  );

  useEffect(() => {
    void window.treepeek.main.app.ping().then((result) => {
      setMainPing(
        result.ok
          ? { state: "ok", detail: "Answering" }
          : { state: "error", detail: result.error.message },
      );
    });
  }, []);

  useEffect(() => {
    if (core !== "ready") {
      setCorePing({ state: "pending" });
      return;
    }
    let live = true;
    void window.treepeek.core.app.ping().then((result) => {
      if (!live) return;
      setCorePing(
        result.ok
          ? { state: "ok", detail: `Answering (process ${result.value.pid})` }
          : { state: "error", detail: result.error.message },
      );
    });
    return () => {
      live = false;
    };
  }, [core]);

  const choose = async (next: Appearance) => {
    const result = await window.treepeek.main.settings.set({ appearance: next });
    if (result.ok) setAppearance(result.value.appearance);
  };

  const followsSystem = appearance === "system";

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-12 shrink-0 items-center border-border border-b bg-chrome pr-4 pl-20 text-chrome-foreground">
        <span className="font-semibold text-sm tracking-tight">Treepeek</span>
      </header>

      <main className="flex flex-1 items-center justify-center overflow-auto p-8">
        <section
          aria-labelledby="welcome-title"
          className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm"
        >
          <h1 id="welcome-title" className="font-semibold text-2xl tracking-tight">
            Treepeek
          </h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Review the Git worktrees beneath a folder. Folder scanning arrives in a later version.
          </p>

          <dl className="mt-6 divide-y divide-border rounded-lg border border-border">
            <StatusRow label="Core service" value={core ? CORE_LABEL[core] : "Starting…"} />
            <StatusRow label="Main process" ping={mainPing} />
            <StatusRow label="Core service ping" ping={corePing} />
          </dl>

          <div className="mt-6">
            <h2 className="font-medium text-sm">Appearance</h2>
            <div className="mt-3 flex items-center justify-between gap-4">
              <label htmlFor={switchId} className="text-sm">
                Match system appearance
              </label>
              <Switch
                id={switchId}
                checked={followsSystem}
                disabled={appearance === null}
                onCheckedChange={(checked) => {
                  void choose(checked ? "system" : (resolved ?? "light"));
                }}
              />
            </div>
            <fieldset className="mt-3 flex gap-2" disabled={followsSystem || appearance === null}>
              <legend className="sr-only">Theme</legend>
              {(["light", "dark"] as const).map((theme) => (
                <Button
                  key={theme}
                  variant="outline"
                  size="sm"
                  aria-pressed={!followsSystem && appearance === theme}
                  className={cn(
                    "flex-1 capitalize",
                    !followsSystem && appearance === theme && "bg-accent text-accent-foreground",
                  )}
                  disabled={followsSystem || appearance === null}
                  onClick={() => void choose(theme)}
                >
                  {theme}
                </Button>
              ))}
            </fieldset>
            <p className="mt-2 text-muted-foreground text-xs" data-testid="resolved-theme">
              {resolved ? `Showing the ${resolved} theme.` : " "}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

function StatusRow({ label, value, ping }: { label: string; value?: string; ping?: Ping }) {
  const text =
    value ?? (ping?.state === "ok" || ping?.state === "error" ? ping.detail : "Checking…");
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("text-right", ping?.state === "error" && "text-destructive")}>{text}</dd>
    </div>
  );
}
