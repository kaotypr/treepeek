/**
 * Accessibility fixes for what `@pierre/diffs` renders into its shadow root, applied as it
 * appears. Only attributes are added; the library's own behaviour is untouched.
 *
 * - Its "show hidden lines" controls are `role="button"` elements with no accessible name.
 * - Its code panes (`[data-code]`: the old and new sides, or the unified one) scroll sideways
 *   when a line is wider than the pane, but cannot take focus, so a keyboard cannot scroll
 *   them (WCAG 2.1.1). Each becomes a named, focusable group.
 */

const LABELS: ReadonlyArray<readonly [string, string]> = [
  ["data-expand-up", "Show unchanged lines above"],
  ["data-expand-down", "Show unchanged lines below"],
  ["data-expand-both", "Show unchanged lines"],
];

const PANE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["data-deletions", "Old version"],
  ["data-additions", "New version"],
  ["data-unified", "Changes"],
];

function label(root: ShadowRoot): void {
  for (const button of root.querySelectorAll<HTMLElement>('[data-expand-button][role="button"]')) {
    if (button.hasAttribute("aria-label")) continue;
    const match = LABELS.find(([attribute]) => button.hasAttribute(attribute));
    button.setAttribute("aria-label", match?.[1] ?? "Show unchanged lines");
  }
  for (const pane of root.querySelectorAll<HTMLElement>("[data-code]")) {
    if (pane.hasAttribute("tabindex")) continue;
    const match = PANE_LABELS.find(([attribute]) => pane.hasAttribute(attribute));
    // `code` has a role that cannot be named; a group can.
    pane.setAttribute("role", "group");
    pane.setAttribute("aria-label", match?.[1] ?? "Code");
    pane.setAttribute("tabindex", "0");
  }
}

/**
 * Applies the fixes now and whenever the library renders more; answers the stop function.
 */
export function labelControls(root: ShadowRoot): () => void {
  label(root);
  const observer = new MutationObserver(() => label(root));
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
