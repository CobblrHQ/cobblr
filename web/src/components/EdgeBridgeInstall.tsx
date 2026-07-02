// Generic "install an edge bridge" widget — mint a least-privilege
// devices:edge token, show the copy-ready run command, and watch for the box
// to dial in. A bridge is kernel infrastructure (the wire lives at
// /orgs/:slug/edge); what USES it (machine managers, local AI, …) is a
// separate, data-driven concern — nothing module-specific belongs here.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useToast } from "@cobblr/platform-web";

const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

export function EdgeBridgeInstall({ slug, bridgeId }: { slug: string; bridgeId?: string }) {
  const toast = useToast();
  const [label, setLabel] = useState("Edge bridge");
  const [token, setToken] = useState<string | null>(null);
  const [cmdMode, setCmdMode] = useState<"run" | "compose">("compose");
  const bid = (bridgeId ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40);

  // The canonical kernel wire — works in every workspace, no module required.
  const relayUrl = `${window.location.origin}/api/v1/orgs/${slug}/edge`;

  // Watch for the box to dial in (only worth polling once a token exists).
  const status = useQuery({
    queryKey: ["edge-status", slug],
    queryFn: () => api.getEdgeStatus(slug),
    enabled: !!slug && !!token,
    refetchInterval: 3000,
  });
  const connected = (status.data?.agents ?? []).some(
    (a) => (a.bridge ?? "") === bid && a.last_seen_ms < (status.data?.stale_after_ms ?? 60_000),
  );

  const mint = useMutation({
    mutationFn: () => api.createApiToken({ name: `Edge bridge: ${label.trim() || "bridge"}`, scopes: ["devices:edge"] }),
    onSuccess: (r) => setToken(r.token),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't generate a token."),
  });

  const tok = token ?? "<generate the token first>";
  // Registry-free: a STOCK public node image bootstraps the bridge CODE from
  // this Cobblr itself (GET /edge/release/loader → sha-verified bundle) using
  // the same token it tunnels with — no private registry, no Watchtower. The
  // loader self-updates: new bundle → clean exit → docker restarts onto it.
  // The shell reads the token + URL from its ENVIRONMENT — the secret appears
  // once (env), never in argv/shell history. `|| true` keeps a cached loader
  // usable when the cloud blips during a restart.
  const shellCmd = 'wget -qO loader.mjs --header "Authorization: Bearer $BRIDGE_RELAY_TOKEN" "$BRIDGE_RELAY_URL/release/loader" || true; node loader.mjs';
  // docker run: single-quote for the HOST shell so $ survives to the container.
  const runCmd = `sh -c '${shellCmd}'`;
  // compose: list-form command (a colon inside a plain scalar breaks YAML) and
  // $$ so compose's own interpolation leaves the $ for the container shell.
  const composeCmd = `command: ["sh", "-c", "${shellCmd.replace(/\$/g, "$$$$").replace(/"/g, '\\"')}"]`;
  const cmd = [
    "docker run -d --name cobblr-edge-bridge --restart unless-stopped \\",
    "  -v cobblr-bridge-data:/data -w /data \\",
    "  -e BRIDGE_MODE=tunnel \\",
    `  -e BRIDGE_RELAY_URL=${relayUrl} \\`,
    `  -e BRIDGE_RELAY_TOKEN=${tok} \\`,
    ...(bid ? [`  -e BRIDGE_ID=${bid} \\`] : []),
    "  node:22-alpine \\",
    `  ${runCmd}`,
  ].join("\n");
  const compose = [
    "# docker-compose.yml — then: docker compose up -d",
    "# Self-updating: the bridge fetches its own code from your Cobblr (sha-verified)",
    "# and restarts onto new versions — stock node image, nothing else to pull.",
    "services:",
    "  cobblr-edge-bridge:",
    "    image: node:22-alpine",
    "    restart: unless-stopped",
    "    working_dir: /data",
    "    volumes:",
    "      - ./bridge-data:/data",
    "    environment:",
    "      BRIDGE_MODE: tunnel",
    `      BRIDGE_RELAY_URL: ${relayUrl}`,
    `      BRIDGE_RELAY_TOKEN: ${tok}`,
    ...(bid ? [`      BRIDGE_ID: ${bid}`] : []),
    `    ${composeCmd}`,
  ].join("\n");
  const snippet = cmdMode === "compose" ? compose : cmd;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted dark:text-slate-400">
        A hosted Cobblr can't reach devices on your network directly. Run one tiny <strong>bridge</strong> on any
        always-on box at your site (Pi, NAS, mini-PC) — it dials out and holds a tunnel open, so there's no
        port-forwarding and no inbound firewall hole. Install it once; everything that needs your site attaches to it.
      </p>
      <label className="block">
        <span className={lbl}>1 · Name this bridge</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className={lbl}>2 · Install the bridge</span>
          {token && (
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden text-[10px]">
                {(["run", "compose"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setCmdMode(mode)}
                    className={"px-1.5 py-0.5 " + (cmdMode === mode ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}
                  >
                    {mode === "run" ? "docker run" : "compose"}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(snippet); toast.success("Copied"); }} className="text-[10px] text-accent hover:underline">
                Copy
              </button>
            </div>
          )}
        </div>
        {!token ? (
          <button
            type="button"
            onClick={() => mint.mutate()}
            disabled={mint.isPending || !label.trim()}
            className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5"
          >
            {mint.isPending ? "Generating…" : "Generate token & command"}
          </button>
        ) : (
          <>
            <pre className="text-[11px] leading-relaxed bg-subtle dark:bg-slate-950 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto whitespace-pre text-content dark:text-mortar-200">{snippet}</pre>
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
              Run this on a box at your site. Token shown once — it can <strong>only</strong> run this bridge (scope <code>devices:edge</code>).
            </p>
            <p className="text-[11px] text-faint mt-0.5">
              Stock public image — the bridge fetches its code from this Cobblr (sha-verified) and keeps itself
              updated automatically. Nothing to pull from a registry, ever.
            </p>
          </>
        )}
      </div>
      {token && (
        <div>
          <span className={lbl}>3 · Cobblr is watching for it</span>
          <div className={"flex items-center gap-2 text-sm rounded border p-2 " + (connected ? "border-moss-500/40 bg-moss-50 dark:bg-moss-950/30" : "border-line dark:border-slate-700")}>
            <span className={"w-2 h-2 rounded-full " + (connected ? "bg-moss-500" : "bg-amber-500 animate-pulse")} />
            {connected ? (
              <span className="text-moss-700 dark:text-moss-300">Bridge online — dialed in ✓</span>
            ) : (
              <span className="text-muted dark:text-slate-400">Waiting for the bridge to dial in…</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
