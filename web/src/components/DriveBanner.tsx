// DriveBanner — the always-mounted UI for Feature 3 (Claude drives the app you
// have open). Reads the active workspace's drive grant, runs the SSE hook, and
// renders: the "Claude wants to drive — use this window?" prompt, the green
// "driving this window" indicator (+ instant disconnect), and the red "driving a
// different window" indicator. Renders nothing when driving is off or idle.

import { useQuery } from "@tanstack/react-query";
import { MonitorCheck, MonitorX, X } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { useBrowserDrive, type DriveMode } from "../hooks/useBrowserDrive";
import { DrivePresenceOverlay } from "./DrivePresenceOverlay";

export function DriveBanner() {
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  // The grant is the only thing that turns this on; default off → the hook idles.
  const { data } = useQuery({
    queryKey: ["drive-grant", slug],
    queryFn: () => api.driveGrant(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  const mode: DriveMode = data?.mode ?? "off";
  const { state, accept, release, presence } = useBrowserDrive(slug || undefined, mode);

  if (mode === "off" || state === "idle") return null;

  if (state === "offer") {
    return (
      <div className="fixed bottom-4 right-4 z-[1000] w-80 rounded-xl border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 shadow-xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <MonitorCheck size={18} className="text-cobble-600 shrink-0 mt-0.5" />
          <div className="text-sm text-content dark:text-mortar-100">
            <strong>Claude wants to drive.</strong> Use <em>this</em> window?
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={accept}
            className="flex-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5"
          >
            Yes, use this window
          </button>
          <button
            type="button"
            onClick={release}
            className="rounded-md border border-line dark:border-slate-600 text-sm px-3 py-1.5 hover:bg-mortar-50 dark:hover:bg-slate-800"
          >
            Not here
          </button>
        </div>
      </div>
    );
  }

  if (state === "active") {
    return (
      <>
        <DrivePresenceOverlay presence={presence} />
        <div className="fixed bottom-4 right-4 z-[1000] flex items-center gap-2 rounded-full border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 shadow-lg pl-3 pr-1.5 py-1.5 text-sm">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
        </span>
        <span className="font-medium">Claude is driving this window</span>
        <button
          type="button"
          onClick={release}
          title="Disconnect"
          className="ml-1 rounded-full p-1 hover:bg-emerald-100 dark:hover:bg-emerald-800"
        >
          <X size={14} />
        </button>
        </div>
      </>
    );
  }

  // state === "elsewhere"
  return (
    <div className="fixed bottom-4 right-4 z-[1000] flex items-center gap-2 rounded-full border border-ember-300 dark:border-ember-700 bg-ember-50 dark:bg-ember-900/40 text-ember-800 dark:text-ember-200 shadow-lg px-3 py-1.5 text-sm">
      <MonitorX size={14} />
      <span className="font-medium">Claude is driving a different window</span>
    </div>
  );
}
