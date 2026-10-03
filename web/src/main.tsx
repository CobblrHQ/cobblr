import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { SettledMarker } from "./components/SettledMarker";
import { ApiError } from "./lib/api";
import { raiseBlockedAction } from "./lib/blocked-action";
import { App } from "./App";
import { ThemeProvider } from "./theme/ThemeContext";
import "./index.css";
import { listenForInstallPrompt } from "./lib/install-app";
import { registerServiceWorker } from "./lib/offline";

// Chromium's install prompt fires early and once per page; kept here so the
// tour's install step, minutes later, can raise the real one.
listenForInstallPrompt();
// Offline: the shell and the reads this device kept (#4226).
registerServiceWorker();

const queryClient = new QueryClient({
  // A write a person asked for in a View as (a Create, a Save) is refused and
  // says why in the shell's refusal sheet; the page's own background writes,
  // not mutations, are refused quietly (#4687).
  mutationCache: new MutationCache({
    onError: (e) => {
      if (e instanceof ApiError && e.code === "share_view_read_only" && e.blocked) raiseBlockedAction({ blocked: e.blocked, refused: null, subject: null });
    },
  }),
  defaultOptions: {
    queries: {
      // 30s stale window matches what the Phase 0 healthcheck poll
      // actually changes on; Milestone 2 will tighten per-query.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <App />
        <SettledMarker />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
