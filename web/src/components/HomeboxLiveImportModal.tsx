// Homebox — one-click LIVE import. The simple path on top of the core-integrations
// sync connector: paste your Homebox URL + an API key, and it creates the sync
// connection, imports your locations then your items (WITH photos — the thing the
// CSV can't carry), and offers to keep it synced. "Import once" leaves the
// connection in place (find it under Live sync to re-run, enable syncing, or
// archive) — active ≠ enabled. All the source/section/preview machinery of the
// full connector UI is hidden here; this is the friendly front door.

import { useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, ArrowRight, Link2, Camera } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type SyncRunResult } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { BridgePicker } from "./BridgePicker";

type Phase = "form" | "running" | "done";
type Counts = { locations: number; items: number };

/** How many rows are now mirrored from this import — the source total, not just
 *  what CHANGED. A re-run on already-synced data touches nothing (created/updated
 *  all 0) but still brought the full set across, so "18 items" reads right on the
 *  first import AND a repeat, where created+updated would show a confusing "0". */
function imported(r: SyncRunResult | undefined): number {
  return r ? r.total : 0;
}

export function HomeboxLiveImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeSlug: slug } = useActiveOrg();
  const toast = useToast();
  const qc = useQueryClient();

  const [phase, setPhase] = useState<Phase>("form");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [onLan, setOnLan] = useState(false); // Homebox is on my LAN → route via an edge bridge
  const [bridge, setBridge] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connId, setConnId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>({ locations: 0, items: 0 });
  const [keeping, setKeeping] = useState(false);

  const canSubmit = url.trim() !== "" && token.trim() !== "" && (!onLan || !!bridge);

  function reset() {
    setPhase("form"); setStatus(""); setError(null); setConnId(null);
    setCounts({ locations: 0, items: 0 }); setKeeping(false);
  }
  function close() { reset(); setUrl(""); setToken(""); setOnLan(false); setBridge(null); onClose(); }

  async function run() {
    setPhase("running"); setError(null);
    let createdId: string | null = null;
    try {
      // Reuse a live Homebox connection to the same URL if one exists (so a
      // repeat import doesn't pile up duplicates); otherwise create one.
      setStatus("Connecting to Homebox…");
      const base = url.trim().replace(/\/+$/, "");
      const existing = (await api.listSyncConnections(slug)).items.find(
        (c) => c.connector_id === "homebox" && !c.archived_at && (c.config.base_url ?? "").replace(/\/+$/, "") === base,
      );
      let id: string;
      if (existing) {
        id = existing.id;
      } else {
        const conn = await api.createSyncConnection(slug, {
          connector_id: "homebox",
          label: "Homebox",
          base_url: base,
          credentials: { token: token.trim() },
          transport: onLan ? "edge" : "direct",
          bridge: onLan ? bridge : null,
        });
        id = conn.id;
        createdId = id;
      }
      setConnId(id);

      // Fail fast with a clear message if the URL/key is wrong, before importing.
      const test = await api.testSyncConnection(slug, id);
      if (!test.ok) throw new Error(test.error ?? "Couldn't reach Homebox with that URL + API key.");

      // Locations FIRST — items reference their location, and the reference
      // resolves through the locations id-map the import populates.
      setStatus("Importing your locations…");
      const loc = await api.runSyncImport(slug, id, "locations");
      if (!loc.ok) throw new Error(loc.error ?? "Importing locations failed.");

      setStatus("Importing your items & photos…");
      const items = await api.runSyncImport(slug, id, "items");
      if (!items.ok) throw new Error(items.error ?? "Importing items failed.");

      setCounts({ locations: imported(loc.result), items: imported(items.result) });
      void qc.invalidateQueries({ queryKey: ["sync-connections", slug] });
      setPhase("done");
    } catch (e) {
      // A brand-new connection that couldn't even connect is noise — drop it so a
      // bad URL doesn't leave an orphan in Live sync. A reused one stays.
      if (createdId) { try { await api.deleteSyncConnection(slug, createdId); } catch { /* best-effort */ } }
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setPhase("form");
    }
  }

  async function keepSynced() {
    if (!connId) return;
    setKeeping(true);
    try {
      await api.configureSync(slug, connId, "locations", { enabled: true });
      await api.configureSync(slug, connId, "items", { enabled: true });
      void qc.invalidateQueries({ queryKey: ["sync-connections", slug] });
      toast.success("Live sync is on — Homebox changes now mirror over automatically.");
      close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't turn on live sync");
      setKeeping(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import from Homebox (live)"
      subtitle="Connect your Homebox and bring everything across — including photos."
      size="lg"
    >
      <div className="space-y-4">
        {phase === "form" && (
          <>
            <p className="text-sm text-muted dark:text-slate-400">
              In Homebox, open <strong>Profile → API tokens</strong> and create one. Paste your Homebox address and
              that token below. Items land in <strong>Inventory</strong>, the location tree rebuilds your{" "}
              <strong>Locations</strong>, and each item's <strong>photo</strong> comes across too. You choose whether
              to import once or keep it synced.
            </p>

            <label className="block">
              <span className="block text-[11px] font-medium text-content dark:text-mortar-200 mb-1">Homebox address</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="input font-mono"
                placeholder="http://homebox.local:3100"
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-medium text-content dark:text-mortar-200 mb-1">API token</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="input font-mono"
                placeholder="Homebox → Profile → API tokens"
                autoComplete="off"
              />
            </label>

            <label className="flex items-start gap-2 text-sm text-muted dark:text-slate-400 cursor-pointer">
              <input type="checkbox" checked={onLan} onChange={(e) => setOnLan(e.target.checked)} className="mt-0.5" />
              <span>
                My Homebox is on my local network
                <span className="block text-[11px] text-faint">
                  Tick this if the address above isn't reachable from the internet — Cobblr will fetch it through an
                  edge bridge on your network.
                </span>
              </span>
            </label>
            {onLan && (
              <div className="pl-6">
                <BridgePicker slug={slug} value={bridge} onChange={setBridge} />
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-sm text-ember-600 dark:text-ember-400">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{error}</span>
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => void run()}
                disabled={!canSubmit}
                className="inline-flex items-center gap-2 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3.5 py-2 disabled:opacity-50"
              >
                <Link2 size={15} /> Connect &amp; import
              </button>
              <button type="button" onClick={close} className="text-sm text-muted hover:text-content">Cancel</button>
            </div>
          </>
        )}

        {phase === "running" && (
          <div className="flex items-center gap-3 py-8 justify-center text-content dark:text-mortar-100">
            <Loader2 size={18} className="animate-spin text-accent" />
            <span className="text-sm">{status}</span>
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-300/60 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 p-3.5 space-y-2">
              <div className="flex items-center gap-2 text-content dark:text-mortar-100 font-medium">
                <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400" /> Everything came across
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <Stat n={counts.items} label="items imported" />
                <Stat n={counts.locations} label="locations" />
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
                <Camera size={13} /> Item photos were pulled in too.
              </p>
            </div>

            <div className="rounded-xl border border-line dark:border-slate-700 p-3.5 space-y-3">
              <p className="text-sm text-content dark:text-mortar-100 font-medium">Keep it synced?</p>
              <p className="text-xs text-muted dark:text-slate-400">
                Turn on live sync and future Homebox changes mirror over automatically. Or import just this once — the
                connection stays under <strong>Live sync</strong>, where you can re-run it, enable syncing later, or
                archive it anytime.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <button
                  type="button"
                  onClick={() => void keepSynced()}
                  disabled={keeping}
                  className="inline-flex items-center gap-2 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3.5 py-2 disabled:opacity-50"
                >
                  {keeping ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                  {keeping ? "Turning on…" : "Keep it synced"}
                </button>
                <button type="button" onClick={close} className="text-sm text-muted hover:text-content">
                  Just this once
                </button>
                <a href="/inventory" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline ml-auto">
                  View Inventory <ArrowRight size={14} />
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span className="text-content dark:text-mortar-200">
      <strong className="font-semibold">{n}</strong> <span className="text-muted dark:text-slate-400">{label}</span>
    </span>
  );
}
