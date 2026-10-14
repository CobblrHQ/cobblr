// Generic "install an edge bridge" widget: name it, install it (a pairing
// code or Docker, <BridgeInstallMethod>), and watch for the box to dial in. A
// bridge is kernel infrastructure (the wire lives at /orgs/:slug/edge); what
// USES it (machine managers, local AI, …) is a
// separate, data-driven concern — nothing module-specific belongs here.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { BridgeInstallMethod } from "./BridgeInstallMethod";

const lbl = "block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

export function EdgeBridgeInstall({ slug, bridgeId }: { slug: string; bridgeId?: string }) {
  const [label, setLabel] = useState("Home bridge");
  const [installedId, setInstalledId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const bid = (bridgeId ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40);

  // Watch for the box to dial in, once there is a code or a token to install with.
  const status = useQuery({
    queryKey: ["edge-status", slug],
    queryFn: () => api.getEdgeStatus(slug),
    enabled: !!slug && started,
    refetchInterval: 3000,
  });
  const connected = (status.data?.agents ?? []).some(
    (a) => (a.bridge ?? "") === installedId && a.last_seen_ms < (status.data?.stale_after_ms ?? 60_000),
  );

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted dark:text-slate-400">
        A hosted Cobblr can't reach devices on your network directly. Run one tiny <strong>bridge</strong> on any
        always-on box at your site (Pi, NAS, mini-PC) - it dials out and holds a tunnel open, so there's no
        port-forwarding and no inbound firewall hole. Install it once; everything that needs your site attaches to it.
      </p>
      <label className="block">
        <span className={lbl}>1 · Name this bridge</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
        <span className="block mt-1 text-[11px] text-faint">
          What you'll see it called everywhere in Cobblr, like "Workshop bridge". You can rename it later.
        </span>
      </label>
      <BridgeInstallMethod slug={slug} label={label} bridgeId={bid} onStarted={(id) => { setInstalledId(id); setStarted(true); }} />
      {started && (
        <div>
          <span className={lbl}>3 · Cobblr is watching for it</span>
          <div className={"flex items-center gap-2 text-sm rounded border p-2 " + (connected ? "border-moss-500/40 bg-moss-50 dark:bg-moss-950/30" : "border-line dark:border-slate-700")}>
            <span className={"w-2 h-2 rounded-full " + (connected ? "bg-moss-500" : "bg-amber-500 animate-pulse")} />
            {connected ? (
              <span className="text-moss-700 dark:text-moss-300">Bridge online - dialed in ✓</span>
            ) : (
              <span className="text-muted dark:text-slate-400">Waiting for the bridge to dial in…</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
