import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useId, useState } from "react";
import { type Checkout, isKnownStart } from "../../../shared/domain/scan";
import { Button } from "../../components/ui/button";
import { useStartOverride } from "../../data/hooks/useStartOverride";

/**
 * Sets the start Treepeek uses for a checkout (stored for this worktree), or clears it so
 * the start comes from the reflog again. The core service checks the commit; a name it
 * cannot resolve shows its message here.
 */
export function StartOverrideDialog({
  checkout,
  open,
  onOpenChange,
}: {
  checkout: Checkout;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useStartOverride();
  const inputId = useId();
  const errorId = useId();
  const overridden = isKnownStart(checkout.start) && checkout.start.source === "override";
  const [draft, setDraft] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: resets each time it opens
  useEffect(() => {
    if (open) {
      setDraft(overridden && isKnownStart(checkout.start) ? checkout.start.commit : "");
      mutation.reset();
    }
  }, [open]);

  const submit = (commit: string | null) =>
    mutation.mutate(
      { checkoutPath: checkout.path, commit },
      { onSuccess: () => onOpenChange(false) },
    );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-backdrop" />
        <Dialog.Popup
          className="fixed top-1/2 left-1/2 z-50 w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none"
          data-testid="start-override-dialog"
        >
          <Dialog.Title className="font-semibold text-base">Set start</Dialog.Title>
          <Dialog.Description className="mt-1 text-muted-foreground text-sm">
            The commit this worktree started from. Its review covers every change since then.
          </Dialog.Description>
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              const commit = draft.trim();
              if (commit !== "") submit(commit);
            }}
          >
            <label htmlFor={inputId} className="font-medium text-xs">
              Commit, branch or tag
            </label>
            <input
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              maxLength={200}
              aria-invalid={mutation.isError}
              aria-describedby={mutation.isError ? errorId : undefined}
              className="mt-1 h-8 w-full rounded-md border border-input bg-card px-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="start-override-input"
            />
            {mutation.isError && (
              <p id={errorId} role="alert" className="mt-2 text-destructive text-xs">
                {mutation.error.message}
              </p>
            )}
            <div className="mt-5 flex items-center justify-between gap-2">
              {overridden ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => submit(null)}
                >
                  Use the first-seen start
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Dialog.Close render={<Button type="button" variant="outline" size="sm" />}>
                  Cancel
                </Dialog.Close>
                <Button
                  type="submit"
                  size="sm"
                  disabled={mutation.isPending || draft.trim() === ""}
                >
                  Set start
                </Button>
              </div>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
