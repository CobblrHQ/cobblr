// "New version available" nudge. An SPA tab keeps running the bundle it loaded;
// with several deploys a day (the author iterating live) an open tab silently
// goes stale and "the fix isn't there" confusion follows. Poll /healthz's runtime
// build_sha (COBBLR_BUILD_SHA — set by the deploy env); when it changes from the
// sha this tab first saw, raise it as a sticky ACTION TOAST, where every other
// toast goes (bottom-right), instead of a fixed pill floating over the bottom-
// middle of the content (the author, 2026-07-10).
import { useEffect, useRef } from "react";
import { useToast } from "@cobblr/platform-web";

const POLL_MS = 3 * 60_000;

export function NewVersionNudge() {
  // Keep the live toast api in a ref so the poll effect runs ONCE (an unstable
  // ctx value must not restart the interval + reset the first-seen sha).
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const fired = useRef(false);
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
        else if (sha !== first && !fired.current) {
          fired.current = true; // one toast per stale tab
          toastRef.current.action("A new version is available.", {
            actionLabel: "Refresh",
            onAction: () => window.location.reload(),
            duration: 0, // sticky until they refresh or dismiss it
          });
        }
      } catch {
        /* offline/blip — try again next tick */
      }
    }
    void check();
    const t = setInterval(() => void check(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  return null; // it's a toast now — nothing to render inline
}
