/**
 * `@pierre/diffs` puts its theme CSS in a `<style>` element and its token colors and some
 * layout in `style` attributes. Treepeek's CSP (`style-src 'self'`, no `'unsafe-inline'`)
 * blocks both, which leaves the diff unthemed and unhighlighted. The CSSOM is outside the
 * CSP's reach, so this re-applies the same styles through it: each `<style>` element's text
 * goes into an adopted stylesheet, and each blocked `style` attribute is set again through
 * `element.style`. Nothing new is allowed in; only the library's own declarations apply.
 *
 * (`useCSSClasses`, which reads as the library's answer to this, is accepted but unused in
 * 1.6.x: tokens always carry inline styles.)
 */

export function applyStylesUnderCsp(root: ShadowRoot): () => void {
  const sheets = new Map<HTMLStyleElement, CSSStyleSheet>();

  const syncSheets = (): void => {
    let changed = false;
    for (const element of root.querySelectorAll("style")) {
      let sheet = sheets.get(element);
      if (sheet === undefined) {
        sheet = new CSSStyleSheet();
        sheets.set(element, sheet);
        changed = true;
      }
      const text = element.textContent ?? "";
      if (sheetText.get(sheet) !== text) {
        sheet.replaceSync(text);
        sheetText.set(sheet, text);
      }
    }
    for (const [element, sheet] of sheets) {
      if (element.getRootNode() !== root) {
        sheets.delete(element);
        sheetText.delete(sheet);
        changed = true;
      }
    }
    if (changed) {
      const own = new Set(sheets.values());
      const others = root.adoptedStyleSheets.filter((sheet) => !mirrored.has(sheet));
      for (const sheet of own) mirrored.add(sheet);
      root.adoptedStyleSheets = [...others, ...own];
    }
  };

  const observer = new MutationObserver((records) => {
    let styleTouched = false;
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof HTMLElement) reapply(record.target);
        continue;
      }
      if (isInsideStyle(record.target)) styleTouched = true;
      for (const node of record.addedNodes) {
        if (node instanceof HTMLStyleElement) styleTouched = true;
        else if (node instanceof Element) reapplyTree(node);
      }
      for (const node of record.removedNodes)
        if (node instanceof HTMLStyleElement) styleTouched = true;
    }
    if (styleTouched) syncSheets();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  syncSheets();
  reapplyTree(root);

  return () => {
    observer.disconnect();
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => !mirrored.has(sheet));
  };
}

const mirrored = new WeakSet<CSSStyleSheet>();
const sheetText = new WeakMap<CSSStyleSheet, string>();

function isInsideStyle(node: Node): boolean {
  return node instanceof HTMLStyleElement || node.parentNode instanceof HTMLStyleElement;
}

function reapplyTree(node: Element | ShadowRoot): void {
  if (node instanceof HTMLElement) reapply(node);
  for (const element of node.querySelectorAll<HTMLElement>("[style]")) reapply(element);
}

/**
 * A blocked `style` attribute leaves the element with no inline declarations. Setting the
 * same text through the CSSOM applies it (and rewrites the attribute, which then matches).
 */
function reapply(element: HTMLElement): void {
  const text = element.getAttribute("style");
  if (text === null || text === "" || element.style.length > 0) return;
  element.style.cssText = text;
}
