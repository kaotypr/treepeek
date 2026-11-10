import { skipToken, useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext } from "react";
import type { Checkout } from "../../../shared/domain/scan";
import { keys } from "../keys";
import { emptyScan, type ScanData } from "../scan-model";

export interface ScanContextValue {
  scanRoot: string;
  /** Opens the session again and rescans, keeping what is on screen until it is replaced. */
  rescan: () => Promise<void>;
}

export const ScanContext = createContext<ScanContextValue | null>(null);

export function useScanContext(): ScanContextValue {
  const value = useContext(ScanContext);
  if (value === null) throw new Error("useScanContext() outside a scan window");
  return value;
}

/**
 * A slice of the window's scan: folders, checkouts, timeline, repositories, phase. The
 * scan stream writes the data; this only reads it, re-rendering when the slice changes.
 */
export function useScan<T>(select: (scan: ScanData) => T): T {
  const { scanRoot } = useScanContext();
  const query = useQuery({
    queryKey: keys.scan(scanRoot),
    queryFn: skipToken,
    initialData: () => emptyScan(scanRoot),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    select,
  });
  // The initial data makes this unreachable; the type cannot tell.
  return query.data === undefined ? select(emptyScan(scanRoot)) : query.data;
}

/** One checkout as the scan last reported it. */
export function useCheckout(path: string | null): Checkout | undefined {
  return useScan(
    useCallback((scan: ScanData) => (path ? scan.checkouts[path] : undefined), [path]),
  );
}
