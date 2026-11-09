import type { FileChange } from "../../../shared/domain/compare";
import type { DiffStats } from "../../../shared/domain/diff";
import { PREVIEW_MODES, type PreviewMode } from "../../../shared/settings";
import { shortcutLabel } from "../../commands/keymap";
import { FocusIcon } from "../../components/icons";
import { cn } from "../../lib/utils";
import { useUi } from "../../state/ui-store";
import { toAriaShortcut } from "../Toolbar";

const MODE_LABEL: Readonly<Record<PreviewMode, string>> = {
  split: "Side by side",
  unified: "Unified",
  result: "Resulting file",
};

const MODE_COMMAND = {
  split: "preview.split",
  unified: "preview.unified",
  result: "preview.result",
} as const;

/** File name (or `old → new`), the preview modes, Focus preview and the line counts. */
export function PreviewHeader({
  file,
  stats,
}: {
  file: FileChange | undefined;
  stats: DiffStats | undefined;
}) {
  const mode = useUi((state) => state.previewMode);
  const setMode = useUi((state) => state.setPreviewMode);
  const focus = useUi((state) => state.focusPreview);
  const setFocus = useUi((state) => state.setFocusPreview);
  const resultDisabled = file?.status === "deleted";

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-border border-b px-3 py-2"
      data-testid="preview-header"
    >
      <h2
        className="min-w-0 flex-1 truncate font-mono font-semibold text-xs"
        title={file ? title(file) : undefined}
        data-testid="preview-title"
      >
        {file ? title(file) : "Select a file"}
      </h2>
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-style button group, not a form */}
      <div
        role="group"
        aria-label="Preview mode"
        className="flex overflow-hidden rounded-md border border-input"
      >
        {PREVIEW_MODES.map((candidate) => {
          const shortcut = shortcutLabel(MODE_COMMAND[candidate]);
          const disabled = candidate === "result" && resultDisabled;
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={mode === candidate}
              disabled={disabled}
              title={
                disabled
                  ? "There is no resulting file for a deleted file"
                  : `${MODE_LABEL[candidate]} (${shortcut})`
              }
              aria-keyshortcuts={shortcut ? toAriaShortcut(shortcut) : undefined}
              onClick={() => setMode(candidate)}
              className={cn(
                "border-input border-l px-2 py-0.5 text-xs outline-none first:border-l-0 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50",
                mode === candidate ? "bg-selection text-selection-foreground" : "bg-card",
              )}
              data-mode={candidate}
            >
              {MODE_LABEL[candidate]}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-pressed={focus}
        aria-label="Focus preview"
        aria-keyshortcuts="Meta+Shift+F"
        title={`Focus preview (${shortcutLabel("preview.focus")})`}
        onClick={() => setFocus(!focus)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-md border border-input px-2 text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
          focus ? "bg-selection text-selection-foreground" : "bg-card",
        )}
        data-testid="focus-preview"
      >
        <FocusIcon className="size-3.5" />
        Focus
      </button>
      {stats && (
        <p className="font-mono text-xs" data-testid="preview-stats">
          <span className="text-diff-added-foreground">+{stats.added}</span>{" "}
          <span className="text-diff-removed-foreground">−{stats.removed}</span>
          <span className="sr-only">
            {stats.added} lines added, {stats.removed} removed
          </span>
        </p>
      )}
    </div>
  );
}

function title(file: FileChange): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}
