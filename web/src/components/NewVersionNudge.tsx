// "New version available" notice. An SPA tab keeps running the bundle it loaded;
// with several deploys a day (the author iterating live) an open tab silently
// goes stale and "the fix isn't there" confusion follows. Poll /healthz's runtime
// build_sha (COBBLR_BUILD_SHA — set by the deploy env); when it changes from the
// sha this tab first saw, show a bar across the top that RESERVES its own room
// (FloatingChrome reserveTop: the page and every overlay start below it).
//
// It was a sticky toast, and a toast that stays floats over whatever is under
// it: on the phone scanner it was lifted above the Scanned sheet onto the mode
// buttons, Refresh exactly where Move is, so a press meant to change mode would
// reload the page (#6247). A notice that stays takes room; only a passing toast
// floats.
import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { FloatingChrome, useConfirm } from "@cobblr/platform-web";
import { isSandboxSession } from "../lib/sandbox-session";
import { healthzAtLoad, readHealthz } from "../lib/healthz";

const POLL_MS = 3 * 60_000;

export function NewVersionNudge() {
  const confirm = useConfirm();
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    // Not in a sandbox. This notice is for a tab somebody has kept open across
    // deploys; a sandbox lasts an hour and belongs to a stranger who is deciding
    // whether they like Cobblr. "A new version is available" means nothing to
    // them, it takes room on the page they came to look at, and it asks somebody
    // evaluating the product to do maintenance on it. They get the new build
    // with their next sandbox anyway.
    if (isSandboxSession()) return;
    let first: string | null = null;
    let stop = false;
    async function check() {
      try {
        // The first look is the load's own read, shared with the env badge.
        const j = first === null ? await healthzAtLoad() : await readHealthz();
        const sha = j.build_sha ?? null;
        if (!sha || stop) return;
        if (first === null) first = sha;
        else if (sha !== first) setStale(true);
      } catch {
        /* quiet: a background poll; offline or a blip, it tries again next tick */
      }
    }
    void check();
    const t = setInterval(() => void check(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  if (!stale || dismissed) return null;
  return (
    <FloatingChrome
      anchor="top"
      reserveTop
      yields={false}
      role="status"
      data-testid="new-version-notice"
      className="z-[190] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-cobble-700 px-4 py-2 text-center text-sm font-medium text-white shadow-md"
    >
      <span>A new version is available.</span>
      <button
        type="button"
        onClick={async () => {
          const discard = await confirm({
            title: "Refresh the app?",
            message: "Refreshing will discard any unfinished work. Save it first, or keep editing and refresh later.",
            confirmLabel: "Discard and refresh",
            cancelLabel: "Keep editing",
            destructive: true,
          });
          if (discard) window.location.reload();
        }}
        className="inline-flex items-center gap-1 rounded border border-white/60 px-2 py-0.5 text-xs font-semibold hover:bg-white/10"
      >
        <RefreshCw size={12} aria-hidden /> Refresh
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        className="inline-flex items-center rounded p-1 hover:bg-white/10"
      >
        <X size={14} aria-hidden />
      </button>
    </FloatingChrome>
  );
}
