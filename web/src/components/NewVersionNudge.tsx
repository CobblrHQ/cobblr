// "New version available — refresh" nudge. An SPA tab keeps running the
// bundle it loaded; with several deploys a day (the author iterating live) an open
// tab silently goes stale and "the fix isn't there" confusion follows. Poll
// /healthz's runtime build_sha (COBBLR_BUILD_SHA — set by the deploy env);
// when it changes from the sha this tab first saw, show a persistent pill.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

const POLL_MS = 3 * 60_000;

export function NewVersionNudge() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let first: string | null = null;
    let stop = false;
    async function check() {
      try {
        const res = await fetch("/api/v1/healthz", { cache: "no-store" });
        const j = (await res.json()) as { build_sha?: string | null };
        const sha = j.build_sha ?? null;
        if (!sha || stop) return;
        if (first === null) first = sha;
        else if (sha !== first) setStale(true);
      } catch {
        /* offline/blip — try again next tick */
      }
    }
    void check();
    const t = setInterval(() => void check(), POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, []);
  if (!stale) return null;
  return (
    <div className="fixed bottom-16 md:bottom-4 left-1/2 -translate-x-1/2 z-[90]">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="flex items-center gap-2 rounded-full border border-cobble-400 dark:border-cobble-600 bg-surface dark:bg-slate-900 shadow-lg px-4 py-2 text-sm font-medium text-content dark:text-mortar-100 hover:border-accent transition"
      >
        <RefreshCw size={14} className="text-accent" />
        A new version is available — tap to refresh
      </button>
    </div>
  );
}
