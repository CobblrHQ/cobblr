import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettledMarker } from "./components/SettledMarker";
import { ApiError } from "./lib/api";
import { raiseBlockedAction } from "./lib/blocked-action";
import { PersonsWritesCache, WAITING_MUTATIONS } from "./lib/offline-writes";
import { ThemeProvider } from "./theme/ThemeContext";
import "./index.css";
import { App } from "./App";
import { awaitPanelRegistrations, panelRegistrationsDone } from "@cobblr/platform-web";

const queryClient = new QueryClient({
  // A write a person asked for in a View as (a Create, a Save) is refused and
  // says why in the shell's refusal sheet; the page's own background writes,
  // not mutations, are refused quietly (#4687).
  mutationCache: new PersonsWritesCache({
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
    // A write made offline reaches its door once, which keeps it on this
    // device, then waits for the connection (lib/offline-writes.ts, #7863).
    mutations: WAITING_MUTATIONS,
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

// Every detail panel (History, Links, Photos and files, Tags, a module's own)
// registers from the moment the app starts, whatever page opens first. They
// used to register only when one of the pages importing the panel registry
// loaded, so a module's own detail page opened first (a classic part on a
// phone, a list, a project) had none of them (#5954). Its own chunk, started
// here: the panel host re-renders when they arrive (useSyncExternalStore), so
// they cost the first paint nothing. e2e/every-record-detail-shows-its-history.mjs
// holds it.
// Until it has run, a view's toolbar and a record's panels wait for it rather
// than arriving over a page already drawn (#6881).
awaitPanelRegistrations();
void import("./panels/detail-panels").catch((err) => {
  console.error("[panels] the record panels could not load:", err);
  panelRegistrationsDone();
});
// The shell is ready; the boot guard can stop waiting.
(window as { __cobblrStarted?: () => void }).__cobblrStarted?.();
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
