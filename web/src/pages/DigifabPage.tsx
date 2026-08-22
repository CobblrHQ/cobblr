// /configuration/digifab — Digital Fabrication. Manage connections to the
// software that runs your machines (FDM Monster, OctoPrint, …): add one,
// test it, list its printers, link printers to machines, and run the job
// queue. Sending a file to be made is a deliberate action — the Send
// button is behind an explicit confirm. We send files, never drive hardware.

import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wifi, Printer, RefreshCw, Send, ListChecks, Boxes, X, ListPlus, ChevronRight, Share2, Ban, Layers, Sliders } from "lucide-react";
import { ApiError, api, type DigifabConnection, type DigifabJob, type DigifabFleet, type BambuMode, type DigifabLibraryItem, type DigifabHistory, type DigifabRun, type DigifabFailureConfig, type DigifabDetector, type DigifabDetectorCatalogEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { PrintUpdatesPanel } from "./PrintUpdatesPanel";
import { Modal, useToast, useConfirm, usePageTitle, useImageSrc } from "@cobblr/platform-web";
import { Combobox } from "../components/Combobox";
import { CreateConnectionModal, FleetView, PrintDetailModal, Lightbox, LIBRARY_DRAG_MIME, fetchAllMachines } from "../features/digifab/fleet";

export function DigifabPage({
  setupOnly = false,
  embedded = false,
}: { setupOnly?: boolean; embedded?: boolean } = {}) {
  usePageTitle("Digital Fabrication");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [driversOpen, setDriversOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editConn, setEditConn] = useState<DigifabConnection | null>(null);
  // IA (the author: "a bit much to have it all there"): the page distinguishes OPERATE
  // (floor + queue + library + history — daily) from SETUP (connections, pools,
  // print-update rules — set-once). Floor is the page; Setup is one click away.
  // setupOnly (settings route /configuration/digifab): the FLOOR is an
  // operate surface and doesn't belong in Configuration — settings shows the
  // set-once plumbing only; the floor lives at /digifab (the author, 2026-07-03).
  const [tab, setTab] = useState<"floor" | "setup">(() =>
    setupOnly ? "setup" : localStorage.getItem("cobblr.digifab.tab") === "setup" ? "setup" : "floor");
  const pickTab = (t: "floor" | "setup") => {
    localStorage.setItem("cobblr.digifab.tab", t);
    setTab(t);
    // A tab switch is a natural "what changed?" moment — refresh the connection
    // list so setup-side additions show on the floor immediately (and vice versa).
    void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
  };
  // Inline-expand a connection's printers as a children list (no modal) — fewer clicks, fewer overlays.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Is digifab actually enabled here? If not, the whole page is inert — every
  // action fails at submit with a toast — so gate it behind an enable prompt
  // instead of rendering a fully-interactive dead page (audit B2.6).
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
  });
  const digifabEnabled = modules.data?.items.find((m) => m.name === "digifab")?.enabled;
  const enableDigifab = useMutation({
    mutationFn: () => api.enableModule(activeSlug, "digifab"),
    onSuccess: () => {
      toast.success("Digital Fabrication enabled");
      void qc.invalidateQueries({ queryKey: ["org-modules", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const list = useQuery({
    queryKey: ["digifab-connections", activeSlug],
    queryFn: () => api.listDigifabConnections(activeSlug),
    enabled: !!activeSlug && digifabEnabled !== false,
  });

  const test = useMutation({
    mutationFn: (id: string) => api.testDigifabConnection(activeSlug, id),
    onSuccess: (r) => {
      toast[r.ok ? "success" : "error"](
        r.ok ? `Connected${r.capabilities?.routing ? " · routing supported" : ""}` : `Failed: ${r.detail ?? "unknown"}`,
      );
      void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteDigifabConnection(activeSlug, id),
    onSuccess: () => {
      toast.success("Connection removed");
      void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = list.data?.items ?? [];
  // Per-mode capability table (cloud/lan/hybrid) so each Bambu connection can show
  // what it can do — monitor vs control — instead of leaving it a mystery.
  const bambuCaps = useQuery({
    queryKey: ["bambu-capabilities", activeSlug],
    queryFn: () => api.getBambuCapabilities(activeSlug),
    enabled: !!activeSlug && items.some((c) => c.type === "bambu"),
    staleTime: 60 * 60 * 1000,
  });

  if (digifabEnabled === false) {
    return (
      <div className="space-y-4">
        <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
          <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Digital Fabrication</h1>
        </div>
        <div className="max-w-lg rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center">
          <Printer size={28} className="mx-auto text-faint mb-3" />
          <p className="text-sm text-content dark:text-mortar-100 font-medium mb-1">Digital Fabrication isn't enabled yet</p>
          <p className="text-sm text-muted dark:text-slate-400 mb-4">
            Connect to the software that runs your machines (FDM Monster, OctoPrint, Bambu, a LAN bridge…), send files to be
            made, and track jobs to completion.
          </p>
          <button
            onClick={() => enableDigifab.mutate()}
            disabled={enableDigifab.isPending}
            className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-4 py-2 text-sm transition disabled:opacity-50"
          >
            <Plus size={15} /> {enableDigifab.isPending ? "Enabling…" : "Enable Digital Fabrication"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={"flex flex-wrap items-center gap-2 sm:gap-3 " + (embedded ? "" : "border-b border-line dark:border-slate-700 pb-3")}>
        {!embedded && (
          <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Digital Fabrication</h1>
        )}
        <span className="text-sm text-muted dark:text-slate-400">{items.length} connection{items.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        {setupOnly ? (
          <Link to="/digifab" className="text-sm text-accent hover:underline">
            Open the shop floor →
          </Link>
        ) : (
        <div className="inline-flex rounded-lg border border-line dark:border-slate-600 overflow-hidden">
          {([["floor", "Floor"], ["setup", "Setup"]] as const).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => pickTab(t)}
              className={"px-3 py-1.5 text-sm transition " + (tab === t ? "bg-cobble-600 text-white" : "text-muted hover:text-accent")}
            >
              {label}
            </button>
          ))}
        </div>
        )}
      </div>

      {/* ── FLOOR — the operate surface: what runs, what's queued, what to print. ── */}
      {!setupOnly && tab === "floor" && (
        <>
          {items.length === 0 && !list.isLoading && (
            <div className="max-w-lg rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center">
              <Printer size={26} className="mx-auto text-faint mb-3" />
              <p className="text-sm text-content dark:text-mortar-100 font-medium mb-1">No machines connected yet</p>
              <p className="text-sm text-muted dark:text-slate-400 mb-4">
                Point Cobblr at the software that runs your machines - FDM Monster, OctoPrint, Bambu, a LAN bridge.
              </p>
              <button onClick={() => pickTab("setup")} className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-4 py-2 text-sm transition">
                <Plus size={15} /> Open Setup
              </button>
            </div>
          )}
          {(list.isLoading || items.length > 0) && <FleetView slug={activeSlug} />}
          {items.length > 0 && <ProductionRunsSection slug={activeSlug} />}
          {items.length > 0 && <PrintQueueSection connections={items} />}
          {items.length > 0 && <LibrarySection slug={activeSlug} />}
          {items.length > 0 && <PrintHistorySection slug={activeSlug} />}
        </>
      )}

      {/* ── SETUP — set-once plumbing: connections, pools, notification rules. ── */}
      {tab === "setup" && (
        <>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted dark:text-slate-400 flex-1 min-w-[16rem]">
          Connect to the software that runs your machines - FDM Monster, OctoPrint, and friends - then group them into pools
          and wire up print updates.
        </p>
        <button
          onClick={() => setBulkOpen(true)}
          className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition"
          title="Add several printers at once (paste a list of URLs)"
        >
          <ListPlus size={14} /> Add several
        </button>
        <button
          onClick={() => setImportOpen(true)}
          className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition"
          title="Migrate an FDM Monster farm into Cobblr"
        >
          <Boxes size={14} /> Import farm
        </button>
        <button
          onClick={() => setDriversOpen(true)}
          className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition"
        >
          <Boxes size={14} /> Drivers
        </button>
        {items.some((c) => c.type === "edge_adapter") && (
          <button
            onClick={() => setShareOpen(true)}
            className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition"
          >
            <Share2 size={14} /> Share machines
          </button>
        )}
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Add connection
        </button>
      </div>

      <h2 className="text-sm font-semibold text-content dark:text-mortar-100 pt-2">Connections</h2>
      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No connections yet. Add one to point Cobblr at your machine manager.
        </div>
      )}

      <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {items.map((c) => {
          const isOpen = expanded.has(c.id);
          return (
          <li key={c.id} className="px-3 py-2.5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleExpanded(c.id)}
                title={isOpen ? "Hide printers" : "Show printers"}
                className="text-faint hover:text-accent transition p-0.5 shrink-0"
              >
                <ChevronRight size={15} className={"transition-transform " + (isOpen ? "rotate-90" : "")} />
              </button>
              <Printer size={16} className="text-faint shrink-0" />
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggleExpanded(c.id)}>
                <div className="text-sm font-medium text-content dark:text-mortar-100 truncate flex items-center gap-2">
                  {c.label}
                  <span className="text-[10px] font-mono uppercase tracking-wider text-faint">{c.type === "bambu" ? "bambu" : c.type}</span>
                  {c.capabilities?.routing && (
                    <span className="text-[10px] font-mono text-moss-600 dark:text-moss-400">routing</span>
                  )}
                  {c.type === "bambu" && (() => {
                    const mode = (typeof c.config?.mode === "string" ? c.config.mode : "cloud") as BambuMode;
                    const caps = bambuCaps.data?.modes[mode];
                    if (!caps) return null;
                    // Cloud has only PARTIAL control (light/pause/stop) — full
                    // control comes over LAN (lan/hybrid). Say so honestly rather
                    // than a blanket "control".
                    const summary = mode === "cloud" ? "monitor + light/pause" : "full control";
                    const full = mode !== "cloud";
                    return (
                      <span title={caps.note} className={"text-[10px] font-mono px-1 rounded cursor-help " + (full ? "text-moss-600 dark:text-moss-400" : "text-amber-600 dark:text-amber-400")}>
                        {mode} · {summary}
                      </span>
                    );
                  })()}
                </div>
                <div className="text-[11px] font-mono text-faint truncate">{c.base_url}</div>
                {c.last_sync_status && (
                  <div className={"text-[11px] " + (c.last_sync_status === "ok" ? "text-moss-600 dark:text-moss-400" : "text-ember-500")}>
                    {c.last_sync_status === "ok" ? "✓ reachable" : c.last_sync_status}
                  </div>
                )}
              </div>
              <button
                onClick={() => test.mutate(c.id)}
                disabled={test.isPending}
                title="Test connection"
                className="text-faint hover:text-accent transition p-1.5 disabled:opacity-50"
              >
                {test.isPending && test.variables === c.id ? <RefreshCw size={15} className="animate-spin" /> : <Wifi size={15} />}
              </button>
              <button
                onClick={() => setEditConn(c)}
                title="Edit connection (rename / host / credentials / enable)"
                className="text-faint hover:text-accent transition p-1.5"
              >
                <Sliders size={15} />
              </button>
              <button
                onClick={async () => {
                  const ok = await confirm({
                    title: `Remove "${c.label}"?`,
                    message: "Deletes the connection + its stored credentials, and cancels/unlinks any jobs, pool members and links that depended on it. Print history isn't sent anywhere.",
                    confirmLabel: "Remove",
                    destructive: true,
                  });
                  if (ok) del.mutate(c.id);
                }}
                title="Remove"
                className="text-faint hover:text-ember-500 transition p-1.5"
              >
                <Trash2 size={15} />
              </button>
            </div>
            {isOpen && (
              <div className="mt-2 ml-7 border-l-2 border-line dark:border-slate-700 pl-3">
                <ConnectionPrinters connection={c} />
              </div>
            )}
          </li>
          );
        })}
      </ul>

      {items.length > 0 && <PoolsSection slug={activeSlug} />}
      {items.length > 0 && <PrintUpdatesPanel slug={activeSlug} />}
      {items.length > 0 && <FailureDetectionPanel slug={activeSlug} />}
        </>
      )}

      {editConn && (
        <ConnectionEditModal
          connection={editConn}
          onClose={() => setEditConn(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
            setEditConn(null);
          }}
        />
      )}
      {createOpen && (
        <CreateConnectionModal
          types={list.data?.types ?? ["fdm_monster", "mock"]}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}
      {driversOpen && <DriversModal onClose={() => setDriversOpen(false)} />}
      {shareOpen && <ShareMachinesModal slug={activeSlug} edgeConns={items.filter((c) => c.type === "edge_adapter")} onClose={() => setShareOpen(false)} />}
      {importOpen && (
        <FdmmImportModal
          slug={activeSlug}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["digifab-pools", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["digifab-fleet", activeSlug] });
          }}
        />
      )}
      {bulkOpen && (
        <BulkAddModal
          slug={activeSlug}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["digifab-pools", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["digifab-fleet", activeSlug] });
          }}
        />
      )}
    </div>
  );
}

// Install / list / remove machine-manager drivers. Built-ins ship in code;
// Share a checklist of your edge-bridge machines with another Cobblr workspace.
// Pick which machines, choose read (monitor) vs write (control), generate a
// one-time link. The friend's workspace never gets your machine's credentials —
// it's a scoped, revocable pointer through your bridge. Existing grants list with
// live status + a one-click revoke.
function ShareMachinesModal({ slug, edgeConns, onClose }: { slug: string; edgeConns: DigifabConnection[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<"" | "7" | "30">("");
  const [link, setLink] = useState<string | null>(null);
  const shares = useQuery({ queryKey: ["edge-shares", slug], queryFn: () => api.listEdgeShares(slug) });
  const create = useMutation({
    mutationFn: () => api.createEdgeShare(slug, { label: label.trim(), scope, instance_ids: [...picked], ...(expiry ? { expires_in_days: Number(expiry) } : {}) }),
    onSuccess: (r) => {
      setLink(`${window.location.origin}/join-machines/${r.owner_org}/${r.token}`);
      setLabel(""); setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["edge-shares", slug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't create the share"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeEdgeShare(slug, id),
    onSuccess: () => { toast.success("Access revoked"); void qc.invalidateQueries({ queryKey: ["edge-shares", slug] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't revoke"),
  });
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  const shares_ = shares.data?.items ?? [];
  return (
    <Modal open onClose={onClose} title="Share machines" size="md">
      <div className="space-y-3">
        <p className="text-[13px] text-muted dark:text-slate-400">
          Invite someone to machines on your bridge. You send a link; they choose which of their own
          workspace(s) to add the machines to. Your printer's credentials never leave your workspace,
          and one revoke cuts off every workspace that joined.
        </p>
        <label className="block">
          <span className={lbl}>Name this share</span>
          <input value={label} onChange={(e) => { setLabel(e.target.value); setLink(null); }} placeholder="e.g. your club" className={field} autoFocus />
        </label>
        <div>
          <span className={lbl}>Machines to share</span>
          <div className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800 max-h-44 overflow-y-auto">
            {edgeConns.map((c) => (
              <label key={c.id} className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-subtle dark:hover:bg-slate-800/50">
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => { toggle(c.id); setLink(null); }} className="accent-cobble-600" />
                <span className="text-sm text-content dark:text-mortar-100">{c.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <span className={lbl}>Permission</span>
          <div className="grid grid-cols-2 gap-2">
            {([
              { id: "read", title: "Read only", note: "Watch status, temps & progress. Can't send or stop prints." },
              { id: "write", title: "Read + write", note: "Full control: send, pause, cancel prints on your machines." },
            ] as const).map((o) => (
              <button key={o.id} type="button" onClick={() => { setScope(o.id); setLink(null); }}
                className={"text-left rounded border p-2 transition " + (scope === o.id ? "border-cobble-500 bg-cobble-50/40 dark:bg-cobble-900/20" : "border-line dark:border-slate-600 hover:border-accent")}>
                <div className="text-xs font-medium text-content dark:text-mortar-100">{o.title}</div>
                <div className="text-[10px] text-muted dark:text-slate-400 mt-0.5 leading-snug">{o.note}</div>
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className={lbl}>Link expires</span>
          <select value={expiry} onChange={(e) => { setExpiry(e.target.value as "" | "7" | "30"); setLink(null); }} className={field + " !w-auto"}>
            <option value="">Never</option>
            <option value="7">In 7 days</option>
            <option value="30">In 30 days</option>
          </select>
        </label>
        {link ? (
          <div className="rounded border border-moss-300 dark:border-moss-800 bg-moss-50/50 dark:bg-moss-900/20 p-2 space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-moss-700 dark:text-moss-400">Share link - copy it now, shown once</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] break-all text-content dark:text-mortar-200">{link}</code>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(link); toast.success("Copied"); }} className="text-[10px] text-accent hover:underline shrink-0">Copy</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => create.mutate()} disabled={create.isPending || !label.trim() || picked.size === 0}
            className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-sm px-3 py-1.5">
            {create.isPending ? "Generating…" : `Generate link${picked.size ? ` (${picked.size} machine${picked.size > 1 ? "s" : ""})` : ""}`}
          </button>
        )}
        {shares_.length > 0 && (
          <div className="pt-2 border-t border-line dark:border-slate-700">
            <span className={lbl}>Existing shares</span>
            <ul className="space-y-1">
              {shares_.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 min-w-0">
                    <span className="text-content dark:text-mortar-100">{s.label}</span>
                    <span className="text-faint"> · {s.scope === "write" ? "control" : "read"} · {s.machines.length} machine{s.machines.length > 1 ? "s" : ""}{s.grantees.length ? ` · in ${s.grantees.length} workspace${s.grantees.length > 1 ? "s" : ""}` : ""}</span>
                  </span>
                  <span className={"font-mono text-[10px] " + (s.status === "active" ? "text-moss-600 dark:text-moss-400" : s.status === "pending" ? "text-amber-600 dark:text-amber-400" : "text-faint")}>{s.status}</span>
                  {s.status !== "revoked" && s.status !== "expired" && (
                    <button type="button" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending} className="text-[10px] text-ember-500 hover:underline disabled:opacity-50">revoke</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

// a user installs a declarative-HTTP driver by pasting a manifest — no
// deploy. Installed drivers then appear in the Add-connection dropdown.
function DriversModal({ onClose }: { onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [manifest, setManifest] = useState("");

  const list = useQuery({
    queryKey: ["digifab-drivers", activeSlug],
    queryFn: () => api.listDigifabDrivers(activeSlug),
    enabled: !!activeSlug,
  });
  const catalog = useQuery({
    queryKey: ["digifab-driver-catalog", activeSlug],
    queryFn: () => api.getDigifabDriverCatalog(activeSlug),
    enabled: !!activeSlug,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["digifab-drivers", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
  };
  // Generic install — used by both the one-click catalog and the paste box.
  const installManifest = useMutation({
    mutationFn: (m: unknown) => api.installDigifabDriver(activeSlug, m),
    onSuccess: (d) => {
      toast.success(`Installed "${d.name}"`);
      setManifest("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const installPasted = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      toast.error("Manifest isn't valid JSON");
      return;
    }
    installManifest.mutate(parsed);
  };
  const remove = useMutation({
    mutationFn: (key: string) => api.deleteDigifabDriver(activeSlug, key),
    onSuccess: () => { toast.success("Driver removed"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const builtins = list.data?.builtins ?? [];
  const installed = list.data?.installed ?? [];
  const field = "w-full px-2 py-1.5 text-xs font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";

  return (
    <Modal open onClose={onClose} title="Drivers" size="lg">
      <p className="text-sm text-muted dark:text-slate-400 mb-3">
        A driver connects digifab to the software that runs a machine. Built-ins ship with Cobblr;
        install a common one in a click from the catalog below, or paste a custom manifest - no
        deploy. Installed drivers appear in the <span className="font-medium">Add connection</span> dropdown.
      </p>

      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Built-in</div>
      <ul className="flex flex-wrap gap-2 mb-4">
        {builtins.map((b) => (
          <li key={b.key} className="text-xs px-2 py-1 rounded border border-line dark:border-slate-700 text-content dark:text-mortar-200">
            {b.name} <span className="text-faint font-mono">{b.key}</span>
          </li>
        ))}
      </ul>

      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Installed</div>
      {installed.length === 0 ? (
        <div className="text-[13px] text-muted italic mb-4">None yet - paste a manifest below.</div>
      ) : (
        <ul className="divide-y divide-line dark:divide-slate-800 mb-4">
          {installed.map((d) => (
            <li key={d.id} className="py-2 flex items-center gap-2 text-sm">
              <Boxes size={14} className="text-faint" />
              <span className="flex-1 text-content dark:text-mortar-100">{d.name} <span className="text-[11px] font-mono text-faint">{d.key}</span></span>
              <span className="text-[10px] font-mono text-faint">{d.kind}</span>
              <button
                onClick={async () => {
                  if (await confirm({ title: `Remove "${d.name}"?`, message: "Connections using it will stop resolving.", confirmLabel: "Remove", destructive: true })) remove.mutate(d.key);
                }}
                className="text-faint hover:text-ember-500 transition p-1"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* One-click catalog — the common managers (Duet/OctoPrint/Klipper/…)
          install without pasting any JSON. */}
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Available to install</div>
      {(() => {
        const have = new Set([...builtins.map((b) => b.key), ...installed.map((d) => d.key)]);
        const shelf = (catalog.data?.drivers ?? []).filter((c) => !have.has(c.id));
        if (catalog.isLoading) return <div className="text-[13px] text-muted italic mb-4">Loading catalog…</div>;
        if (shelf.length === 0) return <div className="text-[13px] text-muted italic mb-4">All catalog drivers are installed.</div>;
        return (
          <ul className="space-y-1.5 mb-4">
            {shelf.map((c) => (
              <li key={c.id} className="flex items-start gap-3 p-2 rounded border border-line dark:border-slate-700">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-content dark:text-mortar-100">{c.name} <span className="text-[11px] font-mono text-faint">{c.id}</span></div>
                  <div className="text-[12px] text-muted dark:text-slate-400">{c.summary}</div>
                  <div className="text-[11px] text-faint mt-0.5">Needs: {c.credentialHint}</div>
                </div>
                <button
                  onClick={() => installManifest.mutate(c.manifest)}
                  disabled={installManifest.isPending}
                  className="shrink-0 px-2.5 py-1.5 text-xs rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
                >
                  Install
                </button>
              </li>
            ))}
          </ul>
        );
      })()}

      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Install a custom driver (paste a manifest)</div>
      <textarea
        value={manifest}
        onChange={(e) => setManifest(e.target.value)}
        rows={6}
        placeholder={'{\n  "id": "octoprint",\n  "name": "OctoPrint",\n  "auth": { "kind": "header", "header": "X-Api-Key", "from": "apiKey" },\n  "test": { "method": "GET", "path": "/api/version" },\n  ...\n}'}
        className={field}
      />
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Close</button>
        <button
          onClick={installPasted}
          disabled={installManifest.isPending || !manifest.trim()}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          {installManifest.isPending ? "Installing…" : "Install driver"}
        </button>
      </div>
    </Modal>
  );
}

// ── status pill + which jobs can be sent / polled ──────────────────────
const JOB_STATUS_STYLE: Record<string, string> = {
  queued: "text-muted bg-subtle dark:bg-slate-800",
  "awaiting-assignment": "text-amber-600 bg-amber-50 dark:bg-amber-950/40",
  sent: "text-accent bg-cobble-50 dark:bg-cobble-950/40",
  printing: "text-accent bg-cobble-50 dark:bg-cobble-950/40",
  completed: "text-moss-600 bg-moss-50 dark:bg-moss-950/40",
  failed: "text-ember-600 dark:text-ember-400 bg-ember-50 dark:bg-ember-950/40",
  cancelled: "text-faint bg-subtle dark:bg-slate-800",
};
// A pool job is auto-assigned by the worker (it has no connection to send to),
// so it's not manually sendable.
const TERMINAL_JOB = (s: string) => s === "completed" || s === "failed" || s === "cancelled";
const canSend = (j: DigifabJob) => j.status === "queued" && !j.remote_job_id && !j.target_pool && !j.external;
const canPoll = (j: DigifabJob) => !!j.remote_job_id && !TERMINAL_JOB(j.status) && !j.external;
// An external ("on printer") row is an observed print with no Cobblr job behind
// it — offering Cancel just 404s. Read-only.
const canCancel = (j: DigifabJob) => !TERMINAL_JOB(j.status) && !j.external;
// Safe to delete from the queue only when it's not physically on a printer.
const canDelete = (j: DigifabJob) => j.status !== "sent" && j.status !== "printing" && j.status !== "paused" && !j.external;
// F-14: a job that matched 0 or many printers can be re-pointed at a specific one.
const canAssign = (j: DigifabJob) => j.status === "awaiting-assignment" && !!j.connection_id;
// A terminal failed/cancelled job (not an observed external print) can be retried.
const canRetry = (j: DigifabJob) => (j.status === "failed" || j.status === "cancelled") && !j.external;
// A history row backed by a Cobblr job (plain uuid id) can be reprinted; Bambu
// cloud-task rows ("task:…") have no job to clone.

// F-14 — re-pick a printer for an awaiting-assignment job, inline in the queue
// row. Lazy-loads the connection's printers when opened; assigns via the
// already-uploaded file (no re-upload, no delete-and-recreate).
function ReassignControl({ job, slug, onDone }: { job: DigifabJob; slug: string; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const devices = useQuery({
    queryKey: ["digifab-printers", slug, job.connection_id],
    queryFn: () => api.listDigifabDevices(slug, job.connection_id!),
    enabled: open && !!job.connection_id,
  });
  const assign = useMutation({
    mutationFn: () => api.assignDigifabJob(slug, job.id, deviceId),
    onSuccess: (r) => {
      toast[r.status === "sent" ? "success" : "info"](
        r.status === "sent" ? "Assigned — sent to the printer" : "That printer didn't take it — still unassigned",
      );
      setOpen(false);
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Pick a printer for this job"
        className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-2 py-1 text-xs transition"
      >
        <Printer size={12} /> Pick printer
      </button>
    );
  }
  const opts = (devices.data?.items ?? []).map((d) => ({ value: d.id, label: d.name, hint: d.state ?? undefined }));
  return (
    <div className="flex items-center gap-1">
      <div className="w-44">
        <Combobox value={deviceId} onChange={setDeviceId} options={opts} placeholder={devices.isLoading ? "Loading…" : "Pick a printer"} />
      </div>
      <button
        onClick={() => assign.mutate()}
        disabled={!deviceId || assign.isPending}
        className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-1 text-xs disabled:opacity-50"
      >
        Assign
      </button>
      <button onClick={() => setOpen(false)} className="text-faint hover:text-content px-1.5 py-1 text-xs" title="Cancel">✕</button>
    </div>
  );
}

// Prints-per-day trend — a compact stacked bar (completed on the baseline,
// failed stacked above). Status colors used for their meaning (moss=good,
// ember=fail); identity is never color-alone — the legend labels both, the
// stack order is fixed, and the caption reads the hovered day. One axis (count);
// filament lives in the stat tiles, so no dual-scale.
function PrintTrendChart({ series }: { series: NonNullable<DigifabHistory["series"]> }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((d) => d.completed + d.failed));
  const total = series.reduce((s, d) => s + d.completed + d.failed, 0);
  const H = 64; // plot height in px
  const fmtDay = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const h = hover != null ? series[hover] : null;
  if (total === 0) return <div className="text-xs text-muted italic">No prints in this window.</div>;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint">Prints per day</div>
        <div className="text-[10px] text-faint tabular-nums">
          {h ? (
            <span className="text-content dark:text-mortar-100">
              {fmtDay(h.date)} · <span className="text-moss-600">{h.completed} ok</span>
              {h.failed ? <> · <span className="text-ember-600 dark:text-ember-400">{h.failed} failed</span></> : null}
              {h.filament_g ? ` · ${h.filament_g}g` : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-moss-500" /> Completed</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-ember-500" /> Failed</span>
            </span>
          )}
        </div>
      </div>
      <div className="flex items-end gap-[2px]" style={{ height: H }} onMouseLeave={() => setHover(null)}>
        {series.map((d, i) => {
          const n = d.completed + d.failed;
          const okH = Math.round((d.completed / max) * H);
          const failH = Math.round((d.failed / max) * H);
          return (
            <div
              key={d.date}
              className="flex-1 min-w-[2px] h-full flex flex-col justify-end cursor-default"
              onMouseEnter={() => setHover(i)}
              title={`${fmtDay(d.date)} — ${d.completed} completed${d.failed ? `, ${d.failed} failed` : ""}${d.filament_g ? `, ${d.filament_g}g` : ""}`}
            >
              {failH > 0 && <div className="rounded-t-[3px] bg-ember-500" style={{ height: failH, opacity: hover == null || hover === i ? 1 : 0.4 }} />}
              {okH > 0 && (
                <div
                  className={"bg-moss-500 " + (failH > 0 ? "mt-[2px]" : "rounded-t-[3px]")}
                  style={{ height: okH, opacity: hover == null || hover === i ? 1 : 0.4 }}
                />
              )}
              {n === 0 && <div className="h-[2px] rounded-full bg-line dark:bg-slate-700" />}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1 text-[9px] text-faint tabular-nums">
        <span>{fmtDay(series[0]!.date)}</span>
        <span>{fmtDay(series[series.length - 1]!.date)}</span>
      </div>
    </div>
  );
}

// AI print-failure detection config — enable the camera watch that folds a
// rolling failure score and auto-pauses a print that's turning into spaghetti.
function FailureDetectionPanel({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const cfg = useQuery({ queryKey: ["digifab-failure-config", slug], queryFn: () => api.getDigifabFailureConfig(slug), enabled: open });
  const save = useMutation({
    mutationFn: (patch: Partial<DigifabFailureConfig>) => api.setDigifabFailureConfig(slug, patch),
    onSuccess: (d) => { qc.setQueryData(["digifab-failure-config", slug], d); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });
  const c = cfg.data;
  const lbl = "text-[10px] font-mono uppercase tracking-widest text-faint";
  return (
    <div className="pt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-sm font-semibold text-content dark:text-mortar-100">
        <ChevronRight size={15} className={"transition-transform " + (open ? "rotate-90" : "")} /> AI failure detection
      </button>
      {open && (
        <div className="mt-2 space-y-3 text-xs">
          {cfg.isLoading || !c ? (
            <div className="text-muted">Loading…</div>
          ) : (
            <>
              <p className="text-faint leading-relaxed">
                Watches each printing machine's camera and folds a rolling <b>failure score</b>; when it crosses your threshold it can auto-pause the print and alert you.
                Uses the <b>local model on your bridge</b> when available (the frame never leaves your network, no AI cost) and falls back to your workspace's vision AI.
              </p>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={c.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
                <span className="text-content dark:text-mortar-100 font-medium">Watch prints for failures</span>
              </label>
              {c.enabled && (
                <div className="space-y-3 pl-6">
                  <div>
                    <div className={lbl + " mb-1"}>Sensitivity - trip at score {c.threshold.toFixed(2)}</div>
                    <input type="range" min={0.3} max={0.9} step={0.05} value={c.threshold} onChange={(e) => save.mutate({ threshold: Number(e.target.value) })} className="w-full max-w-xs accent-cobble-600" />
                    <div className="flex justify-between max-w-xs text-[9px] text-faint"><span>catches more (0.30)</span><span>fewer false alarms (0.90)</span></div>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={c.auto_pause} onChange={(e) => save.mutate({ auto_pause: e.target.checked })} />
                    <span>Auto-pause the print when it trips <span className="text-faint">(off = alert only)</span></span>
                  </label>
                  <div className="flex items-center gap-2">
                    <span className={lbl}>Detector</span>
                    <select value={c.backend} onChange={(e) => save.mutate({ backend: e.target.value as DigifabFailureConfig["backend"] })} className="input !py-0.5 !text-xs !w-auto">
                      <option value="auto">Auto - local model when available, else vision AI</option>
                      {/* "Local model only" is not offered until a bridge-side
                          model actually ships - edge-only mode would sit and
                          detect nothing. A workspace already set to it still
                          sees its setting, labeled honestly. */}
                      {c.backend === "edge" && (
                        <option value="edge">Local model only (no bridge model yet - detects nothing)</option>
                      )}
                      <option value="llm">Vision AI only</option>
                      <option value="detector">External detector (self-hosted)</option>
                    </select>
                  </div>
                  {c.backend === "detector" && (
                    <div className="pl-1">
                      <p className="text-faint mb-1.5 leading-relaxed">
                        Score prints with a detection service you run anywhere - <b>Obico ML API</b>, <b>PrintGuard</b>, or any HTTP model on your LAN. Cobblr talks to it over the network (or via your edge bridge from the cloud).
                      </p>
                      <ExternalDetectorConfig slug={slug} cfg={c} save={(patch) => save.mutate(patch)} />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className={lbl}>Check every</span>
                    <select value={c.sample_interval_sec} onChange={(e) => save.mutate({ sample_interval_sec: Number(e.target.value) })} className="input !py-0.5 !text-xs !w-auto">
                      <option value={15}>15s</option><option value={30}>30s</option><option value={60}>60s</option><option value={120}>2 min</option>
                    </select>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const detLbl = "text-[10px] font-mono uppercase tracking-widest text-faint";

// Backend='detector' config: pick a configured external detector + open the
// manager to add/edit/test them.
function ExternalDetectorConfig({ slug, cfg, save }: { slug: string; cfg: DigifabFailureConfig; save: (patch: Partial<DigifabFailureConfig>) => void }) {
  const [manage, setManage] = useState(false);
  const list = useQuery({ queryKey: ["digifab-detectors", slug], queryFn: () => api.listDigifabDetectors(slug) });
  const detectors = list.data?.detectors ?? [];
  const missing = !!cfg.detector_id && !detectors.some((d) => d.id === cfg.detector_id);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={detLbl}>Service</span>
        <select value={cfg.detector_id ?? ""} onChange={(e) => save({ detector_id: e.target.value || null })} className="input !py-0.5 !text-xs !w-auto">
          <option value=""> - pick a detector - </option>
          {detectors.map((d) => (
            <option key={d.id} value={d.id}>{d.label} · {d.key}{d.enabled ? "" : " (off)"}</option>
          ))}
        </select>
        <button type="button" onClick={() => setManage(true)} className="text-xs text-cobble-600 dark:text-cobble-400 hover:underline">Manage…</button>
      </div>
      {missing && <p className="text-[10px] text-ember-600 dark:text-ember-500">The selected detector was removed - pick another.</p>}
      {detectors.length === 0 && !list.isLoading && <p className="text-[10px] text-faint">No detectors yet - click Manage to add one.</p>}
      {manage && <DetectorsModal slug={slug} onClose={() => setManage(false)} />}
    </div>
  );
}

// Add / edit / test / remove the workspace's external detectors.
function DetectorsModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useQuery({ queryKey: ["digifab-detector-catalog", slug], queryFn: () => api.getDigifabDetectorCatalog(slug) });
  const list = useQuery({ queryKey: ["digifab-detectors", slug], queryFn: () => api.listDigifabDetectors(slug) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["digifab-detectors", slug] });
  const cat = catalog.data?.detectors ?? [];
  const detectors = list.data?.detectors ?? [];

  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const selectedCat = cat.find((c) => c.key === key);
  const create = useMutation({
    mutationFn: () => api.createDigifabDetector(slug, { key, label, base_url: baseUrl, api_key: apiKey || undefined }),
    onSuccess: () => { toast.success("Detector added"); setKey(""); setLabel(""); setBaseUrl(""); setApiKey(""); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add detector"),
  });

  const input = "input !py-1 !text-xs w-full";
  return (
    <Modal open onClose={onClose} title="External detectors" subtitle="Point Cobblr at a self-hosted detection service" size="lg">
      <div className="space-y-4 text-xs">
        {detectors.length > 0 && (
          <div className="space-y-2">
            {detectors.map((d) => <DetectorCard key={d.id} slug={slug} det={d} cat={cat} onChanged={invalidate} />)}
          </div>
        )}
        <div className="rounded-lg border border-line/70 dark:border-mortar-700 p-3 space-y-2">
          <div className={detLbl}>Add a detector</div>
          <select value={key} onChange={(e) => { setKey(e.target.value); const c = cat.find((x) => x.key === e.target.value); if (c) setLabel((l) => l || c.name); }} className={input}>
            <option value=""> - choose a service - </option>
            {cat.map((c) => <option key={c.key} value={c.key}>{c.name} · {c.shape}</option>)}
          </select>
          {selectedCat?.summary && <p className="text-[10px] text-faint">{selectedCat.summary}</p>}
          {key && (
            <>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label - e.g. Obico on the NAS" className={input} />
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL - http://nas.lan:3333 (or cobblr-edge://<instance> from the cloud)" className={input} />
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="API token (only if the service needs one)" className={input} />
              {selectedCat?.shape === "camera-watcher" && (
                <p className="text-[10px] text-faint">This service watches its own cameras - after adding, map each printer to its camera id on the detector's row below.</p>
              )}
              <p className="text-[10px] text-faint">Reached directly on your LAN; from the cloud use <code className="font-mono">cobblr-edge://…</code> via your bridge. Loopback (127.0.0.1) is blocked - use the host/service name or LAN IP.</p>
              <button type="button" disabled={!label || !baseUrl || create.isPending} onClick={() => create.mutate()} className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-3 py-1.5">Add detector</button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// One configured detector — enable/test/delete, plus an expandable edit form
// (label / URL / token, and a camera→id map for camera-watcher services).
function DetectorCard({ slug, det, cat, onChanged }: { slug: string; det: DigifabDetector; cat: DigifabDetectorCatalogEntry[]; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(det.label);
  const [baseUrl, setBaseUrl] = useState(det.base_url);
  const [apiKey, setApiKey] = useState("");
  const [rows, setRows] = useState<Array<{ ref: string; cam: string }>>(
    Object.entries((det.config?.camera_map ?? {}) as Record<string, string>).map(([ref, cam]) => ({ ref, cam })),
  );
  const shape = cat.find((c) => c.key === det.key)?.shape;
  const isWatcher = shape === "camera-watcher";
  // Import lists for the link picker (only while editing a camera-watcher).
  const fleet = useQuery({ queryKey: ["digifab-fleet", slug], queryFn: () => api.getDigifabFleet(slug), enabled: editing && isWatcher });
  const camsQuery = useQuery({ queryKey: ["digifab-detector-cameras", slug, det.id], queryFn: () => api.listDigifabDetectorCameras(slug, det.id), enabled: editing && isWatcher, retry: false });
  const deviceOpts = (fleet.data?.connections ?? []).flatMap((c) => c.devices.map((d) => ({ value: `${c.connection_id}:${d.id}`, label: `${c.label} — ${d.name}` })));
  const cams = camsQuery.data?.cameras ?? [];
  // Owner flag (B1 follow-up): when the detector owns its printers, Cobblr shows
  // their live state and shouldn't also poll them.
  const [owns, setOwns] = useState(!!(det.config as { owns?: boolean })?.owns);
  const printers = useQuery({ queryKey: ["digifab-detector-printers", slug, det.id], queryFn: () => api.listDigifabDetectorPrinters(slug, det.id), enabled: editing && isWatcher && owns, retry: false });

  const save = useMutation({
    mutationFn: () => {
      const camera_map: Record<string, string> = {};
      for (const r of rows) if (r.ref.trim() && r.cam.trim()) camera_map[r.ref.trim()] = r.cam.trim();
      return api.updateDigifabDetector(slug, det.id, {
        label, base_url: baseUrl,
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(isWatcher ? { config: { camera_map, owns } } : {}),
      });
    },
    onSuccess: () => { toast.success("Saved"); setApiKey(""); setEditing(false); onChanged(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateDigifabDetector(slug, det.id, { enabled }),
    onSuccess: onChanged,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't update"),
  });
  const test = useMutation({
    mutationFn: () => api.testDigifabDetector(slug, det.id),
    onSuccess: (r) => r.ok ? toast.success("Reachable ✓" + (r.version ? ` · v${r.version}` : "")) : toast.error(r.detail ?? "Unreachable — no response"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Test failed"),
  });
  const del = useMutation({
    mutationFn: () => api.deleteDigifabDetector(slug, det.id),
    onSuccess: () => { toast.success("Removed"); onChanged(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove"),
  });

  const input = "input !py-1 !text-xs w-full";
  return (
    <div className="rounded-lg border border-line/70 dark:border-mortar-700 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-content dark:text-mortar-100">{det.label}</span>
        <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-mortar-100 dark:bg-mortar-800 text-faint">{det.key}</span>
        {!det.enabled && <span className="text-[9px] text-faint">(disabled)</span>}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => test.mutate()} disabled={test.isPending} className="text-cobble-600 dark:text-cobble-400 hover:underline">Test</button>
          <button type="button" onClick={() => setEditing((v) => !v)} className="text-faint hover:underline">{editing ? "Close" : "Edit"}</button>
          <button type="button" onClick={async () => { if (await confirm({ title: `Remove "${det.label}"?`, message: "The failure watch will stop using it.", confirmLabel: "Remove", destructive: true })) del.mutate(); }} className="text-ember-600 dark:text-ember-500 hover:underline">Remove</button>
        </div>
      </div>
      <div className="mt-1 text-[10px] text-faint break-all">{det.base_url}{det.has_credentials ? " · token set" : ""}</div>
      <label className="mt-1.5 flex items-center gap-1.5 text-[10px]">
        <input type="checkbox" checked={det.enabled} onChange={(e) => toggle.mutate(e.target.checked)} /> Enabled
      </label>
      {editing && (
        <div className="mt-2 space-y-2 border-t border-line/60 dark:border-mortar-700 pt-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className={input} />
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL" className={input} />
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder={det.has_credentials ? "API token (leave blank to keep)" : "API token (optional)"} className={input} />
          {isWatcher && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className={detLbl}>Linked cameras - a machine → its camera in the detector</div>
                <button type="button" onClick={() => camsQuery.refetch()} className="text-[10px] text-cobble-600 dark:text-cobble-400 hover:underline" title="Refresh the camera list">
                  {camsQuery.isFetching ? "…" : "↻"}
                </button>
              </div>
              {camsQuery.isError && (
                <div className="text-[10px] text-ember-600 dark:text-ember-500">Couldn't list cameras - check the URL/token (Test), or type the id.</div>
              )}
              {rows.map((r, i) => {
                const refMissing = !!r.ref && !deviceOpts.some((o) => o.value === r.ref);
                const camMissing = !!r.cam && !cams.some((c) => c.id === r.cam);
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    <select value={r.ref} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))} className="input !py-1 !text-xs flex-1">
                      <option value=""> - pick a machine - </option>
                      {refMissing && <option value={r.ref}>{r.ref}</option>}
                      {deviceOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <span className="text-faint">→</span>
                    {cams.length > 0 || r.cam ? (
                      <select value={r.cam} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, cam: e.target.value } : x)))} className="input !py-1 !text-xs flex-1">
                        <option value=""> - pick a camera - </option>
                        {camMissing && <option value={r.cam}>{r.cam}</option>}
                        {cams.map((c) => <option key={c.id} value={c.id}>{(c.name ? `${c.name} (${c.id})` : c.id) + (c.online === false ? " · offline" : "")}</option>)}
                      </select>
                    ) : (
                      <input value={r.cam} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, cam: e.target.value } : x)))} placeholder="camera id" className="input !py-1 !text-xs flex-1" />
                    )}
                    <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-ember-600 dark:text-ember-500"><X size={13} /></button>
                  </div>
                );
              })}
              <button type="button" onClick={() => setRows((rs) => [...rs, { ref: "", cam: "" }])} className="text-[10px] text-cobble-600 dark:text-cobble-400 hover:underline">+ link a camera</button>
            </div>
          )}
          {isWatcher && (
            <label className="flex items-start gap-1.5 text-[10px]">
              <input type="checkbox" checked={owns} onChange={(e) => setOwns(e.target.checked)} className="mt-0.5" />
              <span>The detector <b>owns</b> these printers - show their live print state here, and don't also poll them in Cobblr <span className="text-faint">(avoids double-load on the printer)</span>.</span>
            </label>
          )}
          {isWatcher && owns && (printers.data?.printers.length ?? 0) > 0 && (
            <div className="rounded border border-line/60 dark:border-mortar-700 p-2 space-y-0.5">
              <div className={detLbl}>PrintGuard print state</div>
              {printers.data!.printers.map((p) => (
                <div key={p.id} className="text-[10px] flex items-center gap-1.5">
                  <span className="text-content dark:text-mortar-200">{p.name ?? p.id}</span>
                  <span className="text-faint">{p.status ?? "—"}{p.progress != null && p.status === "printing" ? ` · ${Math.round(p.progress)}%` : ""}</span>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-3 py-1.5">Save</button>
          {isWatcher && <PrinterRegister slug={slug} detId={det.id} fleet={fleet.data} onDone={() => { camsQuery.refetch(); printers.refetch(); }} />}
        </div>
      )}
    </div>
  );
}

// B2 — "Add a printer to the detector": mirror an existing Cobblr machine
// (credentials stay server-side) or fill the provider's config form by hand.
// Registering auto-registers the printer's webcam and binds a monitor so it watches.
function PrinterRegister({ slug, detId, fleet, onDone }: { slug: string; detId: string; fleet: DigifabFleet | undefined; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const providers = useQuery({ queryKey: ["digifab-detector-providers", slug, detId], queryFn: () => api.getDigifabDetectorProviders(slug, detId), enabled: open, retry: false });
  const provs = providers.data?.providers ?? [];
  // Mirrorable connections come from the detector's manifest mappings — any
  // digifab type the detector declares a mapping for (nothing hardcoded here).
  const mappings = providers.data?.mappings ?? [];
  const mappable = (fleet?.connections ?? []).filter((c) => mappings.some((m) => m.from === c.type));

  const [connId, setConnId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [disableSource, setDisableSource] = useState(true);
  const selectedConn = mappable.find((c) => c.connection_id === connId);
  const needsDevice = !!mappings.find((m) => m.from === selectedConn?.type)?.perDevice;
  const mirror = useMutation({
    mutationFn: () => api.mirrorDigifabDetectorPrinter(slug, detId, { connection_id: connId, device_id: needsDevice ? deviceId : undefined, watch: true, disable_source: needsDevice ? false : disableSource }),
    onSuccess: (r) => { toast.success((r.monitor ? "Added + watching" : "Printer added") + (r.source_disabled ? " · Cobblr poll stopped ✓" : " ✓")); setConnId(""); setDeviceId(""); onDone(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add"),
  });

  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const props = provs.find((p) => p.id === provider)?.schema?.properties ?? {};
  const register = useMutation({
    mutationFn: () => api.registerDigifabDetectorPrinter(slug, detId, { name, provider, config, watch: true }),
    onSuccess: (r) => { toast.success(r.monitor ? "Registered + watching ✓" : "Registered ✓"); setName(""); setConfig({}); setProvider(""); onDone(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't register"),
  });

  const input = "input !py-1 !text-xs w-full";
  return (
    <div className="border-t border-line/60 dark:border-mortar-700 pt-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[10px] text-cobble-600 dark:text-cobble-400 hover:underline">
        {open ? "− Add a printer to the detector" : "+ Add a printer to the detector"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {mappable.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className={detLbl}>From a machine</span>
                <select value={connId} onChange={(e) => { setConnId(e.target.value); setDeviceId(""); }} className="input !py-1 !text-xs flex-1">
                  <option value=""> - a Cobblr machine to mirror - </option>
                  {mappable.map((c) => <option key={c.connection_id} value={c.connection_id}>{c.label} ({c.type})</option>)}
                </select>
                {!needsDevice && <button type="button" disabled={!connId || mirror.isPending} onClick={() => mirror.mutate()} className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2 py-1">Add</button>}
              </div>
              {connId && !needsDevice && (
                <label className="flex items-center gap-1.5 text-[10px] text-faint pl-1">
                  <input type="checkbox" checked={disableSource} onChange={(e) => setDisableSource(e.target.checked)} />
                  Stop polling it in Cobblr after adding (the detector owns it)
                </label>
              )}
              {needsDevice && (
                <div className="flex items-center gap-1.5">
                  <span className={detLbl}>Printer</span>
                  <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="input !py-1 !text-xs flex-1">
                    <option value=""> - which printer (needs stored LAN creds) - </option>
                    {(selectedConn?.devices ?? []).map((dv) => <option key={dv.id} value={dv.id}>{dv.name} ({dv.id})</option>)}
                  </select>
                  <button type="button" disabled={!deviceId || mirror.isPending} onClick={() => mirror.mutate()} className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2 py-1">Add</button>
                </div>
              )}
            </div>
          )}
          <div className="text-[10px] text-faint">or register one by hand:</div>
          {providers.isError && <div className="text-[10px] text-ember-600 dark:text-ember-500">Couldn't load providers - needs a manage-scope token on this detector.</div>}
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setConfig({}); }} className={input}>
            <option value=""> - provider - </option>
            {provs.map((p) => <option key={p.id} value={p.id}>{p.label ?? p.id}</option>)}
          </select>
          {provider && (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name in the detector" className={input} />
              {Object.entries(props).map(([key, p]) => (
                <input key={key} value={config[key] ?? ""} type={p.secret ? "password" : "text"} placeholder={p.title ?? p.placeholder ?? key}
                  onChange={(e) => setConfig((c) => ({ ...c, [key]: e.target.value }))} className={input} />
              ))}
              <button type="button" disabled={!name || register.isPending} onClick={() => register.mutate()} className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-3 py-1.5">Register + watch</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Print history + at-a-glance stats — a read model over the jobs Cobblr sent +
// tracked to completion. Collapsed by default; loads on open.
function PrintHistorySection({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(30);
  const [printOpen, setPrintOpen] = useState<DigifabHistory["recent"][number] | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const hist = useQuery({ queryKey: ["digifab-history", slug, days], queryFn: () => api.getDigifabHistory(slug, days), enabled: open });
  // "Print again" from a history row — same clone-and-send as the cockpit.
  const reprint = useMutation({
    mutationFn: (jobId: string) => api.reprintDigifabJob(slug, jobId),
    onSuccess: (r) => {
      toast[r.sent === false && !r.pooled ? "info" : "success"](
        r.pooled ? "Queued to the pool — auto-assigns to a free printer" : r.sent ? "Sent — printing again" : `Queued — send it from the print queue${r.reason ? ` (${r.reason})` : ""}`,
      );
      void qc.invalidateQueries({ queryKey: ["digifab-jobs", slug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't reprint"),
  });
  const askReprint = async (r: DigifabHistory["recent"][number]) => {
    const ok = await confirm({
      title: `Print "${r.file_ref}" again?`,
      message: "Clones the original job (same file, routing, material and build) and sends it to the printer. On a live farm this physically starts the print.",
      confirmLabel: "Print again",
      destructive: true,
    });
    if (ok) reprint.mutate(r.id);
  };
  const s = hist.data?.summary;
  const rate = s && s.total ? Math.round((s.completed / s.total) * 100) : null;
  const stat = (label: string, value: string) => (
    <div className="rounded border border-line dark:border-slate-700 px-2.5 py-1.5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint">{label}</div>
      <div className="text-lg font-semibold text-content dark:text-mortar-100">{value}</div>
    </div>
  );
  return (
    <div className="pt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-sm font-semibold text-content dark:text-mortar-100">
        <ChevronRight size={15} className={"transition-transform " + (open ? "rotate-90" : "")} /> Print history
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-faint">Last</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input !py-0.5 !text-xs !w-auto">
              <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
            </select>
          </div>
          {hist.isLoading ? <div className="text-xs text-muted">Loading…</div> : s && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {stat("Prints", String(s.total))}
                {stat("Success", rate == null ? "—" : `${rate}%`)}
                {stat("Filament", s.filament_g ? `${Math.round(s.filament_g)} g` : "—")}
                {stat("Print time", s.hours ? `${s.hours} h` : "—")}
              </div>
              {hist.data?.series && hist.data.series.length > 0 && <PrintTrendChart series={hist.data.series} />}
              {(hist.data?.by_device.length ?? 0) > 0 && (
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">By printer</div>
                  <ul className="text-xs space-y-0.5">
                    {[...hist.data!.by_device]
                      .sort((a, b) => b.total - a.total)
                      .map((d, i) => {
                        const dr = d.total ? Math.round((d.completed / d.total) * 100) : null;
                        return (
                          <li key={i} className="flex gap-2">
                            <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-100">{d.name}</span>
                            {dr != null && (
                              <span className={"shrink-0 tabular-nums " + (dr >= 90 ? "text-moss-600" : dr >= 70 ? "text-amber-600" : "text-ember-600 dark:text-ember-400")}>{dr}%</span>
                            )}
                            <span className="text-faint shrink-0">{d.completed}/{d.total}{d.failed ? ` · ${d.failed} failed` : ""}{d.filament_g ? ` · ${Math.round(d.filament_g)}g` : ""}</span>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Recent prints</div>
                {hist.data!.recent.length === 0 ? (
                  <div className="text-xs text-muted italic">No finished prints in this window.</div>
                ) : (
                  <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
                    {hist.data!.recent.map((r) => {
                      const durMin = r.duration_s ? Math.round(r.duration_s / 60) : 0;
                      const dur = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : durMin > 0 ? `${durMin}m` : null;
                      return (
                        <li key={r.id}>
                        <button type="button" onClick={() => setPrintOpen(r)} className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-subtle dark:hover:bg-slate-800">
                          {r.cover ? (
                            <img src={r.cover} alt="" loading="lazy" className="w-9 h-9 rounded object-cover bg-subtle shrink-0" />
                          ) : (
                            <span className={"w-9 h-9 rounded shrink-0 flex items-center justify-center " + (r.status === "completed" ? "bg-moss-500/15" : r.status === "failed" ? "bg-ember-500/15" : "bg-subtle")}>
                              <span className={"w-1.5 h-1.5 rounded-full " + (r.status === "completed" ? "bg-moss-500" : r.status === "failed" ? "bg-ember-500" : "bg-faint")} />
                            </span>
                          )}
                          <span className="flex-1 min-w-0">
                            <span className="block truncate text-content dark:text-mortar-100" title={r.file_ref}>{r.file_ref}</span>
                            {r.sub_label && r.sub_label !== r.file_ref && <span className="block truncate text-faint text-[10px]" title={r.sub_label}>{r.sub_label}</span>}
                          </span>
                          <span className="text-faint truncate max-w-[22%] shrink-0" title={r.device}>{r.device}</span>
                          {dur && <span className="text-faint shrink-0">{dur}</span>}
                          {r.filament_g != null && <span className="text-faint shrink-0">{Math.round(r.filament_g)}g</span>}
                          <span className="text-faint shrink-0">{new Date(r.at).toLocaleDateString()}</span>
                        </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
          {printOpen && <PrintDetailModal item={printOpen} onClose={() => setPrintOpen(null)} onZoom={setLightbox} onReprint={(r) => { setPrintOpen(null); void askReprint(r); }} />}
          {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
        </div>
      )}
    </div>
  );
}

function PrintQueueSection({ connections }: { connections: DigifabConnection[] }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [newOpen, setNewOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set()); // F-10: bulk selection
  const [detailId, setDetailId] = useState<string | null>(null); // job detail modal
  // ⑥ SimplyPrint-style "queue timeline": one row per printer — what's running
  // (with its finish clock) and what's lined up behind it.
  const [view, setView] = useState<"list" | "timeline">("list");
  // Status filter — the queue accretes terminal history; default to the active
  // slice so queued/printing jobs aren't buried (audit B2.7). "all" shows everything.
  const [filter, setFilter] = useState<"active" | "failed" | "completed" | "all">("active");
  const statusParam = filter === "failed" ? "failed" : filter === "completed" ? "completed" : undefined;

  // F-5: paginated (no silent 200-cap) + F-8: live — refetch every 5s while any
  // job is non-terminal, so pool auto-assignment and print progress update on
  // their own (the server worker advances them; the UI just needs to re-read).
  const jobs = useInfiniteQuery({
    queryKey: ["digifab-jobs", activeSlug, statusParam ?? "all"],
    queryFn: ({ pageParam }) => api.listDigifabJobs(activeSlug, { limit: 50, cursor: pageParam, status: statusParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!activeSlug,
    refetchInterval: (q) => {
      const its = q.state.data?.pages.flatMap((p) => p.items) ?? [];
      return its.some((j) => !TERMINAL_JOB(j.status)) ? 5000 : false;
    },
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["digifab-jobs", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["digifab-fleet", activeSlug] }); // F-8: reflect the device's active job too
  };
  const connById = new Map(connections.map((c) => [c.id, c]));

  const send = useMutation({
    mutationFn: (id: string) => api.sendDigifabJob(activeSlug, id),
    onSuccess: (r) => {
      const kb = r.uploaded_bytes ? ` (${(r.uploaded_bytes / 1024).toFixed(1)} KB uploaded)` : "";
      toast[r.status === "awaiting-assignment" ? "info" : "success"](
        r.status === "awaiting-assignment"
          ? "Uploaded — needs a printer assignment (target matched 0 or many)"
          : `Sent to the farm — tracking to completion${kb}`,
      );
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const poll = useMutation({
    mutationFn: (id: string) => api.pollDigifabJob(activeSlug, id),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelDigifabJob(activeSlug, id),
    onSuccess: (r) => {
      toast[r.remote_cancelled ? "success" : "info"](
        r.remote_cancelled ? "Cancelled — told the printer to stop" : "Marked cancelled (the printer may still be running — stop it at the machine)",
      );
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDigifabJob(activeSlug, id),
    onSuccess: () => { toast.success("Removed from the queue"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.retryDigifabJob(activeSlug, id),
    onSuccess: (r) => {
      toast[r.sent === false && !r.pooled ? "info" : "success"](
        r.pooled ? "Re-queued to the pool" : r.sent ? "Re-sent to the printer" : `Re-queued — send it when ready${r.reason ? ` (${r.reason})` : ""}`,
      );
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const askSend = async (j: DigifabJob) => {
    const conn = j.connection_id ? connById.get(j.connection_id) : undefined;
    const isMock = conn?.type === "mock";
    const ok = await confirm({
      title: "Start this print?",
      message: isMock
        ? `Mock connection "${conn?.label}" — no hardware is touched. Uploads + places the job through the mock driver.`
        : `This uploads the file and queues it on "${conn?.label ?? "the farm"}" — on a live farm it physically starts the print. It can't be stopped from here.`,
      confirmLabel: isMock ? "Send (mock)" : "Start print",
      destructive: !isMock,
    });
    if (ok) send.mutate(j.id);
  };
  const askCancel = async (j: DigifabJob) => {
    const ok = await confirm({
      title: "Cancel this print?",
      message:
        j.status === "queued" || j.status === "awaiting-assignment"
          ? "Removes it from the queue before it starts."
          : "Marks it cancelled and stops Cobblr tracking it. On a live farm the printer may keep running — stop it at the machine.",
      confirmLabel: "Cancel print",
      destructive: true,
    });
    if (ok) cancel.mutate(j.id);
  };

  const rawItems = jobs.data?.pages.flatMap((p) => p.items) ?? [];
  // "active" = non-terminal (queued/awaiting/sent/printing/paused + external
  // observed prints); failed/completed are fetched server-side by status.
  const items = filter === "active" ? rawItems.filter((j) => !TERMINAL_JOB(j.status)) : rawItems;
  const totalForFilter = jobs.data?.pages[0]?.total;

  // F-10 — bulk actions over the checked rows. Each batch is one confirm, then
  // fans out the existing per-job mutation (eligibility filtered per action, so
  // a mixed selection only sends the sendable, cancels the cancellable, etc.).
  const selItems = items.filter((j) => sel.has(j.id));
  const toggleSel = (id: string) =>
    setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSel = () => setSel(new Set());
  const bulkSendable = selItems.filter(canSend);
  const bulkCancelable = selItems.filter(canCancel);
  const bulkDeletable = selItems.filter(canDelete);
  const allChecked = items.length > 0 && items.every((j) => sel.has(j.id));
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(items.map((j) => j.id)));
  const bulkSend = async () => {
    if (!bulkSendable.length) return;
    const ok = await confirm({
      title: `Start ${bulkSendable.length} print${bulkSendable.length === 1 ? "" : "s"}?`,
      message: "Uploads + queues each on its farm. On a live farm this physically starts the prints; they can't be stopped from here.",
      confirmLabel: `Start ${bulkSendable.length}`,
      destructive: true,
    });
    if (ok) { bulkSendable.forEach((j) => send.mutate(j.id)); clearSel(); }
  };
  const bulkCancel = async () => {
    if (!bulkCancelable.length) return;
    const ok = await confirm({
      title: `Cancel ${bulkCancelable.length} print${bulkCancelable.length === 1 ? "" : "s"}?`,
      message: "Removes the queued ones and tells running ones to stop where supported. On a live farm a printer may keep going. Stop it at the machine.",
      confirmLabel: `Cancel ${bulkCancelable.length}`,
      destructive: true,
    });
    if (ok) { bulkCancelable.forEach((j) => cancel.mutate(j.id)); clearSel(); }
  };
  const bulkRemove = async () => {
    if (!bulkDeletable.length) return;
    const ok = await confirm({
      title: `Remove ${bulkDeletable.length} job${bulkDeletable.length === 1 ? "" : "s"}?`,
      message: "Deletes them from the queue.",
      confirmLabel: `Remove ${bulkDeletable.length}`,
      destructive: true,
    });
    if (ok) { bulkDeletable.forEach((j) => del.mutate(j.id)); clearSel(); }
  };

  return (
    <section className="space-y-2 pt-2">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 border-b border-line dark:border-slate-700 pb-2">
        {items.length > 0 && (
          <input type="checkbox" checked={allChecked} onChange={toggleAll} title="Select all" className="shrink-0" />
        )}
        <ListChecks size={16} className="text-accent" />
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Print queue</h2>
        <span className="text-[11px] text-faint">
          {items.length}
          {totalForFilter != null && totalForFilter > items.length ? ` of ${totalForFilter}` : ""} job{items.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {(["active", "failed", "completed", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFilter(f); clearSel(); }}
              className={
                "px-2 py-0.5 text-[11px] rounded-full transition " +
                (filter === f
                  ? "bg-cobble-600 text-white"
                  : "border border-line dark:border-slate-600 text-muted hover:text-accent hover:border-accent")
              }
            >
              {f === "active" ? "Active" : f === "failed" ? "Failed" : f === "completed" ? "Done" : "All"}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden">
          {([["list", "List"], ["timeline", "Timeline"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setView(v)} className={"text-[11px] px-2 py-0.5 transition " + (view === v ? "bg-cobble-600 text-white" : "text-muted hover:text-accent")}>
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setNewOpen(true)}
          className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-2.5 py-1 text-xs transition"
        >
          <Plus size={13} /> New job
        </button>
      </div>

      {sel.size > 0 && (
        <div className="flex items-center gap-2 rounded bg-subtle dark:bg-slate-800 px-2.5 py-1.5 text-xs">
          <span className="text-content dark:text-mortar-200 font-medium">{sel.size} selected</span>
          <div className="flex-1" />
          {bulkSendable.length > 0 && (
            <button onClick={bulkSend} disabled={send.isPending} className="inline-flex items-center gap-1 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-0.5 disabled:opacity-50">
              <Send size={11} /> Send {bulkSendable.length}
            </button>
          )}
          {bulkCancelable.length > 0 && (
            <button onClick={bulkCancel} disabled={cancel.isPending} className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 hover:border-ember-500 hover:text-ember-500 px-2 py-0.5 disabled:opacity-50">
              <Ban size={11} /> Cancel {bulkCancelable.length}
            </button>
          )}
          {bulkDeletable.length > 0 && (
            <button onClick={bulkRemove} disabled={del.isPending} className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 hover:border-ember-500 hover:text-ember-500 px-2 py-0.5 disabled:opacity-50">
              <Trash2 size={11} /> Remove {bulkDeletable.length}
            </button>
          )}
          <button onClick={clearSel} className="text-faint hover:text-content px-1.5 py-0.5">Clear</button>
        </div>
      )}

      {view === "timeline" && <QueueTimeline slug={activeSlug} jobs={rawItems} onOpenJob={setDetailId} />}
      {view === "list" && jobs.isLoading && <div className="text-sm text-muted">Loading queue…</div>}
      {view === "list" && items.length === 0 && !jobs.isLoading && (
        <div className="text-[13px] text-muted dark:text-slate-400 italic">
          {filter === "active"
            ? "No active jobs. Create one — then Send it to the farm when you're ready."
            : filter === "failed"
              ? "No failed jobs. 🎉"
              : filter === "completed"
                ? "No finished jobs yet."
                : "No jobs. Create one to get started."}
        </div>
      )}

      {view === "list" && items.length > 0 && (
      <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {items.map((jb) => {
          const conn = jb.connection_id ? connById.get(jb.connection_id) : undefined;
          const target =
            jb.target_pool && !jb.target_device
              ? "⟳ pool — waiting for a free printer"
              : jb.target_device
                ? `printer ${jb.target_device}`
                : jb.target_tag
                  ? `#${jb.target_tag}`
                  : jb.linked_machine_id
                    ? "→ linked machine"
                    : "file routing";
          return (
            <li key={jb.id} className="px-2.5 py-2.5 flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={sel.has(jb.id)}
                onChange={() => toggleSel(jb.id)}
                className="shrink-0"
                title="Select"
              />
              {/* The row body is a button → opens the full job detail (error, timeline,
                  build/material/priority) instead of squeezing it into the row. */}
              <button type="button" onClick={() => setDetailId(jb.id)} className="flex-1 min-w-0 text-left group">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] text-content dark:text-mortar-100 truncate group-hover:text-accent transition">{jb.file_ref}</span>
                  <span className={"text-[10px] px-1.5 py-0.5 rounded font-medium " + (JOB_STATUS_STYLE[jb.status] ?? "text-muted bg-subtle")}>
                    {jb.status}
                  </span>
                  {jb.external && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40" title="Started on the printer, not sent from Cobblr">
                      on printer
                    </span>
                  )}
                  {jb.linked_build_id && (
                    <span
                      className={"text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-0.5 " + (jb.build_reversed_at ? "text-faint bg-subtle line-through" : "text-moss-600 bg-moss-50 dark:text-moss-400 dark:bg-moss-950/40")}
                      title={jb.build_reversed_at ? "Build consumption was reversed" : jb.build_consumed_at ? "Build materials consumed from inventory" : "Produces a build on send"}
                    >
                      <Boxes size={10} /> build{jb.build_qty > 1 ? ` ×${jb.build_qty}` : ""}
                    </span>
                  )}
                  {jb.status === "printing" && jb.progress != null && (
                    <span className="text-[11px] text-accent">{Math.round(jb.progress * 100)}%</span>
                  )}
                </div>
                <div className="text-[11px] text-faint truncate">
                  {conn?.label ?? "—"} · {target}
                  {jb.error && <span className="text-ember-500"> · {jb.error}</span>}
                </div>
              </button>
              {canPoll(jb) && (
                <button
                  onClick={() => poll.mutate(jb.id)}
                  disabled={poll.isPending}
                  title="Refresh status"
                  className="text-faint hover:text-accent transition p-1.5 disabled:opacity-50"
                >
                  <RefreshCw size={14} className={poll.isPending && poll.variables === jb.id ? "animate-spin" : ""} />
                </button>
              )}
              {canSend(jb) && (
                <button
                  onClick={() => askSend(jb)}
                  disabled={send.isPending}
                  className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-xs transition disabled:opacity-50"
                >
                  <Send size={12} /> Send
                </button>
              )}
              {canRetry(jb) && (
                <button
                  onClick={() => retry.mutate(jb.id)}
                  disabled={retry.isPending}
                  title="Retry - re-queue and send again"
                  className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent hover:text-accent text-content dark:text-mortar-200 px-2.5 py-1 text-xs transition disabled:opacity-50"
                >
                  <RefreshCw size={12} className={retry.isPending && retry.variables === jb.id ? "animate-spin" : ""} /> Retry
                </button>
              )}
              {canAssign(jb) && <ReassignControl job={jb} slug={activeSlug} onDone={invalidate} />}
              {canCancel(jb) && (
                <button onClick={() => askCancel(jb)} disabled={cancel.isPending} title="Cancel" className="text-faint hover:text-ember-500 transition p-1.5 disabled:opacity-50">
                  <Ban size={14} />
                </button>
              )}
              {canDelete(jb) && (
                <button
                  onClick={async () => { if (await confirm({ title: "Remove this job?", message: "Deletes it from the queue.", confirmLabel: "Remove", destructive: true })) del.mutate(jb.id); }}
                  disabled={del.isPending}
                  title="Remove from queue"
                  className="text-faint hover:text-ember-500 transition p-1.5 disabled:opacity-50"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      )}
      {jobs.hasNextPage && (
        <button
          onClick={() => void jobs.fetchNextPage()}
          disabled={jobs.isFetchingNextPage}
          className="w-full text-xs text-accent hover:underline py-1.5 disabled:opacity-50"
        >
          {jobs.isFetchingNextPage ? "Loading…" : "Load older jobs →"}
        </button>
      )}

      {newOpen && (
        <NewJobModal
          connections={connections}
          onClose={() => setNewOpen(false)}
          onCreated={() => {
            invalidate();
            setNewOpen(false);
          }}
        />
      )}
      {detailId && (
        <JobDetailModal
          jobId={detailId}
          connections={connections}
          onClose={() => setDetailId(null)}
          onChanged={invalidate}
        />
      )}
    </section>
  );
}

// Full job detail — the one place to read a job's whole story: full (untruncated)
// error, timestamps, routing, the build/material it draws, priority + attempts,
// and the same actions the row offers (send / retry / cancel) plus an inline
// priority edit. Row click opens this (audit: "no job detail view").
function JobDetailModal({
  jobId,
  connections,
  onClose,
  onChanged,
}: {
  jobId: string;
  connections: DigifabConnection[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["digifab-job", activeSlug, jobId],
    queryFn: () => api.getDigifabJob(activeSlug, jobId),
    enabled: !!activeSlug,
    refetchInterval: (query) => (query.state.data && !TERMINAL_JOB(query.state.data.status) ? 5000 : false),
  });
  const j = q.data;
  const conn = j?.connection_id ? connections.find((c) => c.id === j.connection_id) : undefined;
  const refresh = () => { void q.refetch(); onChanged(); };
  const act = (fn: () => Promise<unknown>, ok: string) =>
    fn().then(() => { toast.success(ok); refresh(); }).catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
  const send = useMutation({ mutationFn: () => api.sendDigifabJob(activeSlug, jobId), onSuccess: () => { toast.success("Sent"); refresh(); }, onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)) });
  const setPriority = useMutation({
    mutationFn: (p: number) => api.updateDigifabJob(activeSlug, jobId, { priority: p }),
    onSuccess: () => { toast.success("Priority updated"); refresh(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const row = (label: string, value: ReactNode) => (
    <div className="flex gap-3 py-1.5 border-b border-line/60 dark:border-slate-800 last:border-0">
      <span className="w-32 shrink-0 text-[11px] font-mono uppercase tracking-wider text-faint pt-0.5">{label}</span>
      <span className="flex-1 min-w-0 text-sm text-content dark:text-mortar-100 break-words">{value}</span>
    </div>
  );
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <Modal open onClose={onClose} title="Print job" size="md">
      {!j ? (
        <div className="text-sm text-muted py-6 text-center">{q.isLoading ? "Loading…" : "Job not found."}</div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-content dark:text-mortar-100 break-all">{j.file_ref}</span>
            <span className={"text-[10px] px-1.5 py-0.5 rounded font-medium " + (JOB_STATUS_STYLE[j.status] ?? "text-muted bg-subtle")}>{j.status}</span>
            {j.status === "printing" && j.progress != null && <span className="text-[11px] text-accent">{Math.round(j.progress * 100)}%</span>}
          </div>
          {j.error && (
            <div className="rounded border border-ember-500/40 bg-ember-50 dark:bg-ember-950/30 px-3 py-2 text-[13px] text-ember-700 dark:text-ember-300 whitespace-pre-wrap break-words">
              {j.error}
            </div>
          )}
          <div>
            {row("Connection", conn?.label ?? (j.connection_id ? j.connection_id : "—"))}
            {row("Target", j.target_device ? `printer ${j.target_device}` : j.target_pool ? "pool (auto-assign)" : j.target_tag ? `#${j.target_tag}` : j.linked_machine_id ? "linked machine" : "file routing")}
            {j.linked_build_id ? row("Produces build", <span className={j.build_reversed_at ? "line-through text-faint" : ""}>{`×${j.build_qty}${j.build_reversed_at ? " (reversed)" : j.build_consumed_at ? " (consumed)" : " (on send)"}`}</span>) : null}
            {j.material_part_id ? row("Filament", `${j.material_grams ?? "?"} g`) : null}
            {row("Priority", (
              <select
                value={j.priority}
                onChange={(e) => setPriority.mutate(Number(e.target.value))}
                disabled={setPriority.isPending || TERMINAL_JOB(j.status)}
                className="px-1.5 py-0.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 disabled:opacity-50"
              >
                <option value={0}>Normal</option>
                <option value={10}>High</option>
                <option value={20}>Urgent</option>
              </select>
            ))}
            {row("Attempts", `${j.attempts} / ${j.max_attempts}`)}
            {row("Created", when(j.created_at))}
            {row("Updated", when(j.updated_at))}
            {row("Last polled", when(j.last_polled_at))}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            {canSend(j) && (
              <button onClick={() => send.mutate()} disabled={send.isPending} className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm disabled:opacity-50">
                <Send size={13} /> Send
              </button>
            )}
            {canRetry(j) && (
              <button onClick={() => act(() => api.retryDigifabJob(activeSlug, jobId), "Retrying")} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent hover:text-accent px-3 py-1.5 text-sm">
                <RefreshCw size={13} /> Retry
              </button>
            )}
            {canCancel(j) && (
              <button
                onClick={async () => { if (await confirm({ title: "Cancel this print?", message: "Marks it cancelled and stops Cobblr tracking it. On a live farm the printer may keep running.", confirmLabel: "Cancel print", destructive: true })) act(() => api.cancelDigifabJob(activeSlug, jobId), "Cancelled"); }}
                className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-ember-500 hover:text-ember-500 px-3 py-1.5 text-sm"
              >
                <Ban size={13} /> Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// Edit a connection — rename, move it to a new host, rotate its credentials, or
// disable it — instead of delete-and-recreate (which cascades away its machine
// links). Wires up PATCH /connections/:id (audit: "no connection edit").
function ConnectionEditModal({ connection, onClose, onSaved }: { connection: DigifabConnection; onClose: () => void; onSaved: () => void }) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [label, setLabel] = useState(connection.label);
  const [baseUrl, setBaseUrl] = useState(connection.base_url);
  const [enabled, setEnabled] = useState(connection.enabled);
  const [apiKey, setApiKey] = useState(""); // blank = leave unchanged
  const isMock = connection.type === "mock";
  const save = useMutation({
    mutationFn: () =>
      api.updateDigifabConnection(activeSlug, connection.id, {
        label: label.trim(),
        base_url: baseUrl.trim(),
        enabled,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      }),
    onSuccess: () => { toast.success("Connection updated"); onSaved(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  return (
    <Modal open onClose={onClose} title={`Edit "${connection.label}"`} size="md">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
        <label className="block">
          <span className={lbl}>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={field} autoFocus />
        </label>
        <label className="block">
          <span className={lbl}>Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={field} />
        </label>
        {!isMock && (
          <label className="block">
            <span className={lbl}>Rotate API key (optional)</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="leave blank to keep the current key" className={field} />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-100">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (uncheck to pause without deleting)
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={save.isPending || !label.trim() || !baseUrl.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}


/** ⑥ Queue timeline — one row per machine: the running job (progress + finish
 *  clock) and the jobs lined up behind it, in assignment order. Pool jobs that
 *  haven't been assigned yet get a row per pool. The honest version of
 *  SimplyPrint's Gantt: queued jobs have no reliable duration, so they render as
 *  ordered chips, not time-scaled bars. */
function QueueTimeline({ slug, jobs, onOpenJob }: { slug: string; jobs: DigifabJob[]; onOpenJob: (id: string) => void }) {
  const fleet = useQuery({
    queryKey: ["digifab-fleet", slug],
    queryFn: () => api.getDigifabFleet(slug),
    enabled: !!slug,
    refetchInterval: 12_000,
    placeholderData: (prev) => prev,
  });
  const devices = (fleet.data?.connections ?? []).filter((c) => !c.error).flatMap((c) => c.devices.map((d) => ({ ...d, connId: c.connection_id, connLabel: c.label })));
  // Assignment order: priority first, then oldest — the order the worker/send
  // path will actually run them (the jobs list arrives newest-first).
  const queued = jobs
    .filter((j) => j.status === "queued" && !j.external)
    .sort((a, b) => b.priority - a.priority || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const rows = devices
    .map((d) => {
      const nextIds = new Set<string>();
      const lineup = queued.filter((j) => {
        if (j.connection_id === d.connId && j.target_device === d.id) { nextIds.add(j.id); return true; }
        if (j.target_pool && j.target_pool === d.pool_id) { nextIds.add(j.id); return true; }
        return false;
      });
      return { d, lineup };
    })
    .filter((r) => r.d.active_job || r.lineup.length > 0);
  const unassignedPoolJobs = queued.filter((j) => j.target_pool && !devices.some((d) => d.pool_id === j.target_pool));
  const awaiting = jobs.filter((j) => j.status === "awaiting-assignment" && !j.external);
  const doneClock = (etaSec: number | null | undefined) =>
    etaSec != null && etaSec > 0 ? new Date(Date.now() + etaSec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  if (fleet.isLoading && !fleet.data) return <div className="text-sm text-muted">Loading timeline…</div>;
  if (rows.length === 0 && unassignedPoolJobs.length === 0 && awaiting.length === 0) {
    return <div className="text-[13px] text-muted dark:text-slate-400 italic">Nothing running or queued - the timeline fills in as you queue jobs.</div>;
  }
  return (
    <div className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
      {rows.map(({ d, lineup }) => {
        const job = d.active_job;
        const pct = job?.progress != null ? Math.round(job.progress * 100) : null;
        const done = doneClock(job?.eta_sec);
        return (
          <div key={`${d.connId}:${d.id}`} className="flex items-center gap-3 px-2.5 py-2">
            <div className="w-40 shrink-0 min-w-0">
              <div className="text-xs font-medium text-content dark:text-mortar-100 truncate">{d.name}</div>
              {d.pool_name && <div className="text-[10px] text-faint truncate">{d.pool_name}</div>}
            </div>
            <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto">
              {job ? (
                <button
                  type="button"
                  onClick={() => onOpenJob(job.id)}
                  className="relative shrink-0 w-56 rounded border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-950/40 px-2 py-1 text-left overflow-hidden"
                  title={job.file_ref}
                >
                  {pct != null && <div className="absolute inset-y-0 left-0 bg-cobble-500/20" style={{ width: `${pct}%` }} />}
                  <div className="relative text-[11px] text-content dark:text-mortar-100 truncate">{job.file_ref}</div>
                  <div className="relative text-[10px] font-mono text-faint">
                    {job.status}{pct != null ? ` · ${pct}%` : ""}{done ? ` · ~done ${done}` : ""}
                  </div>
                </button>
              ) : (
                <span className="shrink-0 text-[11px] text-faint italic px-1">free</span>
              )}
              {lineup.map((j, i) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => onOpenJob(j.id)}
                  className="shrink-0 max-w-44 rounded border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800/60 px-2 py-1 text-left"
                  title={j.file_ref}
                >
                  <div className="text-[11px] text-content dark:text-mortar-100 truncate">{i + 1}. {j.file_ref}</div>
                  <div className="text-[10px] font-mono text-faint">queued{j.target_pool ? " · pool" : ""}</div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {unassignedPoolJobs.length > 0 && (
        <div className="flex items-center gap-3 px-2.5 py-2">
          <div className="w-40 shrink-0 text-xs text-faint italic">pool (no free printer)</div>
          <div className="flex-1 flex items-center gap-1.5 overflow-x-auto">
            {unassignedPoolJobs.map((j) => (
              <button key={j.id} type="button" onClick={() => onOpenJob(j.id)} className="shrink-0 max-w-44 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-left" title={j.file_ref}>
                <div className="text-[11px] text-content dark:text-mortar-100 truncate">{j.file_ref}</div>
                <div className="text-[10px] font-mono text-amber-600">waiting</div>
              </button>
            ))}
          </div>
        </div>
      )}
      {awaiting.length > 0 && (
        <div className="flex items-center gap-3 px-2.5 py-2">
          <div className="w-40 shrink-0 text-xs text-amber-600">needs a printer pick</div>
          <div className="flex-1 flex items-center gap-1.5 overflow-x-auto">
            {awaiting.map((j) => (
              <button key={j.id} type="button" onClick={() => onOpenJob(j.id)} className="shrink-0 max-w-44 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-left" title={j.file_ref}>
                <div className="text-[11px] text-content dark:text-mortar-100 truncate">{j.file_ref}</div>
                <div className="text-[10px] font-mono text-amber-600">awaiting assignment</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NewJobModal({
  connections,
  onClose,
  onCreated,
}: {
  connections: DigifabConnection[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [fileRef, setFileRef] = useState("");
  const [routeBy, setRouteBy] = useState<"file" | "machine" | "printer" | "tag" | "pool">("file");
  const [machineId, setMachineId] = useState("");
  const [printerId, setPrinterId] = useState("");
  const [tag, setTag] = useState("");
  const [poolId, setPoolId] = useState("");
  const [fileId, setFileId] = useState("");
  const [materialPartId, setMaterialPartId] = useState("");
  const [materialGrams, setMaterialGrams] = useState("");
  const [materialType, setMaterialType] = useState("");
  const [slicerMeta, setSlicerMeta] = useState<{ material: string | null; filament_g: number | null } | null>(null);
  const [buildId, setBuildId] = useState("");
  const [buildQty, setBuildQty] = useState("1");
  const [priority, setPriority] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(1);

  const pools = useQuery({
    queryKey: ["digifab-pools", activeSlug],
    queryFn: () => api.listDigifabPools(activeSlug),
    enabled: !!activeSlug,
  });
  // Filament parts to deduct from on completion (any inventory part).
  const parts = useQuery({
    queryKey: ["inventory-parts-flat", activeSlug],
    queryFn: () => api.listInventoryParts(activeSlug),
    enabled: !!activeSlug,
  });
  // Builds (bills-of-materials) this job can produce — drawn from inventory on
  // send. 404s + empty when the builds module isn't enabled; the field hides.
  const builds = useQuery({
    queryKey: ["digifab-builds-flat", activeSlug],
    queryFn: () => api.listDigifabBuilds(activeSlug),
    enabled: !!activeSlug,
    retry: false,
  });

  const machines = useQuery({
    queryKey: ["digifab-all-machines", activeSlug],
    queryFn: () => fetchAllMachines(activeSlug),
    enabled: !!activeSlug && routeBy === "machine",
  });
  const printers = useQuery({
    queryKey: ["digifab-printers", activeSlug, connectionId],
    queryFn: () => api.listDigifabDevices(activeSlug, connectionId),
    enabled: !!connectionId && routeBy === "printer",
  });
  // Stored files to optionally upload as the real print bytes.
  const files = useQuery({
    queryKey: ["files", activeSlug],
    queryFn: () => api.listFiles(activeSlug),
    enabled: !!activeSlug,
  });

  // Auto-fill filament from the picked file's slicer metadata — the material +
  // grams the slicer already computed, so the operator doesn't retype them.
  useEffect(() => {
    if (!fileId || !activeSlug) { setSlicerMeta(null); return; }
    let cancelled = false;
    api.getDigifabSlicerMeta(activeSlug, fileId).then((m) => { if (!cancelled) setSlicerMeta(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [fileId, activeSlug]);
  // Apply the parsed meta to the still-empty fields (never clobber manual input),
  // and match a spool by material name (PLA → "PolyTerra PLA …").
  useEffect(() => {
    const m = slicerMeta;
    if (!m) return;
    if (m.material && !materialType) setMaterialType(m.material);
    if (m.filament_g != null && !materialGrams) setMaterialGrams(String(m.filament_g));
    if (m.material && !materialPartId) {
      const mat = m.material.toUpperCase();
      const hit = (parts.data?.items ?? []).find((p) => (p.name ?? "").toUpperCase().includes(mat));
      if (hit) setMaterialPartId(hit.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slicerMeta, parts.data]);

  const save = useMutation({
    mutationFn: () =>
      api.createDigifabJob(activeSlug, {
        // A pool job is unassigned — no connection; the worker picks a free member.
        connection_id: routeBy === "pool" ? undefined : connectionId,
        file_ref: fileRef.trim(),
        target_device: routeBy === "printer" ? printerId || null : null,
        target_tag: routeBy === "tag" ? tag.trim() || null : null,
        target_pool: routeBy === "pool" ? poolId || null : null,
        material_part_id: materialPartId || null,
        material_grams: materialPartId && materialGrams ? Number(materialGrams) : null,
        material_type: materialType || null,
        linked_build_id: buildId || null,
        build_qty: buildId ? Math.max(1, Math.floor(Number(buildQty)) || 1) : undefined,
        file_id: fileId || null,
        linked_machine_id: routeBy === "machine" ? machineId || null : null,
        priority,
        max_attempts: maxAttempts,
      }),
    onSuccess: () => {
      toast.success(routeBy === "pool" ? "Queued to the pool — auto-assigns to a free printer" : "Job queued");
      onCreated();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  const machineList = machines.data?.items ?? [];
  const printerList = printers.data?.items ?? [];
  const fileList = files.data?.items ?? [];
  const poolList = pools.data?.items ?? [];
  const partList = parts.data?.items ?? [];
  const buildList = builds.data?.items ?? [];
  const routeValid =
    routeBy === "file" ||
    (routeBy === "machine" && !!machineId) ||
    (routeBy === "printer" && !!printerId) ||
    (routeBy === "tag" && !!tag.trim()) ||
    (routeBy === "pool" && !!poolId);
  // A pool job is unassigned, so it needs no connection; every other mode does.
  const connOk = routeBy === "pool" || !!connectionId;

  return (
    <Modal open onClose={onClose} title="New print job" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        {/* Route-by first: it decides which target field (and whether a connection)
            you need, so it leads instead of hiding at the bottom. */}
        <label className="block">
          <span className={lbl}>Where should it print?</span>
          <select value={routeBy} onChange={(e) => setRouteBy(e.target.value as typeof routeBy)} className={field}>
            <option value="printer">A specific printer</option>
            <option value="pool">A pool (auto-assign to a free printer)</option>
            <option value="machine">A linked machine</option>
            <option value="tag">A tag (printer group)</option>
            <option value="file">By the filename (advanced routing)</option>
          </select>
        </label>
        {routeBy !== "pool" && (
          <label className="block">
            <span className={lbl}>Connection</span>
            <Combobox
              value={connectionId}
              onChange={setConnectionId}
              options={connections.map((c) => ({ value: c.id, label: c.label, hint: c.type }))}
              placeholder="Search connections…"
            />
          </label>
        )}
        {routeBy === "pool" && (
          <label className="block">
            <span className={lbl}>Pool</span>
            <Combobox
              value={poolId}
              onChange={setPoolId}
              options={poolList.map((p) => ({ value: p.id, label: p.name, hint: `${p.members.length} machine${p.members.length === 1 ? "" : "s"}` }))}
              placeholder=" - pick a pool - "
            />
            <span className="text-[11px] text-faint">Queues unassigned - Cobblr drips it onto the next free machine in the pool.</span>
          </label>
        )}
        {routeBy === "machine" && (
          <label className="block">
            <span className={lbl}>Machine</span>
            <Combobox
              value={machineId}
              onChange={setMachineId}
              options={machineList.map((m) => ({ value: m.id, label: m.instLabel ? `${m.name} · ${m.instLabel}` : m.name }))}
              placeholder=" - pick a machine - "
            />
            <span className="text-[11px] text-faint">Routes to the farm printer that machine is linked to.</span>
          </label>
        )}
        {routeBy === "printer" && (
          <label className="block">
            <span className={lbl}>Printer</span>
            <Combobox
              value={printerId}
              onChange={setPrinterId}
              options={printerList.map((p) => ({ value: p.id, label: p.name, hint: p.state ?? undefined }))}
              placeholder=" - pick a printer - "
            />
          </label>
        )}
        {routeBy === "tag" && (
          <label className="block">
            <span className={lbl}>Tag</span>
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="pla" className={field} />
          </label>
        )}
        <label className="block">
          <span className={lbl}>File / routing ref</span>
          <input value={fileRef} onChange={(e) => setFileRef(e.target.value)} placeholder="bracket.gcode" className={field} autoFocus />
        </label>
        <label className="block">
          <span className={lbl}>Printable file (optional)</span>
          <Combobox
            value={fileId}
            onChange={(id) => {
              setFileId(id);
              // Convenience: name the routing ref after the file if blank.
              const f = fileList.find((x) => x.id === id);
              if (f && !fileRef.trim()) setFileRef(f.filename);
            }}
            options={fileList.map((f) => ({ value: f.id, label: f.filename }))}
            placeholder=" - routing-only (no upload) - "
            allowClear
          />
          <span className="text-[11px] text-faint">
            Pick a stored file to upload its real bytes on send. Leave blank to send routing only.
          </span>
        </label>
        <label className="block">
          <span className={lbl}>Filament (optional)</span>
          <div className="flex gap-2">
            <Combobox
              value={materialPartId}
              onChange={setMaterialPartId}
              options={partList.map((p) => ({ value: p.id, label: p.name }))}
              placeholder=" - don't track material - "
              allowClear
              className="flex-1"
            />
            <input
              type="number"
              min="0"
              step="any"
              value={materialGrams}
              onChange={(e) => setMaterialGrams(e.target.value)}
              placeholder="grams"
              disabled={!materialPartId}
              className={field + " w-28 disabled:opacity-50"}
            />
          </div>
          {slicerMeta && (slicerMeta.material || slicerMeta.filament_g != null) ? (
            <span className="text-[11px] text-moss-600 dark:text-moss-400">
              ↳ from the file:{" "}
              {[slicerMeta.material, slicerMeta.filament_g != null ? `${slicerMeta.filament_g} g` : null].filter(Boolean).join(" · ")}
              {" "} - auto-filled from the slicer, edit if needed.
            </span>
          ) : (
            <span className="text-[11px] text-faint">Pick a file above and Cobblr reads the filament + grams from its slicer metadata. When the print completes, the grams are deducted from that spool's stock.</span>
          )}
        </label>
        {buildList.length === 0 && !builds.isLoading && builds.isSuccess && (
          <div className="text-[11px] text-faint italic">Tip: define a build (bill-of-materials) to have this job draw its parts from inventory automatically.</div>
        )}
        {buildList.length > 0 && (
          <label className="block">
            <span className={lbl}>Produces a build (optional)</span>
            <Combobox
              value={buildId}
              onChange={setBuildId}
              options={buildList.map((b) => ({ value: b.id, label: b.name }))}
              placeholder=" - don't make a build - "
              allowClear
            />
            {buildId && (
              <div className="mt-1.5 flex items-center gap-2 text-[13px] text-content dark:text-mortar-200">
                <span>How many?</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={buildQty}
                  onChange={(e) => setBuildQty(e.target.value)}
                  className={field + " w-20"}
                />
              </div>
            )}
            <span className="block text-[11px] text-faint mt-1">When this job is sent to the machine, the build's components are drawn from inventory and the finished part is added (× qty). A scrapped, cancelled or failed print puts them back.</span>
          </label>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={lbl}>Priority</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} className={field}>
              <option value={0}>Normal</option>
              <option value={10}>High</option>
              <option value={20}>Urgent</option>
            </select>
            <span className="text-[11px] text-faint">Higher-priority queued jobs assign to a free printer first.</span>
          </label>
          <label className="block">
            <span className={lbl}>Auto-retry on fail</span>
            <select value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} className={field}>
              <option value={1}>No retry</option>
              <option value={2}>1 retry</option>
              <option value={3}>2 retries</option>
              <option value={4}>3 retries</option>
            </select>
            <span className="text-[11px] text-faint">A failed print re-queues and re-sends up to this many times.</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={save.isPending || !connOk || !fileRef.trim() || !routeValid} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {save.isPending ? "Queuing…" : "Queue job"}
          </button>
        </div>
      </form>
    </Modal>
  );
}



function ConnectionPrinters({ connection }: { connection: DigifabConnection }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const printers = useQuery({
    queryKey: ["digifab-printers", activeSlug, connection.id],
    queryFn: () => api.listDigifabDevices(activeSlug, connection.id),
  });
  const machines = useQuery({
    queryKey: ["digifab-all-machines", activeSlug],
    queryFn: () => fetchAllMachines(activeSlug),
    enabled: !!activeSlug,
  });
  const links = useQuery({
    queryKey: ["digifab-links", activeSlug],
    queryFn: () => api.listDigifabLinks(activeSlug),
    enabled: !!activeSlug,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["digifab-links", activeSlug] });
  const link = useMutation({
    mutationFn: (v: { remote_device_id: string; remote_device_name: string | null; machine_id: string; machine_label: string | null }) =>
      api.createDigifabLink(activeSlug, { connection_id: connection.id, ...v }),
    onSuccess: () => { toast.success("Linked to machine"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api.deleteDigifabLink(activeSlug, id),
    onSuccess: () => { toast.success("Unlinked"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = printers.data?.items ?? [];
  const machineList = machines.data?.items ?? [];
  // Links for THIS connection, indexed by farm printer id.
  const linkByPrinter = new Map(
    (links.data?.items ?? []).filter((l) => l.connection_id === connection.id).map((l) => [l.remote_device_id, l]),
  );

  return (
    <div>
      {printers.isLoading && <div className="text-xs text-muted py-1">Loading printers…</div>}
      {printers.isError && <div className="text-xs text-ember-500 py-1">Couldn't reach the farm - test the connection.</div>}
      {!printers.isLoading && !printers.isError && items.length === 0 && (
        <div className="text-xs text-muted italic py-1">No printers reported.</div>
      )}
      <ul className="divide-y divide-line dark:divide-slate-800">
        {items.map((p) => {
          const linked = linkByPrinter.get(p.id);
          return (
            <li key={p.id} className="py-2.5 flex items-center gap-2 text-sm">
              <Printer size={14} className="text-faint shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-content dark:text-mortar-100 truncate">{p.name}</span>
                  {p.state && <span className="text-[11px] text-faint">{p.state}</span>}
                  <span className={"text-[11px] " + (p.enabled ? "text-moss-600 dark:text-moss-400" : "text-faint")}>
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                {linked && (
                  <div className="text-[11px] text-accent dark:text-cobble-400 mt-0.5">
                    → {linked.machine_label ?? "linked machine"}
                  </div>
                )}
              </div>
              <Combobox
                className="max-w-[14rem]"
                disabled={link.isPending || unlink.isPending || machines.isLoading}
                value={linked?.machine_id ?? ""}
                allowClear
                placeholder=" - link to machine - "
                options={machineList.map((m) => ({ value: m.id, label: m.instLabel ? `${m.name} · ${m.instLabel}` : m.name }))}
                onChange={(machineId) => {
                  if (!machineId) {
                    if (linked) unlink.mutate(linked.id);
                    return;
                  }
                  const m = machineList.find((mm) => mm.id === machineId);
                  link.mutate({
                    remote_device_id: p.id,
                    remote_device_name: p.name,
                    machine_id: machineId,
                    machine_label: m?.name ?? null,
                  });
                }}
              />
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] text-faint">
        Link a farm printer to one of your machines - a job linked to that machine then routes to its printer automatically.
      </p>
    </div>
  );
}

// ── Fleet view ────────────────────────────────────────────────────────────
// The live floor: every connection's machines + their state, with Cobblr's
// in-flight jobs overlaid. Polls every 12s. Coordinate-not-control — this only
// reads what each manager reports; it never drives hardware.

// ── File library — stored 3MF/gcode with slicer thumbnails, send to a machine ──
function LibrarySection({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const lib = useQuery({ queryKey: ["digifab-library", slug], queryFn: () => api.listDigifabLibrary(slug), enabled: !!slug });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadDigifabLibrary(slug, file),
    onSuccess: () => { toast.success("Added to library"); void qc.invalidateQueries({ queryKey: ["digifab-library", slug] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Upload failed"),
  });
  const itemsL = lib.data?.items ?? [];
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Library</h2>
        <span className="text-xs text-faint">{itemsL.length} file{itemsL.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        <input ref={fileRef} type="file" accept=".3mf,.gcode,.gco,.g" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} disabled={upload.isPending} className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-xs disabled:opacity-50">
          <Plus size={13} /> {upload.isPending ? "Uploading…" : "Upload file"}
        </button>
      </div>
      {itemsL.length === 0 ? (
        <div className="text-xs text-muted dark:text-slate-400 italic">No files yet. Upload a .3mf or .gcode - Cobblr pulls out the slicer's plate preview, and you can send it to any machine.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {itemsL.map((it) => <LibraryCard key={it.id} item={it} slug={slug} />)}
        </div>
      )}
    </section>
  );
}

function LibraryCard({ item, slug }: { item: DigifabLibraryItem; slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [sendOpen, setSendOpen] = useState(false);
  const thumb = useImageSrc(item.thumbnail_file_id ? api.fileRawUrl(slug, item.thumbnail_file_id) : null);
  const del = useMutation({
    mutationFn: () => api.deleteDigifabLibrary(slug, item.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["digifab-library", slug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });
  const size = item.size_bytes > 1_048_576 ? `${(item.size_bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(item.size_bytes / 1024))} KB`;
  return (
    // Draggable: drop it on a fleet tile to print it THERE (confirm-gated) —
    // the FDMM drag-a-gcode-onto-a-printer interaction.
    <div
      className="rounded-lg border border-line dark:border-slate-700 overflow-hidden flex flex-col cursor-grab active:cursor-grabbing"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(LIBRARY_DRAG_MIME, JSON.stringify({ name: item.name, file_id: item.file_id }));
        e.dataTransfer.effectAllowed = "copy";
      }}
      title="Drag onto a fleet machine to print it there"
    >
      <div className="aspect-square bg-subtle dark:bg-slate-800 flex items-center justify-center">
        {thumb ? <img src={thumb} alt="" className="w-full h-full object-contain" /> : <Boxes size={26} className="text-faint" />}
      </div>
      <div className="p-2 space-y-1 flex-1 flex flex-col">
        <div className="text-xs text-content dark:text-mortar-100 truncate" title={item.name}>{item.name}</div>
        <div className="flex items-center gap-1 text-[10px] text-faint flex-wrap">
          <span className="uppercase font-mono">{item.kind}</span>
          {item.plate_count > 1 && <span>· {item.plate_count} plates</span>}
          <span>· {size}</span>
          {item.metadata?.material && <span>· {item.metadata.material}</span>}
          {item.metadata?.estimated_sec && (
            <span>· ~{Math.floor(item.metadata.estimated_sec / 3600)}h{Math.round((item.metadata.estimated_sec % 3600) / 60)}m</span>
          )}
          {item.metadata?.parts_per_plate && <span>· {item.metadata.parts_per_plate}×/plate</span>}
        </div>
        <div className="flex items-center gap-1.5 pt-1 mt-auto">
          <button onClick={() => setSendOpen(true)} className="flex-1 inline-flex items-center justify-center gap-1 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-1 text-[11px]"><Send size={11} /> Send</button>
          <button
            onClick={async () => { if (await confirm({ title: `Delete "${item.name}"?`, message: "Removes it from the library (doesn't touch any printer).", confirmLabel: "Delete", destructive: true })) del.mutate(); }}
            disabled={del.isPending}
            className="text-faint hover:text-ember-500 p-1 disabled:opacity-50"
            title="Delete"
          ><Trash2 size={13} /></button>
        </div>
      </div>
      {sendOpen && <LibrarySendModal item={item} slug={slug} onClose={() => setSendOpen(false)} />}
    </div>
  );
}

function LibrarySendModal({ item, slug, onClose }: { item: DigifabLibraryItem; slug: string; onClose: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"printer" | "pool">("printer");
  const [connectionId, setConnectionId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [poolId, setPoolId] = useState("");
  const conns = useQuery({ queryKey: ["digifab-connections", slug], queryFn: () => api.listDigifabConnections(slug), enabled: !!slug });
  const pools = useQuery({ queryKey: ["digifab-pools", slug], queryFn: () => api.listDigifabPools(slug), enabled: !!slug });
  const devices = useQuery({ queryKey: ["digifab-printers", slug, connectionId], queryFn: () => api.listDigifabDevices(slug, connectionId), enabled: !!connectionId && mode === "printer" });
  const send = useMutation({
    mutationFn: () => api.sendDigifabLibrary(slug, item.id, mode === "pool" ? { target_pool: poolId } : { connection_id: connectionId, target_device: deviceId || null }),
    onSuccess: (r) => { toast.success(mode === "pool" ? "Queued to the pool — auto-assigns to a free printer" : `Sent — ${r.status}`); onClose(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Send failed"),
  });
  const connList = conns.data?.items ?? [];
  const poolList = pools.data?.items ?? [];
  const deviceList = devices.data?.items ?? [];
  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint mb-1";
  const ready = mode === "pool" ? !!poolId : !!connectionId && !!deviceId;
  return (
    <Modal open onClose={onClose} title={`Send "${item.name}"`} size="sm">
      <div className="space-y-3">
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setMode("printer")} className={"flex-1 text-xs px-2 py-1 rounded border " + (mode === "printer" ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted")}>A printer</button>
          <button type="button" onClick={() => setMode("pool")} className={"flex-1 text-xs px-2 py-1 rounded border " + (mode === "pool" ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted")}>A pool</button>
        </div>
        {mode === "printer" ? (
          <>
            <label className="block">
              <span className={lbl}>Connection</span>
              <select value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setDeviceId(""); }} className={field}>
                <option value=""> - pick - </option>
                {connList.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={lbl}>Printer</span>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={!connectionId} className={field + " disabled:opacity-50"}>
                <option value="">{devices.isLoading ? "Loading…" : "— pick —"}</option>
                {deviceList.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
              </select>
            </label>
          </>
        ) : (
          <label className="block">
            <span className={lbl}>Pool</span>
            <select value={poolId} onChange={(e) => setPoolId(e.target.value)} className={field}>
              <option value=""> - pick - </option>
              {poolList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="text-[11px] text-faint">Drips onto the next free printer in the pool.</span>
          </label>
        )}
        <p className="text-[11px] text-faint">Bambu over the cloud can't accept an arbitrary file - send works on FDM Monster / OctoPrint / Klipper / edge-bridge machines (Bambu LAN later).</p>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600">Cancel</button>
          <button onClick={() => send.mutate()} disabled={!ready || send.isPending} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">{send.isPending ? "Sending…" : "Send"}</button>
        </div>
      </div>
    </Modal>
  );
}


/** Batch bar for selected fleet tiles — pause/resume/stop the selected running
 *  jobs, clear the selected finished beds. Each action shows only when at least
 *  one selected machine is eligible; one confirm per batch. */
// dropdown-click at a time was the pain). A searchable checklist popover.
function PoolMemberAdder({
  available,
  onAdd,
}: {
  available: { name: string; connLabel: string; connId: string; deviceId: string }[];
  onAdd: (keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = available.filter((d) => {
    const s = q.trim().toLowerCase();
    return !s || d.name.toLowerCase().includes(s) || d.connLabel.toLowerCase().includes(s);
  });
  const toggle = (key: string) =>
    setSel((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const commit = () => { if (sel.size) onAdd([...sel]); setSel(new Set()); setQ(""); setOpen(false); };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] border border-dashed border-line dark:border-slate-600 rounded bg-transparent px-1.5 py-0.5 text-faint hover:text-accent hover:border-accent"
      >
        + add machines…
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-64 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 shadow-lg p-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search machines…"
            className="w-full px-2 py-1 text-xs border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 mb-1.5"
          />
          <ul className="max-h-48 overflow-auto space-y-0.5">
            {filtered.length === 0 && <li className="text-[11px] text-faint italic px-1 py-1">No machines</li>}
            {filtered.map((d) => {
              const key = `${d.connId}:${d.deviceId}`;
              return (
                <li key={key}>
                  <label className="flex items-center gap-2 px-1 py-1 text-xs text-content dark:text-mortar-100 cursor-pointer hover:bg-subtle dark:hover:bg-slate-800 rounded">
                    <input type="checkbox" checked={sel.has(key)} onChange={() => toggle(key)} className="shrink-0" />
                    {/* The printer NAME gets priority; the connection it's on is
                        secondary — capped + truncated first so the name reads. */}
                    <span className="flex-1 min-w-0 truncate">{d.name}</span>
                    <span className="text-[10px] text-faint truncate shrink-0 max-w-[38%]" title={d.connLabel}>{d.connLabel}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between pt-1.5 mt-1 border-t border-line dark:border-slate-700">
            <span className="text-[10px] text-faint">{sel.size} selected</span>
            <button
              type="button"
              onClick={commit}
              disabled={!sel.size}
              className="text-[11px] rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-0.5 disabled:opacity-50"
            >
              Add{sel.size ? ` ${sel.size}` : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PoolsSection({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState("");

  const pools = useQuery({ queryKey: ["digifab-pools", slug], queryFn: () => api.listDigifabPools(slug), enabled: !!slug });
  const fleet = useQuery({ queryKey: ["digifab-fleet", slug], queryFn: () => api.getDigifabFleet(slug), enabled: !!slug });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["digifab-pools", slug] });

  // (connection:device) → { name, connLabel } for naming members + the picker.
  const deviceIndex = new Map<string, { name: string; connLabel: string; connId: string; deviceId: string }>();
  for (const c of fleet.data?.connections ?? []) {
    for (const d of c.devices) deviceIndex.set(`${c.connection_id}:${d.id}`, { name: d.name, connLabel: c.label, connId: c.connection_id, deviceId: d.id });
  }

  const create = useMutation({
    mutationFn: () => api.createDigifabPool(slug, name.trim()),
    onSuccess: () => { setName(""); toast.success("Pool created"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const addMember = useMutation({
    mutationFn: (v: { poolId: string; connId: string; deviceId: string }) =>
      api.addDigifabPoolMember(slug, v.poolId, v.connId, v.deviceId),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const removeMember = useMutation({
    mutationFn: (v: { poolId: string; connId: string; deviceId: string }) =>
      api.removeDigifabPoolMember(slug, v.poolId, v.connId, v.deviceId),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDigifabPool(slug, id),
    onSuccess: () => { toast.success("Pool removed"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const poolList = pools.data?.items ?? [];

  return (
    <section className="space-y-2 pt-2">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 border-b border-line dark:border-slate-700 pb-2">
        <Layers size={16} className="text-accent" />
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Pools</h2>
        <span className="text-[11px] text-faint">{poolList.length}</span>
        <div className="flex-1" />
        <form
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}
          className="flex items-center gap-1.5"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New pool name"
            className="px-2 py-1 text-xs border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 w-32 sm:w-40"
          />
          <button type="submit" disabled={!name.trim() || create.isPending} className="inline-flex items-center gap-1 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-1 text-xs disabled:opacity-50">
            <Plus size={12} /> Add
          </button>
        </form>
      </div>

      {poolList.length === 0 ? (
        <div className="text-[13px] text-muted dark:text-slate-400 italic">
          No pools. A pool is a set of machines you queue jobs onto - Cobblr drips each job onto the next free one. Great for running many printers as one farm.
        </div>
      ) : (
        <div className="space-y-2">
          {poolList.map((p) => {
            const memberKeys = new Set(p.members.map((m) => `${m.connection_id}:${m.remote_device_id}`));
            const available = [...deviceIndex.values()].filter((d) => !memberKeys.has(`${d.connId}:${d.deviceId}`));
            return (
              <div key={p.id} className="rounded-lg border border-line dark:border-slate-700 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-content dark:text-mortar-100">{p.name}</span>
                  <span className="text-[11px] text-faint">{p.members.length} machine{p.members.length === 1 ? "" : "s"}</span>
                  <div className="flex-1" />
                  <button
                    onClick={async () => {
                      const ok = await confirm({ title: `Remove pool "${p.name}"?`, message: "Jobs already assigned keep running; nothing is sent anywhere.", confirmLabel: "Remove", destructive: true });
                      if (ok) del.mutate(p.id);
                    }}
                    title="Remove pool"
                    className="text-faint hover:text-ember-500 transition p-1"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {p.members.map((m) => {
                    const info = deviceIndex.get(`${m.connection_id}:${m.remote_device_id}`);
                    return (
                      <span key={`${m.connection_id}:${m.remote_device_id}`} className="inline-flex items-center gap-1 rounded bg-subtle dark:bg-slate-800 px-2 py-0.5 text-[11px] text-content dark:text-mortar-200">
                        {info?.name ?? m.remote_device_id}
                        <button
                          onClick={() => removeMember.mutate({ poolId: p.id, connId: m.connection_id, deviceId: m.remote_device_id })}
                          className="text-faint hover:text-ember-500"
                          title="Remove from pool"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                  {available.length > 0 && (
                    <PoolMemberAdder
                      available={available}
                      onAdd={(keys) => {
                        for (const key of keys) {
                          const info = deviceIndex.get(key);
                          if (info) addMember.mutate({ poolId: p.id, connId: info.connId, deviceId: info.deviceId });
                        }
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Migrate an FDM Monster farm in. "Direct" recreates each printer as its own
// Cobblr connection (matching driver type per printer) and drops FDMM from the
// path; "mirror" keeps FDMM and just pools its printers.
function FdmmImportModal({ slug, onClose, onDone }: { slug: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"direct" | "mirror">("direct");
  const [poolName, setPoolName] = useState("Imported farm");

  const run = useMutation({
    mutationFn: () =>
      api.importDigifabFdmMonster(slug, { base_url: baseUrl.trim(), api_key: apiKey.trim() || undefined, mode, pool_name: poolName.trim() || "Imported farm" }),
    onSuccess: (r) => {
      toast.success(
        r.mode === "direct"
          ? `Imported ${r.created ?? 0} printer${r.created === 1 ? "" : "s"} as direct connections${r.skipped ? ` (${r.skipped} had no URL)` : ""} → pool "${r.pool_name}"`
          : `Mirrored ${r.mirrored ?? 0} printer${r.mirrored === 1 ? "" : "s"} → pool "${r.pool_name}" (FDM Monster kept)`,
      );
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  return (
    <Modal open onClose={onClose} title="Import from FDM Monster" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (baseUrl.trim()) run.mutate();
        }}
        className="space-y-3"
      >
        <p className="text-[13px] text-muted dark:text-slate-400">
          Point Cobblr at your FDM Monster and bring its printers in.
        </p>
        <label className="block">
          <span className={lbl}>FDM Monster URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://fdm-monster.local:4000" className={field} autoFocus />
        </label>
        <label className="block">
          <span className={lbl}>API key (optional)</span>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="fdmm_api_…" className={field} />
        </label>
        <fieldset className="space-y-1.5">
          <span className={lbl}>How</span>
          <label className="flex items-start gap-2 text-[13px] cursor-pointer">
            <input type="radio" checked={mode === "direct"} onChange={() => setMode("direct")} className="mt-0.5" />
            <span>
              <b className="text-content dark:text-mortar-100">Connect to each printer directly</b>  - recreate every printer as its own Cobblr
              connection (OctoPrint, Klipper, … matched per printer) and pool them. Drops FDM Monster from the path.
            </span>
          </label>
          <label className="flex items-start gap-2 text-[13px] cursor-pointer">
            <input type="radio" checked={mode === "mirror"} onChange={() => setMode("mirror")} className="mt-0.5" />
            <span>
              <b className="text-content dark:text-mortar-100">Keep FDM Monster, mirror its printers</b>  - add one FDM Monster connection and a
              Cobblr pool over its printers. FDM Monster still does the comms.
            </span>
          </label>
        </fieldset>
        <label className="block">
          <span className={lbl}>Pool name</span>
          <input value={poolName} onChange={(e) => setPoolName(e.target.value)} className={field} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
            Cancel
          </button>
          <button type="submit" disabled={run.isPending || !baseUrl.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {run.isPending ? "Importing…" : "Import"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The five printer/CNC firmwares digifab ships declarative drivers for (the
// catalog ids are stable). FDM Monster / mock are connection-managers, not a
// single printer's firmware, so they're not bulk-add targets.
const FIRMWARE_TYPES: { id: string; label: string }[] = [
  { id: "klipper-moonraker", label: "Klipper · Moonraker (Mainsail/Fluidd)" },
  { id: "octoprint", label: "OctoPrint" },
  { id: "prusalink", label: "PrusaLink" },
  { id: "duet-rrf", label: "Duet · RepRapFirmware" },
  { id: "fluidnc", label: "FluidNC (GRBL)" },
];
const firmwareLabel = (id: string) => FIRMWARE_TYPES.find((t) => t.id === id)?.label ?? id;

type BulkRow = { name?: string; url: string; apiKey?: string };

// Parse the paste box: one printer per line, `url` | `name, url` | `name, url, apikey`.
// Blank lines and `#` comments are skipped.
function parseBulk(text: string): BulkRow[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const parts = line.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length <= 1) return { url: parts[0] ?? line };
      return { name: parts[0], url: parts[1]!, apiKey: parts[2] };
    });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// Best-effort per-row firmware from the URL/port + printer name. A sensible
// starting guess when a printer can't be probed (offline, or a firmware with no
// network API to detect) — so three differently-named printers don't all inherit
// one wrong default. Always overridable via the per-row picker. `:7125` is
// Moonraker's default; the rest are name hints (Voron→Klipper, Prusa→PrusaLink…).
function guessFirmware(row: BulkRow): string | null {
  try { if (new URL(row.url).port === "7125") return "klipper-moonraker"; } catch { /* not a URL */ }
  const hay = `${row.name ?? ""} ${row.url}`.toLowerCase();
  if (/moonraker|mainsail|fluidd|klipper|voron|ratrig|trident/.test(hay)) return "klipper-moonraker";
  if (/prusalink|prusa|\bmk[234]s?\b|\bxl\b|\bmini\b/.test(hay)) return "prusalink";
  if (/octoprint|ender|creality|marlin/.test(hay)) return "octoprint";
  if (/duet|reprap|\brrf\b/.test(hay)) return "duet-rrf";
  if (/fluidnc|grbl/.test(hay)) return "fluidnc";
  return null;
}

// Stand up a NEW farm by pasting a list of printer URLs. One direct connection
// per printer (driver auto-installed), optional pool, optional per-row firmware
// auto-detect, optional reach test. Backed by POST …/digifab/bulk/connections.
function BulkAddModal({ slug, onClose, onDone }: { slug: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [defaultType, setDefaultType] = useState(FIRMWARE_TYPES[0]!.id);
  const [text, setText] = useState("");
  const [poolName, setPoolName] = useState("");
  const [testEach, setTestEach] = useState(true);
  const [detected, setDetected] = useState<Record<string, string | null>>({});
  const [detecting, setDetecting] = useState(false);
  // Explicit per-row firmware overrides, index-keyed (two rows can share a blank
  // URL). Effective firmware = user override › probe result › URL/name guess › default.
  const [rowTypes, setRowTypes] = useState<Record<number, string>>({});

  const rows = useMemo(() => parseBulk(text), [text]);
  const effectiveType = (r: BulkRow, i: number) => rowTypes[i] ?? detected[r.url] ?? guessFirmware(r) ?? defaultType;

  const detect = async () => {
    setDetecting(true);
    const next: Record<string, string | null> = {};
    for (const r of rows) {
      try {
        const res = await api.detectDigifabType(slug, { url: r.url, api_key: r.apiKey });
        next[r.url] = res.type;
      } catch {
        next[r.url] = null;
      }
    }
    setDetected(next);
    setDetecting(false);
    const hits = Object.values(next).filter(Boolean).length;
    toast[hits ? "success" : "info"](hits ? `Detected ${hits} of ${rows.length}` : "Couldn't detect any — using the default type");
  };

  const run = useMutation({
    mutationFn: () =>
      api.bulkAddDigifabConnections(slug, {
        default_type: defaultType,
        pool_name: poolName.trim() || undefined,
        test: testEach,
        printers: rows.map((r, i) => ({ name: r.name, url: r.url, api_key: r.apiKey, type: rowTypes[i] ?? detected[r.url] ?? guessFirmware(r) ?? undefined })),
      }),
    onSuccess: (r) => {
      const reach = r.results.filter((x) => x.reachable).length;
      toast[r.failed ? "info" : "success"](
        `Added ${r.created} printer${r.created === 1 ? "" : "s"}` +
          (testEach ? ` · ${reach} reachable` : "") +
          (r.pool_name ? ` → pool "${r.pool_name}"` : "") +
          (r.failed ? ` · ${r.failed} failed` : ""),
      );
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  return (
    <Modal open onClose={onClose} title="Add several printers" size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (rows.length) run.mutate();
        }}
        className="space-y-3"
      >
        <p className="text-[13px] text-muted dark:text-slate-400">
          Paste a list of printer URLs - Cobblr makes one direct connection per line and (optionally) groups them into a pool.
          For migrating an existing FDM Monster farm, use <b>Import farm</b> instead.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={lbl}>Default firmware</span>
            <select value={defaultType} onChange={(e) => setDefaultType(e.target.value)} className={field}>
              {FIRMWARE_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={lbl}>Pool name (optional)</span>
            <input value={poolName} onChange={(e) => setPoolName(e.target.value)} placeholder="Print farm" className={field} />
          </label>
        </div>
        <label className="block">
          <span className={lbl}>Printers - one per line</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={"http://voron.local:7125\nMK4, http://192.168.1.40, prusa_api_key\n# url  |  name, url  |  name, url, apikey"}
            className={field + " font-mono text-xs"}
            autoFocus
          />
        </label>

        {rows.length > 0 && (
          <div className="border border-line dark:border-slate-700 rounded">
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-line dark:border-slate-800">
              <span className="text-[11px] font-mono uppercase tracking-widest text-faint">{rows.length} printer{rows.length === 1 ? "" : "s"}</span>
              <button
                type="button"
                onClick={detect}
                disabled={detecting}
                className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline disabled:opacity-50"
                title="Probe each URL to guess its firmware"
              >
                {detecting ? <RefreshCw size={12} className="animate-spin" /> : <Wifi size={12} />} Detect firmware
              </button>
            </div>
            <ul className="max-h-44 overflow-auto divide-y divide-line dark:divide-slate-800">
              {rows.map((r, i) => {
                const det = detected[r.url];
                return (
                  <li key={i} className="px-2.5 py-1.5 flex items-center gap-2 text-[13px]">
                    <Printer size={13} className="text-faint shrink-0" />
                    <span className="font-medium text-content dark:text-mortar-100 truncate">{(r.name || hostOf(r.url)).trim()}</span>
                    <span className="text-[11px] font-mono text-faint truncate flex-1">{r.url}</span>
                    {det ? <span className="text-[11px] text-moss-600 dark:text-moss-400 shrink-0" title="firmware detected by probe">✓</span> : null}
                    <select
                      value={effectiveType(r, i)}
                      onChange={(e) => setRowTypes((m) => ({ ...m, [i]: e.target.value }))}
                      className="text-[11px] py-0.5 pl-1.5 pr-5 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 shrink-0 max-w-[200px]"
                      title={det ? "detected by probe — change to override" : rowTypes[i] ? "your choice" : "guessed from the name/URL — change if wrong"}
                    >
                      {FIRMWARE_TYPES.map((t) => (
                        <option key={t.id} value={t.id}>{firmwareLabel(t.id)}</option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <label className="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" checked={testEach} onChange={(e) => setTestEach(e.target.checked)} />
          <span>Test each printer after adding</span>
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
            Cancel
          </button>
          <button type="submit" disabled={run.isPending || rows.length === 0} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {run.isPending ? "Adding…" : `Add ${rows.length || ""} printer${rows.length === 1 ? "" : "s"}`.trim()}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Production runs — "make N of these, stop when done" on a pool. The run
// mints ordinary pool jobs to the over-dispatch ceiling; the bed-clear verdict
// is what counts a plate (good counts, scrapped auto-replaces). ──
function ProductionRunsSection({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [poolId, setPoolId] = useState("");
  const [fileId, setFileId] = useState("");
  const [target, setTarget] = useState(10);
  const [ppp, setPpp] = useState(1);

  const runs = useQuery({
    queryKey: ["digifab-runs", slug],
    queryFn: () => api.listDigifabRuns(slug),
    enabled: !!slug,
    refetchInterval: 10_000,
  });
  const pools = useQuery({
    queryKey: ["digifab-pools", slug],
    queryFn: () => api.listDigifabPools(slug),
    enabled: !!slug && open,
  });
  const library = useQuery({
    queryKey: ["digifab-library", slug],
    queryFn: () => api.listDigifabLibrary(slug),
    enabled: !!slug && open,
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["digifab-runs", slug] });
  const create = useMutation({
    mutationFn: () =>
      api.createDigifabRun(slug, {
        name: name.trim(),
        pool_id: poolId,
        file_id: fileId,
        parts_per_plate: ppp,
        target_qty: target,
      }),
    onSuccess: () => {
      toast.success("Run started - plates are queueing onto the pool.");
      setOpen(false);
      setName("");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't create the run"),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: { status?: "active" | "paused" | "cancelled" } }) => api.patchDigifabRun(slug, v.id, v.body),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't update the run"),
  });

  const items = runs.data?.items ?? [];
  const active = items.filter((r) => r.status === "active" || r.status === "paused");
  const done = items.filter((r) => r.status === "completed" || r.status === "cancelled").slice(0, 5);
  if (!items.length && !open) {
    return (
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-center gap-3">
        <Layers size={16} className="text-accent shrink-0" />
        <div className="flex-1 text-sm text-muted dark:text-slate-400">
          <span className="font-medium text-content dark:text-mortar-100">Production runs</span>  - "make 250 of these,
          stop when done." Pick a pool, a plate file, and a target; the farm does the rest.
        </div>
        <button onClick={() => setOpen(true)} className="shrink-0 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition">
          New run
        </button>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Layers size={16} className="text-accent" />
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex-1">Production runs</h2>
        <button onClick={() => setOpen(true)} className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-xs transition">
          New run
        </button>
      </div>

      {active.length === 0 && <p className="text-sm text-faint dark:text-slate-400">No active runs.</p>}
      <ul className="space-y-2">
        {active.map((r) => (
          <RunRow key={r.id} run={r} onPatch={(body) => patch.mutate({ id: r.id, body })} confirm={confirm} />
        ))}
      </ul>
      {done.length > 0 && (
        <details className="text-xs text-muted dark:text-slate-400">
          <summary className="cursor-pointer">Recently finished ({done.length})</summary>
          <ul className="mt-2 space-y-1">
            {done.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="font-medium text-content dark:text-mortar-200">{r.name}</span>
                <span>{r.completed_qty}/{r.target_qty}</span>
                <span className="uppercase text-[10px] font-mono">{r.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New production run">
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-muted dark:text-slate-400">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bracket run - July"
              className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs text-muted dark:text-slate-400">Pool</span>
            <select value={poolId} onChange={(e) => setPoolId(e.target.value)}
              className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5">
              <option value="">Pick a pool…</option>
              {(pools.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted dark:text-slate-400">Plate file (library)</span>
            <select
              value={fileId}
              onChange={(e) => {
                setFileId(e.target.value);
                // Prefill parts-per-plate from the file's slicer metadata (the
                // `Nx …` filename convention) — editable, just a head start.
                const item = (library.data?.items ?? []).find((f) => f.file_id === e.target.value);
                if (item?.metadata?.parts_per_plate) setPpp(item.metadata.parts_per_plate);
              }}
              className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5">
              <option value="">Pick a file…</option>
              {(library.data?.items ?? []).map((f) => (
                <option key={f.id} value={f.file_id}>{f.name}</option>
              ))}
            </select>
            {(() => {
              const item = (library.data?.items ?? []).find((f) => f.file_id === fileId);
              const md = item?.metadata;
              if (!md || (!md.material && !md.estimated_sec)) return null;
              const t = md.estimated_sec ? `${Math.floor(md.estimated_sec / 3600)}h ${Math.round((md.estimated_sec % 3600) / 60)}m` : null;
              return (
                <span className="mt-1 block text-[11px] text-faint dark:text-slate-500">
                  {[md.material, t ? `~${t}/plate` : null, md.parts_per_plate ? `${md.parts_per_plate} parts/plate` : null].filter(Boolean).join(" · ")}
                </span>
              );
            })()}
          </label>
          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="text-xs text-muted dark:text-slate-400">Target quantity</span>
              <input type="number" min={1} value={target} onChange={(e) => setTarget(Math.max(1, Number(e.target.value)))}
                className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5" />
            </label>
            <label className="block flex-1">
              <span className="text-xs text-muted dark:text-slate-400">Parts per plate</span>
              <input type="number" min={1} value={ppp} onChange={(e) => setPpp(Math.max(1, Number(e.target.value)))}
                className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5" />
            </label>
          </div>
          <p className="text-xs text-faint dark:text-slate-500">
            {Math.ceil(target / Math.max(1, ppp))} plate{Math.ceil(target / Math.max(1, ppp)) === 1 ? "" : "s"} will be
            printed. A plate only counts when you clear the bed with a <em>good</em> verdict - scrapped plates are
            reprinted automatically.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setOpen(false)} className="rounded border border-line dark:border-slate-600 px-3 py-1.5 text-sm">Cancel</button>
            <button
              disabled={!name.trim() || !poolId || !fileId || create.isPending}
              onClick={() => create.mutate()}
              className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm transition"
            >
              {create.isPending ? "Starting…" : "Start run"}
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

function RunRow({
  run,
  onPatch,
  confirm,
}: {
  run: DigifabRun;
  onPatch: (body: { status?: "active" | "paused" | "cancelled" }) => void;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const pct = Math.min(100, Math.round((run.completed_qty / Math.max(1, run.target_qty)) * 100));
  return (
    <li className="rounded-lg border border-line dark:border-slate-800 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-content dark:text-mortar-100">{run.name}</span>
        {run.status === "paused" && (
          <span className="text-[10px] font-mono uppercase rounded-full px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">paused</span>
        )}
        <span className="text-xs text-muted dark:text-slate-400 flex-1 truncate">{run.file_ref}</span>
        <span className="text-xs font-mono text-content dark:text-mortar-200">{run.completed_qty}/{run.target_qty}</span>
      </div>
      <div className="mt-1.5 h-1.5 rounded bg-subtle dark:bg-slate-800 overflow-hidden">
        <div className="h-full bg-cobble-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint dark:text-slate-500">
        <span>{run.jobs_printing} printing</span>
        <span>{run.jobs_queued} queued</span>
        {run.jobs_awaiting_verdict > 0 && <span className="text-amber-600 dark:text-amber-400">{run.jobs_awaiting_verdict} awaiting verdict</span>}
        {run.jobs_scrapped > 0 && <span>{run.jobs_scrapped} scrapped</span>}
        <span className="flex-1" />
        {run.status === "active" ? (
          <button onClick={() => onPatch({ status: "paused" })} className="text-muted hover:text-accent">Pause</button>
        ) : (
          <button onClick={() => onPatch({ status: "active" })} className="text-muted hover:text-accent">Resume</button>
        )}
        <button
          onClick={() => {
            void confirm({
              title: "Cancel this run?",
              message: `"${run.name}" is at ${run.completed_qty}/${run.target_qty}. Queued plates are cancelled; anything printing finishes normally.`,
              confirmLabel: "Cancel run",
              destructive: true,
            }).then((ok) => ok && onPatch({ status: "cancelled" }));
          }}
          className="text-muted hover:text-red-500"
        >
          Cancel
        </button>
      </div>
    </li>
  );
}

