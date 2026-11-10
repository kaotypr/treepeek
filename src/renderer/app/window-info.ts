import { useEffect, useState } from "react";
import type { WindowKind } from "../../shared/ipc/contract";
import type { WindowUiState } from "../../shared/settings";
import { uiStore } from "../state/ui-store";

export interface WindowInfo {
  kind: WindowKind;
  scanRoot: string | null;
  ui: WindowUiState | null;
  vibrancy: boolean;
}

let hydrated = false;

/**
 * What main says this window shows (`window.scanRoot`). The saved layout is applied to the
 * UI store once, before the scan window's first render; later events only change vibrancy.
 */
export function useWindowInfo(): WindowInfo | null {
  const [info, setInfo] = useState<WindowInfo | null>(null);
  useEffect(
    () =>
      window.treepeek.on("window.scanRoot", (payload) => {
        if (!hydrated && payload.ui) uiStore.getState().hydrate(payload.ui);
        hydrated = true;
        setInfo(payload);
      }),
    [],
  );
  useEffect(() => {
    document.documentElement.classList.toggle("vibrancy", info?.vibrancy === true);
  }, [info?.vibrancy]);
  return info;
}
