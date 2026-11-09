import { useSyncExternalStore } from "react";

/**
 * The app's resolved theme, read from the `.dark` class the preload keeps on the root
 * element. Following the class (not `prefers-color-scheme`) is what makes the manual
 * Light and Dark settings apply.
 */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, read);
}

function read(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
