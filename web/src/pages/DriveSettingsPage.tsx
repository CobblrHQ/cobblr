// /me/drive — let Claude drive the app you have open (Feature 3). A per-workspace
// permission, OFF by default. Three states: off / navigate (open pages for you) /
// navigate + observe (also let Claude see your clicks). Even when on, Claude can
// only drive a window AFTER you tap "use this window" in that tab.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Check } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError } from "../lib/api";
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

      {slug && <ConnectFromClaude slug={slug} />}
    </div>
  );
}

/** Mint the drive:control token + hand over a ready-to-paste connect command —
 *  the "how do I actually hook Claude up" step, done right here. */
function ConnectFromClaude({ slug }: { slug: string }) {
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const mint = useMutation({
    mutationFn: () => api.createApiToken({ name: `Browser driving (${slug})`, scopes: ["drive:control"] }),
    onSuccess: (r) => setToken(r.token),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't generate a token."),
  });
  const snippet = token
    ? [
        "# Claude Code (with the Cobblr MCP server from the repo / your self-host):",
        `claude mcp add cobblr \\`,
        `  --env COBBLR_API_TOKEN=${token} \\`,
        `  --env COBBLR_BASE_URL=${window.location.origin}/api/v1 \\`,
        `  --env COBBLR_ORG_SLUG=${slug} \\`,
        "  -- cobblr-mcp",
      ].join("\n")
    : "";
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3 space-y-2">
      <div className="text-sm font-medium text-content dark:text-mortar-100">Connect from Claude</div>
      {!token ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => mint.mutate()}
            disabled={mint.isPending}
            className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5"
          >
            {mint.isPending ? "Generating…" : "Generate a Browser-driving token"}
          </button>
          <span className="text-xs text-faint">
            or manage tokens in{" "}
            <Link to="/configuration/tokens" className="text-accent hover:underline">API tokens</Link>
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-faint">Point the Cobblr MCP server at this workspace:</span>
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(snippet); toast.success("Copied"); }}
              className="text-[10px] text-accent hover:underline"
            >
              Copy
            </button>
          </div>
          <pre className="text-[11px] leading-relaxed bg-subtle dark:bg-slate-950 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto whitespace-pre text-content dark:text-mortar-200">{snippet}</pre>
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Token shown once — it can <strong>only</strong> drive your own open tab (scope <code>drive:control</code>),
            and only at the level you picked above.
          </p>
        </>
      )}
      <p className="text-xs text-faint">Disconnect anytime from the green indicator on the driven window.</p>
    </div>
  );
}
