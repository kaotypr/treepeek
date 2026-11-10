import { CSPProvider } from "@base-ui/react/csp-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

/** One query client per window: core data is cached for this window's scan only. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
      mutations: { retry: false },
    },
  });
}

/**
 * The window's providers. Base UI is told not to write `<style>` elements, which the strict
 * CSP would block; its components are styled through classes instead.
 */
export function Providers({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return (
    <CSPProvider disableStyleElements>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </CSPProvider>
  );
}
