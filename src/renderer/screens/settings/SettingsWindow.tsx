import { type ReactNode, useEffect, useState } from "react";
import type { SettingsSection } from "../../../shared/ipc/contract";
import { cn } from "../../lib/utils";
import { AdvancedSection } from "./AdvancedSection";
import { GeneralSection } from "./GeneralSection";
import { GitSection } from "./GitSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { ReviewSection } from "./ReviewSection";
import { UpdatesSection } from "./UpdatesSection";

const SECTIONS: readonly { id: SettingsSection; label: string; content: () => ReactNode }[] = [
  { id: "general", label: "General", content: () => <GeneralSection /> },
  { id: "review", label: "Review", content: () => <ReviewSection /> },
  { id: "integrations", label: "Integrations", content: () => <IntegrationsSection /> },
  { id: "git", label: "Git", content: () => <GitSection /> },
  { id: "updates", label: "Updates", content: () => <UpdatesSection /> },
  { id: "advanced", label: "Advanced", content: () => <AdvancedSection /> },
];

/**
 * The Settings window (⌘,): one section at a time, picked in the sidebar. Every change
 * saves at once and applies without a restart; main tells every window.
 */
export function SettingsWindow() {
  const [section, setSection] = useState<SettingsSection>("general");
  useEffect(
    () => window.treepeek.on("settings.section", (payload) => setSection(payload.section)),
    [],
  );
  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];
  return (
    <div
      className="flex h-full flex-col bg-background text-foreground"
      data-testid="settings-window"
    >
      <header className="app-drag flex h-11 shrink-0 items-center justify-center border-border border-b">
        <h1 className="font-semibold text-sm">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="w-44 shrink-0 border-border border-r bg-muted p-2"
        >
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === section ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    "w-full rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                    item.id === section && "bg-selection text-selection-foreground",
                  )}
                  data-testid={`settings-nav-${item.id}`}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-h-0 flex-1 overflow-auto px-8 py-6" data-section={section}>
          {current?.content()}
        </main>
      </div>
    </div>
  );
}
