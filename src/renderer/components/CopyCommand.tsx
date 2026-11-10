import { useState } from "react";
import { main } from "../data/client";

/**
 * A command for the person to run themselves (Treepeek never runs it), with a Copy button.
 */
export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex items-start gap-2">
      <code
        className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted px-2 py-1 font-mono text-foreground text-xs"
        data-testid="copy-command-text"
      >
        {command}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          const result = await main().clipboard.copy({ text: command, kind: "command" });
          setCopied(result.ok);
        }}
        className="shrink-0 rounded-md border border-input bg-card px-2 py-1 text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
