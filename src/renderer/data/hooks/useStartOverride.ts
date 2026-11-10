import { useMutation, useQueryClient } from "@tanstack/react-query";
import { core, unwrap } from "../client";
import { keys } from "../keys";
import type { ScanData } from "../scan-model";
import { useScanContext } from "./useScan";

/**
 * Sets (`commit`) or clears (`null`) a checkout's stored start. The answer replaces the
 * checkout in the scan; its comparisons are fetched again; and, since the timeline orders
 * checkouts by their starts, the scan runs again to bring the timeline up to date.
 */
export function useStartOverride() {
  const queryClient = useQueryClient();
  const { scanRoot, rescan } = useScanContext();
  return useMutation({
    mutationFn: async ({ checkoutPath, commit }: { checkoutPath: string; commit: string | null }) =>
      unwrap(await core().start.override({ checkoutPath, commit })),
    onSuccess: (checkout) => {
      queryClient.setQueryData<ScanData>(keys.scan(scanRoot), (scan) =>
        scan ? { ...scan, checkouts: { ...scan.checkouts, [checkout.path]: checkout } } : scan,
      );
      void queryClient.invalidateQueries({ queryKey: keys.checkoutComparisons(checkout.path) });
      void rescan();
    },
  });
}
