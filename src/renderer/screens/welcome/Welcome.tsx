import { FolderIcon } from "@renderer/components/icons";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { main, unwrap } from "../../data/client";
import { baseName } from "../../data/scan-model";

const SETTINGS_KEY = ["settings"] as const;

/**
 * The welcome window: shown at launch with nothing to restore, and whenever every scan
 * window has closed. Opening a folder replaces it with that folder's window. A folder
 * dropped anywhere on the window opens too (the preload reads the drop).
 */
export function Welcome() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => unwrap(await main().settings.get()),
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const recent = settings.data?.recentFolders ?? [];

  const openRecent = async (path: string) => {
    setProblem(null);
    const result = await main().folder.openRecent({ path });
    if (!result.ok) {
      setProblem(result.error.message);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag feedback only; the preload opens the dropped folder
    <div
      className={cn("flex h-full flex-col transition-colors", dragging && "bg-accent")}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={() => setDragging(false)}
      data-testid="welcome"
    >
      <header className="app-drag h-10 shrink-0" />
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-10 pb-10">
        <div className="text-center">
          <h1 className="font-semibold text-2xl tracking-tight">Treepeek</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Review the Git worktrees beneath a folder.
          </p>
        </div>
        <Button onClick={() => void main().folder.choose()} aria-keyshortcuts="Meta+O">
          Open Folder…
          <kbd className="font-sans text-xs opacity-70">⌘O</kbd>
        </Button>
        <p className="text-muted-foreground text-xs" aria-live="polite">
          {dragging ? "Drop the folder to open it." : "Or drop a folder onto this window."}
        </p>
        <section aria-labelledby="recent-title" className="w-full max-w-md">
          <h2
            id="recent-title"
            className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider"
          >
            Recent folders
          </h2>
          {recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">Folders you open appear here.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {recent.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void openRecent(path)}
                    title={path}
                  >
                    <FolderIcon className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-sm">{baseName(path)}</span>
                      <span className="block truncate text-muted-foreground text-xs">{path}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {problem && (
            <p role="alert" className="mt-2 text-destructive text-sm">
              {problem}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
