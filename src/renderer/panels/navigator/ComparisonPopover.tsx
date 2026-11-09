import { Popover } from "@base-ui/react/popover";
import { useEffect, useId, useState } from "react";
import { LISTABLE_COMPARISON_KINDS } from "../../../shared/domain/compare";
import { COMPARISON_HINTS, COMPARISON_LABELS } from "../../../shared/domain/comparison-hints";
import type { Checkout, TimelineEntry } from "../../../shared/domain/scan";
import { GearIcon } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { isIpcFailure } from "../../data/client";
import { START_KINDS, unavailableReason } from "../../data/comparison-availability";
import { useSelectedComparison } from "../../data/hooks/useSelection";
import { cn } from "../../lib/utils";
import { useUi } from "../../state/ui-store";

/**
 * Comparison settings (⚙, ⌘K): every kind with the prototype's one-line hint, kinds the
 * checkout cannot have disabled with the reason, the base ref for "Compare with another
 * base", and a start for this comparison only.
 */
export function ComparisonPopover({
  checkout,
  entry,
}: {
  checkout: Checkout;
  entry: TimelineEntry | undefined;
}) {
  const open = useUi((state) => state.comparisonOpen);
  const setOpen = useUi((state) => state.setComparisonOpen);
  const kind = useUi((state) => state.comparisonKind);
  const ref = useUi((state) => state.comparisonRef);
  const startOverride = useUi((state) => state.comparisonStartOverride);
  const setComparison = useUi((state) => state.setComparison);
  const { query } = useSelectedComparison();
  const groupName = useId();
  const refId = useId();
  const startId = useId();
  const errorId = useId();
  const [refDraft, setRefDraft] = useState(ref ?? "");
  const [startDraft, setStartDraft] = useState(startOverride ?? "");

  useEffect(() => setRefDraft(ref ?? ""), [ref]);
  useEffect(() => setStartDraft(startOverride ?? ""), [startOverride]);

  const error = query.error;
  const refError =
    isIpcFailure(error) && (error.code === "refNotFound" || error.code === "invalidRequest")
      ? error.message
      : null;

  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <Popover.Trigger
        aria-label="Comparison settings"
        title="Comparison settings (⌘K)"
        aria-keyshortcuts="Meta+K"
        data-testid="comparison-settings-button"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-hover"
      >
        <GearIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="right" align="start" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup
            className="w-[340px] rounded-lg border border-border bg-popover p-3 text-popover-foreground text-sm shadow-lg outline-none"
            data-testid="comparison-popover"
          >
            <Popover.Title className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">
              Show changes
            </Popover.Title>
            <div role="radiogroup" aria-label="Comparison" className="mt-2 flex flex-col gap-1">
              {LISTABLE_COMPARISON_KINDS.map((candidate) => {
                const reason = unavailableReason(candidate, checkout, entry, { startOverride });
                const id = `${groupName}-${candidate}`;
                return (
                  <label
                    key={candidate}
                    htmlFor={id}
                    className={cn(
                      "flex gap-2 rounded-md px-2 py-1.5",
                      reason === null ? "cursor-default hover:bg-hover" : "opacity-60",
                      kind === candidate && "bg-selection text-selection-foreground",
                    )}
                    data-kind={candidate}
                  >
                    <input
                      id={id}
                      type="radio"
                      name={groupName}
                      value={candidate}
                      checked={kind === candidate}
                      disabled={reason !== null}
                      onChange={() => setComparison({ kind: candidate })}
                      className="mt-0.5 accent-primary-strong"
                      aria-describedby={`${id}-hint`}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-xs">
                        {COMPARISON_LABELS[candidate]}
                      </span>
                      <span
                        id={`${id}-hint`}
                        className={cn(
                          "block text-xs",
                          kind === candidate ? "opacity-80" : "text-muted-foreground",
                        )}
                      >
                        {reason ?? COMPARISON_HINTS[candidate]}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>

            {kind === "base" && (
              <form
                className="mt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const next = refDraft.trim();
                  setComparison({ kind: "base", ref: next === "" ? null : next });
                }}
              >
                <label htmlFor={refId} className="font-medium text-muted-foreground text-xs">
                  Base branch or commit
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id={refId}
                    value={refDraft}
                    onChange={(event) => setRefDraft(event.target.value)}
                    placeholder="main"
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={200}
                    aria-invalid={refError !== null}
                    aria-describedby={refError ? errorId : undefined}
                    className="h-7 min-w-0 flex-1 rounded-md border border-input bg-card px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="comparison-ref-input"
                  />
                  <Button type="submit" size="sm" variant="outline" className="h-7">
                    Compare
                  </Button>
                </div>
              </form>
            )}

            {START_KINDS.has(kind) && (
              <form
                className="mt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const next = startDraft.trim();
                  setComparison({ kind, startOverride: next === "" ? null : next });
                }}
              >
                <label htmlFor={startId} className="font-medium text-muted-foreground text-xs">
                  Starting commit for this comparison (optional)
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id={startId}
                    value={startDraft}
                    onChange={(event) => setStartDraft(event.target.value)}
                    placeholder="Override starting commit"
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={200}
                    aria-invalid={refError !== null}
                    aria-describedby={refError ? errorId : undefined}
                    className="h-7 min-w-0 flex-1 rounded-md border border-input bg-card px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="comparison-start-input"
                  />
                  <Button type="submit" size="sm" variant="outline" className="h-7">
                    Apply
                  </Button>
                </div>
              </form>
            )}

            {refError && (
              <p
                id={errorId}
                role="alert"
                className="mt-2 text-destructive text-xs"
                data-testid="comparison-error"
              >
                {refError}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
