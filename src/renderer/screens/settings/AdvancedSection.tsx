import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { core, isIpcFailure, main, unwrap } from "../../data/client";
import { Field, FieldMessage, SectionTitle } from "./Field";

const usageKey = ["review.storeUsage"] as const;

/** `12.4 MB`, `640 KB`, `0 bytes`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Advanced: the review snapshot store and clearing review data, and the logs folder. */
export function AdvancedSection() {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section aria-labelledby="settings-advanced" data-testid="settings-advanced">
      <SectionTitle id="settings-advanced">Advanced</SectionTitle>
      <ReviewData />
      <Field
        label="Logs"
        description="What Treepeek did, for troubleshooting. Logs name repository paths, never file contents."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const result = await main().logs.open();
            setProblem(result.ok ? null : result.error.message);
          }}
          data-testid="open-logs"
        >
          Open Logs Folder
        </Button>
        {problem && <FieldMessage tone="error">{problem}</FieldMessage>}
      </Field>
    </section>
  );
}

/**
 * How much the snapshot store holds (the content of files as they were viewed, kept for
 * "Since you viewed"), and "Clear review data…", which asks first: it deletes every mark
 * and snapshot on this Mac, in every window, and keeps the starts you set.
 */
function ReviewData() {
  const queryClient = useQueryClient();
  const usage = useQuery({
    queryKey: usageKey,
    queryFn: async () => unwrap(await core().review.storeUsage()),
    retry: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const clear = async () => {
    setConfirming(false);
    const result = await core().review.clearAll();
    if (result.ok) {
      setMessage({ tone: "ok", text: "Review data cleared." });
    } else {
      setMessage({ tone: "error", text: result.error.message });
    }
    await queryClient.invalidateQueries({ queryKey: usageKey });
  };

  return (
    <Field
      label="Review data"
      description="Marks and the snapshots “Since you viewed” compares with. They stay on this Mac."
    >
      <p data-testid="snapshot-usage">
        {usage.data
          ? `Snapshots: ${usage.data.count} (${formatBytes(usage.data.bytes)})`
          : usage.isError
            ? isIpcFailure(usage.error)
              ? usage.error.message
              : "The snapshot store could not be read."
            : "Reading…"}
      </p>
      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby="clear-review-title"
          aria-describedby="clear-review-description"
          className="mt-2 rounded-md border border-border bg-card p-3"
          data-testid="clear-review-confirm"
        >
          <p id="clear-review-title" className="font-medium">
            Clear all review data?
          </p>
          <p id="clear-review-description" className="mt-0.5 text-muted-foreground text-xs">
            Every Viewed mark and snapshot is deleted, in every window. Starts you set stay. This
            cannot be undone.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(false)}
              data-testid="clear-review-cancel"
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => void clear()} data-testid="clear-review-ok">
              Clear Review Data
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => {
            setMessage(null);
            setConfirming(true);
          }}
          data-testid="clear-review-data"
        >
          Clear Review Data…
        </Button>
      )}
      {message && (
        <FieldMessage tone={message.tone} testId="clear-review-message">
          {message.text}
        </FieldMessage>
      )}
    </Field>
  );
}
