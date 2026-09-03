import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import App from "./App";
import { wagmiConfig } from "./lib/wagmi";
import { isApiError } from "./lib/api";
import "./index.css";

// One client for the whole app: wagmi's chain reads and the API queries share it,
// so a task that is polled by two pages is still only fetched once.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Every cadence is set per hook in hooks/useProofRelay.ts; nothing polls by default.
      refetchOnWindowFocus: false,
      staleTime: 5_000,
      // Retry only what a retry can fix. Blanket retries turn a rate-limit
      // response into a retry storm: each 429 produces two more requests,
      // which produce more 429s, and the UI never leaves its skeletons even
      // though the API is healthy. ApiError already knows which codes a second
      // attempt could help with.
      retry: (failureCount, error) => failureCount < 2 && isApiError(error) && error.retryable,
      retryDelay: (attempt) => Math.min(8_000, 500 * 2 ** attempt),
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </WagmiProvider>,
);
