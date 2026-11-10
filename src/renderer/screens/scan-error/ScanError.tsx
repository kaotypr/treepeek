import { useState } from "react";
import type { ScanRootProblem } from "../../../shared/domain/scan";
import { Button } from "../../components/ui/button";
import { main } from "../../data/client";

const TITLES: Readonly<Record<ScanRootProblem, string>> = {
  unreadable: "Treepeek can't read this folder",
  missing: "This folder no longer exists",
  notAFolder: "This is not a folder",
};

const EXPLANATIONS: Readonly<Record<ScanRootProblem, string>> = {
  unreadable:
    "Its permissions do not let you list what is inside, or macOS is keeping Treepeek out of it (System Settings › Privacy & Security › Files and Folders).",
  missing: "It may have been moved, renamed or deleted, or its disk is not connected.",
  notAFolder: "Treepeek scans folders for Git checkouts.",
};

/**
 * Shown instead of the scan when the window's folder itself cannot be scanned (user-
 * interface design, "Special screens"). "Choose another folder" opens the chosen one and
 * closes this window.
 */
export function ScanError({
  scanRoot,
  problem,
  message,
  onRetry,
}: {
  scanRoot: string;
  problem: ScanRootProblem;
  message: string;
  onRetry: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const chooseAnother = async () => {
    setFailure(null);
    const result = await main().folder.choose({ replace: true });
    if (!result.ok) setFailure(result.error.message);
  };
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-8"
      data-testid="scan-error"
    >
      <section
        aria-labelledby="scan-error-title"
        className="w-full max-w-lg rounded-xl border border-border bg-card p-6 text-card-foreground text-sm"
        data-problem={problem}
      >
        <h1 id="scan-error-title" className="font-semibold text-lg">
          {TITLES[problem]}
        </h1>
        <p className="mt-2 break-all font-mono text-muted-foreground text-xs">{scanRoot}</p>
        <p className="mt-3">{message}</p>
        <p className="mt-1 text-muted-foreground">{EXPLANATIONS[problem]}</p>
        {failure && (
          <p role="alert" className="mt-3 text-destructive">
            {failure}
          </p>
        )}
        <div className="mt-5 flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void chooseAnother()}
            data-testid="choose-another-folder"
          >
            Choose Another Folder…
          </Button>
          <Button variant="outline" size="sm" onClick={onRetry} data-testid="scan-error-retry">
            Try Again
          </Button>
        </div>
      </section>
    </div>
  );
}
