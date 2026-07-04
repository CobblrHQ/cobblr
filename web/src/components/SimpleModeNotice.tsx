// A thin, PERMANENT notice shown while the workspace is in simple mode — parked
// in the app shell right where the email-verify nudge sits. Simple mode hides
// Configuration from the nav, so this is the always-visible way back out for the
// owner/admin who turned it on (one click → PATCH focused=false → reload the
// shell). Deliberately NOT dismissible: it IS the exit, so it stays put.

import { useState } from "react";
import { Sliders } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { isFocused, setFocused } from "../lib/api";

export function SimpleModeNotice({ variant = "bar" }: { variant?: "bar" | "sidebar" } = {}) {
  const { activeOrg, activeSlug } = useActiveOrg();
  const [busy, setBusy] = useState(false);
  const canFocus = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  if (!isFocused(activeOrg) || !canFocus) return null;

  const turnOff = async () => {
    setBusy(true);
    try {
      await setFocused(activeSlug, false);
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };

  // Sidebar-card variant (full-sidebar mode): a thin notice docked above the
  // action cluster, same home as the verify-email card.
  if (variant === "sidebar") {
    return (
      <div className="mx-2 mb-1.5 rounded-lg border border-cobble-200 dark:border-cobble-900/40 bg-cobble-50 dark:bg-cobble-900/20 px-2.5 py-1.5 text-[11px] text-content dark:text-mortar-200 flex items-center gap-1.5">
        <Sliders size={12} className="shrink-0 text-accent" />
        <span className="flex-1 min-w-0">Simple mode is on.</span>
        <button
          type="button"
          onClick={() => void turnOff()}
          disabled={busy}
          className="shrink-0 font-medium text-accent underline hover:no-underline disabled:opacity-50"
        >
          {busy ? "…" : "Turn it off"}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-cobble-50 dark:bg-cobble-900/20 border-b border-cobble-200 dark:border-cobble-900/40">
      <div className="max-w-6xl mx-auto px-5 py-2 flex items-center gap-3 text-xs text-content dark:text-mortar-200">
        <Sliders size={14} className="shrink-0 text-accent" />
        <span className="flex-1 min-w-0">Simple mode is on — Configuration is tucked away.</span>
        <button
          type="button"
          onClick={() => void turnOff()}
          disabled={busy}
          className="shrink-0 font-medium text-accent underline hover:no-underline disabled:opacity-50"
        >
          {busy ? "Turning off…" : "Turn it off"}
        </button>
      </div>
    </div>
  );
}
