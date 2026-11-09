/**
 * `@pierre/diffs` draws its "show hidden lines" controls as `role="button"` elements with
 * no accessible name. This names them, in the shadow root the library renders into, as
 * they appear. Only `aria-label` is added; the library's own behaviour is untouched.
 */

const LABELS: ReadonlyArray<readonly [string, string]> = [
  ["data-expand-up", "Show unchanged lines above"],
  ["data-expand-down", "Show unchanged lines below"],
  ["data-expand-both", "Show unchanged lines"],
];

function label(root: ShadowRoot): void {
  for (const button of root.querySelectorAll<HTMLElement>('[data-expand-button][role="button"]')) {
    if (button.hasAttribute("aria-label")) continue;
    const match = LABELS.find(([attribute]) => button.hasAttribute(attribute));
    button.setAttribute("aria-label", match?.[1] ?? "Show unchanged lines");
  }
}

/** Names the library's controls now and whenever it renders more; answers the stop function. */
export function labelControls(root: ShadowRoot): () => void {
  label(root);
  const observer = new MutationObserver(() => label(root));
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
