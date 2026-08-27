// One-click LIVE import from another app, driven by a descriptor. The simple
// path on top of a core-integrations sync connector: paste the app's URL + an
// API token, and it creates the sync connection, imports each section in the
// order the descriptor lists them (parents before the things that reference
// them), and offers to keep it synced. "Import once" leaves the connection in
// place (find it under Live sync to re-run, enable syncing, or archive):
// active ≠ enabled. All the source/section/preview machinery of the full
// connector UI is hidden here; this is the friendly front door.
//
// Homebox was the first source and this used to be its modal. The second
// source (Part-DB) needed the same flow with different strings and one extra
// step, so the flow moved here and each source became a descriptor.

import { useState, type ReactNode } from "react";
import { Loader2, CheckCircle2, AlertTriangle, ArrowRight, Link2, Camera, Info } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type ImportPlan, type SyncRunResult } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { BridgePicker } from "./BridgePicker";

export interface LiveImportSection {
  /** The manifest entity-type key. */
  key: string;
  /** "your locations", "your items & photos": what the running status says. */
  running: string;
  /** Stat label in the summary: "items imported", "locations". */
  stat: string;
  /** Preview this section before importing it and turn the plan into notes for
   *  the summary (a source-specific disclosure, e.g. how many parts are stocked
   *  in more than one place). Costs a second fetch of the section, so only
   *  declare it where the note matters. */
  previewNotes?: (plan: ImportPlan) => string[];
}

export interface LiveImportSource {
  /** The sync connector id (`connector_id`). */
  connectorId: string;
  /** "Homebox", "Part-DB". */
  name: string;
  addressLabel: string;
  addressPlaceholder: string;
  tokenPlaceholder: string;
  /** The paragraph above the form: where to get a token, what comes across. */
  intro: ReactNode;
  /** Import order. A section whose records reference another section's rows
   *  must come AFTER it, so the reference resolves through the id-map. */
  sections: LiveImportSection[];
  /** Show the "photos were pulled in too" line in the summary. */
  photos?: boolean;
  /** Where "View …" goes after the import. */
  viewHref: string;
  viewLabel: string;
  /** Turn a raw connection-test error into user copy. Return null to keep the
   *  generic "couldn't reach it with that URL + token" line. */
  testErrorHint?: (error: string) => string | null;
}

type Phase = "form" | "running" | "done";

/** How many rows are now mirrored from this import — the source total, not just
 *  what CHANGED. A re-run on already-synced data touches nothing (created/updated
 *  all 0) but still brought the full set across, so "18 items" reads right on the
 *  first import AND a repeat, where created+updated would show a confusing "0". */
function imported(r: SyncRunResult | undefined): number {
  return r ? r.total : 0;
}

export function LiveImportModal({ source, open, onClose }: { source: LiveImportSource; open: boolean; onClose: () => void }) {
  const { activeSlug: slug } = useActiveOrg();
  const toast = useToast();
  const qc = useQueryClient();

  const [phase, setPhase] = useState<Phase>("form");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [onLan, setOnLan] = useState(false); // the app is on my LAN → route via an edge bridge
  const [bridge, setBridge] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connId, setConnId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [keeping, setKeeping] = useState(false);

  const canSubmit = url.trim() !== "" && token.trim() !== "" && (!onLan || !!bridge);

  function reset() {
    setPhase("form"); setStatus(""); setError(null); setConnId(null);
    setCounts({}); setNotes([]); setKeeping(false);
  }
  function close() { reset(); setUrl(""); setToken(""); setOnLan(false); setBridge(null); onClose(); }

  async function run() {
    setPhase("running"); setError(null);
    let createdId: string | null = null;
    try {
      // Reuse a live connection to the same URL if one exists (so a repeat
      // import doesn't pile up duplicates); otherwise create one.
      setStatus(`Connecting to ${source.name}…`);
      const base = url.trim().replace(/\/+$/, "");
      const existing = (await api.listSyncConnections(slug)).items.find(
        (c) => c.connector_id === source.connectorId && !c.archived_at && (c.config.base_url ?? "").replace(/\/+$/, "") === base,
      );
      let id: string;
      if (existing) {
        id = existing.id;
      } else {
        const conn = await api.createSyncConnection(slug, {
          connector_id: source.connectorId,
          label: source.name,
          base_url: base,
          credentials: { token: token.trim() },
          transport: onLan ? "edge" : "direct",
          bridge: onLan ? bridge : null,
        });
        id = conn.id;
        createdId = id;
      }
      setConnId(id);

      // Fail fast with a clear message if the URL/token is wrong, before importing.
      const test = await api.testSyncConnection(slug, id);
      if (!test.ok) {
        const hint = test.error ? source.testErrorHint?.(test.error) ?? null : null;
        throw new Error(hint ?? test.error ?? `Couldn't reach ${source.name} with that URL + API token.`);
      }

      const nextCounts: Record<string, number> = {};
      const nextNotes: string[] = [];
      for (const section of source.sections) {
        if (section.previewNotes) {
          setStatus(`Checking ${section.running}…`);
          const p = await api.previewSyncImport(slug, id, section.key);
          if (p.ok && p.plan) nextNotes.push(...section.previewNotes(p.plan));
        }
        setStatus(`Importing ${section.running}…`);
        const r = await api.runSyncImport(slug, id, section.key);
        if (!r.ok) throw new Error(r.error ?? `Importing ${section.running} failed.`);
        nextCounts[section.key] = imported(r.result);
        // A tag the engine could not attach is counted, never dropped quietly:
        // the summary has to say it, or the numbers above read as complete.
        const tf = r.result?.tagsFailed ?? 0;
        if (tf > 0) nextNotes.push(`${tf} ${tf === 1 ? "tag" : "tags"} could not be attached to ${section.running}. The records came across; the tags did not.`);
      }

      setCounts(nextCounts);
      setNotes(nextNotes);
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
      for (const section of source.sections) {
        await api.configureSync(slug, connId, section.key, { enabled: true });
      }
      void qc.invalidateQueries({ queryKey: ["sync-connections", slug] });
      toast.success(`Live sync is on - ${source.name} changes now mirror over automatically.`);
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
      title={`Import from ${source.name} (live)`}
      subtitle={`Connect your ${source.name} and bring everything across.`}
      size="lg"
    >
      <div className="space-y-4">
        {phase === "form" && (
          <>
            <p className="text-sm text-muted dark:text-slate-400">{source.intro}</p>

            <label className="block">
              <span className="block text-[11px] font-medium text-content dark:text-mortar-200 mb-1">{source.addressLabel}</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="input font-mono"
                placeholder={source.addressPlaceholder}
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
                placeholder={source.tokenPlaceholder}
                autoComplete="off"
              />
            </label>

            <label className="flex items-start gap-2 text-sm text-muted dark:text-slate-400 cursor-pointer">
              <input type="checkbox" checked={onLan} onChange={(e) => setOnLan(e.target.checked)} className="mt-0.5" />
              <span>
                My {source.name} is on my local network
                <span className="block text-[11px] text-faint">
                  Tick this if the address above isn't reachable from the internet - Cobblr will fetch it through an
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
                {source.sections.map((s) => (
                  <Stat key={s.key} n={counts[s.key] ?? 0} label={s.stat} />
                ))}
              </div>
              {source.photos && (
                <p className="flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
                  <Camera size={13} /> Item photos were pulled in too.
                </p>
              )}
            </div>

            {notes.length > 0 && (
              <div className="rounded-xl border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20 p-3.5 space-y-1.5">
                {notes.map((n, i) => (
                  <p key={i} className="flex items-start gap-2 text-xs text-content dark:text-mortar-200">
                    <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" /><span>{n}</span>
                  </p>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-line dark:border-slate-700 p-3.5 space-y-3">
              <p className="text-sm text-content dark:text-mortar-100 font-medium">Keep it synced?</p>
              <p className="text-xs text-muted dark:text-slate-400">
                Turn on live sync and future {source.name} changes mirror over automatically. Or import just this once - the
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
                <a href={source.viewHref} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline ml-auto">
                  {source.viewLabel} <ArrowRight size={14} />
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
