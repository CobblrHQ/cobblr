// /me/drive — let Claude drive the app you have open (Feature 3). A per-workspace
// permission, OFF by default. Three states: off / navigate (open pages for you) /
// navigate + observe (also let Claude see your clicks). Even when on, Claude can
// only drive a window AFTER you tap "use this window" in that tab.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Check } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import type { DriveMode } from "../hooks/useBrowserDrive";

const OPTIONS: Array<{ value: DriveMode; label: string; help: string }> = [
  { value: "off", label: "Off", help: "Claude can't touch this window. (Default.)" },
  { value: "navigate", label: "Navigate", help: "Claude can open pages and views for you — but never sees what you do." },
  { value: "navigate_observe", label: "Navigate + observe", help: "Claude drives AND sees your clicks and page changes in real time, so it can follow along." },
];

export function DriveSettingsPage() {
  usePageTitle("Browser driving");
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const qc = useQueryClient();
  const toast = useToast();

  const grant = useQuery({ queryKey: ["drive-grant", slug], queryFn: () => api.driveGrant(slug), enabled: !!slug });
  const set = useMutation({
    mutationFn: (mode: DriveMode) => api.setDriveGrant(slug, mode),
    onSuccess: (_d, mode) => {
      qc.setQueryData(["drive-grant", slug], { mode });
      qc.invalidateQueries({ queryKey: ["drive-grant", slug] });
      toast.success(mode === "off" ? "Browser driving turned off." : "Saved.");
    },
    onError: () => toast.error("Couldn't save that."),
  });

  const current: DriveMode = grant.data?.mode ?? "off";

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Monitor size={20} className="text-accent" />
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">browser driving</h1>
      </div>

      <p className="text-sm text-content dark:text-mortar-200">
        Let Claude (from Claude Code / Desktop on your machine, via MCP) drive the Cobblr tab you have open in{" "}
        <strong>this workspace</strong> — opening pages and views as a shared, collaborative session. It's{" "}
        <strong>off by default</strong>, and even when on, Claude only drives a window after you explicitly pick it.
      </p>

      {!slug ? (
        <div className="text-sm text-faint">No active workspace.</div>
      ) : (
        <div className="space-y-2">
          {OPTIONS.map((o) => {
            const selected = current === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => !selected && set.mutate(o.value)}
                className={
                  "w-full text-left rounded-lg border p-3 flex items-start gap-3 transition " +
                  (selected
                    ? "border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-950/40"
                    : "border-line dark:border-slate-700 hover:border-cobble-300 dark:hover:border-cobble-700")
                }
              >
                <span
                  className={
                    "mt-0.5 h-4 w-4 rounded-full border flex items-center justify-center shrink-0 " +
                    (selected ? "bg-cobble-600 border-cobble-600 text-white" : "border-line dark:border-slate-500")
                  }
                >
                  {selected && <Check size={11} />}
                </span>
                <span>
                  <span className="block text-sm font-medium text-content dark:text-mortar-100">{o.label}</span>
                  <span className="block text-xs text-faint">{o.help}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-faint">
        To connect from Claude, mint an API token with the <strong>Browser driving</strong> scope and point the Cobblr MCP
        server at this workspace. Disconnect anytime from the green indicator on the driven window.
      </p>
    </div>
  );
}
