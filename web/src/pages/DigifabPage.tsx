// /configuration/digifab — Digital Fabrication. Manage connections to the
// software that runs your machines (FDM Monster, OctoPrint, …): add one,
// test it, list its printers, link printers to machines, and run the job
// queue. Sending a file to be made is a deliberate action — the Send
// button is behind an explicit confirm. We send files, never drive hardware.

import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wifi, Printer, RefreshCw, Send, ListChecks, Boxes, AlertTriangle, Layers, X, ListPlus, Ban, Camera, Pause, Play, Thermometer, ChevronRight, Share2, Sliders } from "lucide-react";
import { ApiError, api, fetchAuthBlobUrl, type DigifabConnection, type DigifabJob, type DigifabFleetDevice, type DigifabDeviceClass, type BambuMode, type DigifabLibraryItem, type DigifabHistory, type DigifabDeviceDetail, type DigifabFileInfo } from "../lib/api";
import { BambuConnectWizard } from "../components/BambuConnectWizard";
import { BridgePicker } from "../components/BridgePicker";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { PrintUpdatesPanel } from "./PrintUpdatesPanel";
import { Modal, useToast, useConfirm, usePageTitle, useImageSrc } from "@cobblr/platform-web";
import { Combobox } from "../components/Combobox";

export function DigifabPage() {
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
  const [tab, setTab] = useState<"floor" | "setup">(() => (localStorage.getItem("cobblr.digifab.tab") === "setup" ? "setup" : "floor"));
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
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Digital Fabrication</h1>
        <span className="text-sm text-muted dark:text-slate-400">{items.length} connection{items.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
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
      </div>

      {/* ── FLOOR — the operate surface: what runs, what's queued, what to print. ── */}
      {tab === "floor" && (
        <>
          {items.length === 0 && !list.isLoading && (
            <div className="max-w-lg rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center">
              <Printer size={26} className="mx-auto text-faint mb-3" />
              <p className="text-sm text-content dark:text-mortar-100 font-medium mb-1">No machines connected yet</p>
              <p className="text-sm text-muted dark:text-slate-400 mb-4">
                Point Cobblr at the software that runs your machines — FDM Monster, OctoPrint, Bambu, a LAN bridge.
              </p>
              <button onClick={() => pickTab("setup")} className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-4 py-2 text-sm transition">
                <Plus size={15} /> Open Setup
              </button>
            </div>
          )}
          {(list.isLoading || items.length > 0) && <FleetView slug={activeSlug} />}
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
          Connect to the software that runs your machines — FDM Monster, OctoPrint, and friends — then group them into pools
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
          <input value={label} onChange={(e) => { setLabel(e.target.value); setLink(null); }} placeholder="e.g. a beta tester's club" className={field} autoFocus />
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
              { id: "write", title: "Read + write", note: "Full control — send, pause, cancel prints on your machines." },
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
            <div className="text-[10px] font-mono uppercase tracking-widest text-moss-700 dark:text-moss-400">Share link — copy it now, shown once</div>
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
        install a common one in a click from the catalog below, or paste a custom manifest — no
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
        <div className="text-[13px] text-muted italic mb-4">None yet — paste a manifest below.</div>
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
  failed: "text-ember-600 bg-ember-50 dark:bg-ember-950/40",
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
const isReprintable = (r: { id: string }) => !r.id.startsWith("task:");

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
      message: "Clones the original job — same file, routing, material and build — and sends it to the printer. On a live farm this physically starts the print.",
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
              {(hist.data?.by_device.length ?? 0) > 0 && (
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">By printer</div>
                  <ul className="text-xs space-y-0.5">
                    {hist.data!.by_device.map((d, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-100">{d.name}</span>
                        <span className="text-faint shrink-0">{d.completed}/{d.total} ok{d.failed ? ` · ${d.failed} failed` : ""}{d.filament_g ? ` · ${Math.round(d.filament_g)}g` : ""}</span>
                      </li>
                    ))}
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
      message: "Removes the queued ones and tells running ones to stop where supported. On a live farm a printer may keep going — stop it at the machine.",
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
                  title="Retry — re-queue and send again"
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
    return <div className="text-[13px] text-muted dark:text-slate-400 italic">Nothing running or queued — the timeline fills in as you queue jobs.</div>;
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
              placeholder="— pick a pool —"
            />
            <span className="text-[11px] text-faint">Queues unassigned — Cobblr drips it onto the next free machine in the pool.</span>
          </label>
        )}
        {routeBy === "machine" && (
          <label className="block">
            <span className={lbl}>Machine</span>
            <Combobox
              value={machineId}
              onChange={setMachineId}
              options={machineList.map((m) => ({ value: m.id, label: m.instLabel ? `${m.name} · ${m.instLabel}` : m.name }))}
              placeholder="— pick a machine —"
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
              placeholder="— pick a printer —"
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
            placeholder="— routing-only (no upload) —"
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
              placeholder="— don't track material —"
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
          <span className="text-[11px] text-faint">When the print completes, this many grams is deducted from that spool's stock.</span>
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
              placeholder="— don't make a build —"
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

export function CreateConnectionModal({
  types,
  onClose,
  onCreated,
  presetType,
  presetName,
  presetDriver,
}: {
  types: string[];
  onClose: () => void;
  /** Receives the new connection's id (when known) so the caller can auto-select it. */
  onCreated: (connectionId?: string) => void;
  /** Pre-select the connection TYPE (e.g. "edge_adapter" when launched from a
   *  printer, so the user skips the type pick). */
  presetType?: string;
  /** Pre-fill the first machine's name (carry the printer's name over). */
  presetName?: string;
  /** Pre-select the first machine's driver (e.g. "moonraker"). */
  presetDriver?: string;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [type, setType] = useState(presetType ?? types[0] ?? "fdm_monster");
  // For a Bambu, the user chooses HOW it connects: cloud account (monitor) or LAN
  // via the edge bridge (full control). They're different connection shapes.
  const [bambuWay, setBambuWay] = useState<"cloud" | "lan">("cloud");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authMode, setAuthMode] = useState<"api_key" | "login">("api_key");
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.createDigifabConnection(activeSlug, {
        type,
        label: label.trim(),
        base_url: baseUrl.trim(),
        ...(type === "mock"
          ? {}
          : authMode === "api_key"
            ? { api_key: apiKey.trim() || undefined }
            : { username: username.trim() || undefined, password: password || undefined }),
      }),
    onSuccess: (conn) => {
      toast.success("Connection added");
      onCreated((conn as { id?: string } | undefined)?.id);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

  return (
    <Modal open onClose={onClose} title="Add a connection" size="md">
      <div className="space-y-3">
        <label className="block">
          <span className={lbl}>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {types.map((t) => (
              <option key={t} value={t}>{t === "fdm_monster" ? "FDM Monster" : t === "mock" ? "Mock (test)" : t === "bambu" ? "Bambu Lab" : t === "edge_adapter" ? "Edge adapter (your bridge)" : t}</option>
            ))}
          </select>
        </label>
        {type === "bambu" ? (
          <div className="space-y-3">
            {/* How a Bambu connects — the two genuinely different paths. */}
            <div className="grid grid-cols-2 gap-2">
              {([
                { id: "cloud", title: "Cloud account", note: "Bambu login. Live status, temps, chamber light + pause/resume/stop. Add per-printer LAN later for full control & camera." },
                { id: "lan", title: "LAN via edge bridge", note: "Developer Mode + your bridge. Full control: send, pause, cancel, jog, camera." },
              ] as const).map((o) => (
                <button key={o.id} type="button" onClick={() => setBambuWay(o.id)}
                  className={"text-left rounded border p-2 transition " + (bambuWay === o.id ? "border-cobble-500 bg-cobble-50/40 dark:bg-cobble-900/20" : "border-line dark:border-slate-600 hover:border-accent")}>
                  <div className="text-xs font-medium text-content dark:text-mortar-100">{o.title}</div>
                  <div className="text-[10px] text-muted dark:text-slate-400 mt-0.5 leading-snug">{o.note}</div>
                </button>
              ))}
            </div>
            {bambuWay === "cloud"
              ? <BambuConnectWizard onConnected={() => onCreated()} onCancel={onClose} />
              : <EdgeBridgeSetup presetDriver="bambu" onCreated={onCreated} onClose={onClose} />}
          </div>
        ) : type === "edge_adapter" ? (
          <EdgeBridgeSetup onCreated={onCreated} onClose={onClose} presetName={presetName} presetDriver={presetDriver} />
        ) : (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className={lbl}>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main FDM farm" className={field} autoFocus />
        </label>
        <label className="block">
          <span className={lbl}>Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://farm.local:4000" className={field} />
        </label>
        {type !== "mock" && (
          <>
            <div className="flex gap-2 text-xs">
              {(["api_key", "login"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAuthMode(m)}
                  className={"px-2 py-1 rounded border transition " + (authMode === m ? "border-cobble-500 text-accent" : "border-line dark:border-slate-600 text-muted")}
                >
                  {m === "api_key" ? "API key" : "Username + password"}
                </button>
              ))}
            </div>
            {authMode === "api_key" ? (
              <label className="block">
                <span className={lbl}>API key</span>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="fdmm_api_…" className={field} />
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={lbl}>Username</span>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
                </label>
                <label className="block">
                  <span className={lbl}>Password</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
                </label>
              </div>
            )}
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={save.isPending || !label.trim() || !baseUrl.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {save.isPending ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
        )}
      </div>
    </Modal>
  );
}

// Guided edge-bridge setup. A hosted Cobblr can't reach a machine on your LAN —
// so you run a tiny bridge at your site that dials OUT and holds a tunnel open.
// This shows the one command to run it, watches for it to dial in, then creates
// the cobblr-edge:// connection that routes through the tunnel.
// What the bridge can drive + the fields each needs. Mirrors the bridge's
// built-in drivers (mock/moonraker/prusalink/duet/bambu/lightburn).
const BRIDGE_DRIVERS: { key: string; label: string; fields: { key: string; label: string; placeholder?: string; optional?: boolean }[] }[] = [
  { key: "mock", label: "Mock (test — no hardware)", fields: [] },
  { key: "moonraker", label: "Klipper (Moonraker)", fields: [{ key: "host", label: "Printer IP / host", placeholder: "192.168.1.50" }, { key: "apiKey", label: "API key (only if locked down)", optional: true }] },
  { key: "prusalink", label: "Prusa (PrusaLink)", fields: [{ key: "host", label: "Printer IP / host", placeholder: "192.168.1.213" }, { key: "apiKey", label: "PrusaLink API key" }] },
  { key: "duet", label: "Duet (RepRapFirmware)", fields: [{ key: "host", label: "Printer IP / host", placeholder: "192.168.1.50" }] },
  { key: "bambu", label: "Bambu Lab (LAN)", fields: [{ key: "host", label: "Printer IP" }, { key: "serial", label: "Serial" }, { key: "accessCode", label: "LAN access code" }] },
  { key: "lightburn", label: "LightBurn laser", fields: [{ key: "host", label: "IP of the PC running LightBurn" }] },
];

type MachineDraft = { key: string; name: string; driver: string; cfg: Record<string, string> };
let machineSeq = 0;
const newMachine = (driver = "mock"): MachineDraft => ({ key: `m${++machineSeq}`, name: "", driver, cfg: {} });
const defOf = (m: MachineDraft) => BRIDGE_DRIVERS.find((d) => d.key === m.driver) ?? BRIDGE_DRIVERS[0]!;

export function EdgeBridgeSetup({ onCreated, onClose, presetDriver, presetName }: { onCreated: (connectionId?: string) => void; onClose: () => void; presetDriver?: string; presetName?: string }) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [label, setLabel] = useState("Edge bridge");
  const [bridgeId, setBridgeId] = useState("");
  const [machines, setMachines] = useState<MachineDraft[]>(() => {
    const m = newMachine(presetDriver && BRIDGE_DRIVERS.some((d) => d.key === presetDriver) ? presetDriver : "mock");
    if (presetName?.trim()) m.name = presetName.trim(); // carry the name from the New-printer form
    return [m];
  });
  const [token, setToken] = useState<string | null>(null);
  const [cmdMode, setCmdMode] = useState<"run" | "compose">("compose");
  const bid = bridgeId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  // Name the bridge the status box is reporting on — you may run several, so
  // "your bridge is online" is ambiguous. Blank → the default/main bridge.
  const bridgeLabel = bid ? `the "${bid}" bridge` : "your main bridge";
  // The canonical kernel wire (bridges installed pre-move keep polling the
  // /modules/digifab/edge alias — both land on the same channel).
  const relayUrl = `${window.location.origin}/api/v1/orgs/${activeSlug}/edge`;
  const status = useQuery({
    queryKey: ["digifab-edge-status", activeSlug, bid],
    queryFn: () => api.getDigifabEdgeStatus(activeSlug, bid || undefined),
    enabled: !!activeSlug,
    refetchInterval: 3000,
  });
  const connected = !!status.data?.connected;

  const updateMachine = (key: string, patch: Partial<MachineDraft>) => setMachines((ms) => ms.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  const setField = (key: string, fk: string, v: string) => setMachines((ms) => ms.map((m) => (m.key === key ? { ...m, cfg: { ...m.cfg, [fk]: v } } : m)));

  // Unique instance ids (matched by the per-machine connection's cobblr-edge://<id>).
  const withIds = (() => {
    const seen = new Map<string, number>();
    return machines.map((m, i) => {
      let id = (m.name.trim() || m.driver).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `m${i + 1}`;
      const n = seen.get(id) ?? 0; seen.set(id, n + 1); if (n) id = `${id}-${n + 1}`;
      return { m, id };
    });
  })();
  const missing = machines.flatMap((m) => defOf(m).fields.filter((f) => !f.optional && !m.cfg[f.key]?.trim()).map((f) => `${m.name.trim() || defOf(m).label}: ${f.label}`));

  const mint = useMutation({
    mutationFn: () => api.createApiToken({ name: `Edge bridge: ${label.trim() || "bridge"}`, scopes: ["devices:edge"] }),
    onSuccess: (r) => setToken(r.token),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't generate a token."),
  });
  // The command carries NOTHING machine-specific — just the relay token. The
  // bridge installs once and stays open; machines are added below and ride down
  // the tunnel per request (dynamic config), so the box never needs re-running.
  const tok = token ?? "<generate the token first>";
  // Registry-free bootstrap: a stock public node image fetches the bridge CODE
  // from this Cobblr (loader → sha-verified bundle) with the tunnel token, and
  // self-updates by restarting onto new versions. No private registry.
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
  // One connection per machine — base_url cobblr-edge://<id> + the machine config
  // stored on it (rides the tunnel). The first id is returned to link the printer.
  const create = useMutation({
    mutationFn: async () => {
      let firstId: string | undefined;
      for (const { m, id } of withIds) {
        const config = { driver: m.driver, ...(bid ? { bridge: bid } : {}), ...Object.fromEntries(defOf(m).fields.map((f) => [f.key, m.cfg[f.key]?.trim()]).filter(([, v]) => v)) };
        const c = await api.createDigifabConnection(activeSlug, { type: "edge_adapter", label: m.name.trim() || defOf(m).label, base_url: `cobblr-edge://${id}`, config });
        if (!firstId) firstId = c.id;
      }
      return firstId;
    },
    onSuccess: (firstId) => { toast.success(machines.length > 1 ? `${machines.length} machines connected.` : "Machine connected."); onCreated(firstId); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add the connection(s)."),
  });
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  return (
    <div className="space-y-3">
      {/* Multi-bridge: a SECOND bridge at another site (or LightBurn, which must
          run its own bridge on the LightBurn PC) gets a distinct id so it has its
          own channel instead of colliding with the main bridge. Above the
          already-connected check so you can add a 2nd bridge even when the main
          one's online — typing an id flips the view to that bridge's install. */}
      <label className="block">
        <span className={lbl}>Bridge <span className="normal-case text-faint/70">— pick a connected one, or type an id you're about to install</span></span>
        <BridgePicker slug={activeSlug} value={bridgeId.trim() ? bridgeId : null} onChange={(v) => setBridgeId(v ?? "")} />
        <span className="text-[11px] text-faint mt-1 block">
          {bid
            ? <>Talking to <code>{bid}</code> — this must match that bridge's <code>BRIDGE_ID</code>. A 2nd+ bridge (another site, or LightBurn's PC) <strong>must</strong> be named so it gets its own channel.</>
            : <>Blank = your <strong>main</strong> bridge (installed without a <code>BRIDGE_ID</code>). If you gave even your first bridge an id, type it here. Extra bridges always need a name.</>}
        </span>
      </label>
      {/* If THIS bridge is already dialed in, skip the install flow — just add a
          machine to it. (Keyed to the bridge id above.) */}
      {connected ? (
        <div className="flex items-center gap-2 text-sm rounded border border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 p-2">
          <span className="w-2 h-2 rounded-full bg-moss-500 shrink-0" />
          <span className="text-moss-700 dark:text-moss-300">{bid ? <><code>{bid}</code></> : "Your main bridge"} is online ✓ — add a machine to it below. No reinstall needed.</span>
        </div>
      ) : (<>
      <p className="text-[13px] text-muted dark:text-slate-400">
        A hosted Cobblr can't reach a machine on your network directly. Run one tiny <strong>bridge</strong> on
        any always-on box at your site (Pi, NAS, mini-PC) — it dials out and holds a tunnel open (no inbound
        firewall hole). Install it once; <strong>add every machine at your site</strong> to it, anytime.
      </p>
      {/* STEP 1 — install the bridge (name + token; no machines needed yet). */}
      <label className="block">
        <span className={lbl}>1 · Name this bridge</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={field} autoFocus />
      </label>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className={lbl}>2 · Install the bridge</span>
          {token && (
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden text-[10px]">
                {(["run", "compose"] as const).map((mode) => (
                  <button key={mode} type="button" onClick={() => setCmdMode(mode)} className={"px-1.5 py-0.5 " + (cmdMode === mode ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}>
                    {mode === "run" ? "docker run" : "compose"}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(snippet); toast.success("Copied"); }} className="text-[10px] text-accent hover:underline">Copy</button>
            </div>
          )}
        </div>
        {!token ? (
          <button type="button" onClick={() => mint.mutate()} disabled={mint.isPending || !label.trim()}
            className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5">
            {mint.isPending ? "Generating…" : "Generate token & command"}
          </button>
        ) : (
          <>
            <pre className="text-[11px] leading-relaxed bg-subtle dark:bg-slate-950 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto whitespace-pre text-content dark:text-mortar-200">{snippet}</pre>
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">Run this on a box at your site. Token shown once — it can <strong>only</strong> run this bridge (scope <code>devices:edge</code>).</p>
            <p className="text-[11px] text-faint mt-0.5">Stock public image — the bridge fetches its code from this Cobblr (sha-verified) and keeps itself updated automatically. Nothing to pull from a registry, ever.</p>
          </>
        )}
      </div>
      <div>
        <span className={lbl}>3 · Cobblr is watching for it</span>
        <div className={"flex items-center gap-2 text-sm rounded border p-2 " + (connected ? "border-moss-500/40 bg-moss-50 dark:bg-moss-950/30" : "border-line dark:border-slate-700")}>
          <span className={"w-2 h-2 rounded-full " + (connected ? "bg-moss-500" : "bg-amber-500 animate-pulse")} />
          {connected ? <span className="text-moss-700 dark:text-moss-300">{bid ? <><code>{bid}</code> online</> : "Main bridge online"} — dialed in ✓</span> : <span className="text-muted dark:text-slate-400">Waiting for {bridgeLabel} to dial in…</span>}
        </div>
      </div>
      </>)}
      {/* Add machines to the bridge (the only step once it's online). */}
      <div className="space-y-2 pt-1 border-t border-line dark:border-slate-800">
        <span className={lbl}>{connected ? "Add a machine" : "4 · Machines on this bridge"}</span>
        {machines.map((m, i) => {
          const def = defOf(m);
          return (
            <div key={m.key} className="rounded border border-line dark:border-slate-700 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-faint">{i === 0 ? "First machine" : `Machine ${i + 1}`}</span>
                <div className="flex-1" />
                {machines.length > 1 && (
                  <button type="button" onClick={() => setMachines((ms) => ms.filter((x) => x.key !== m.key))} title="Remove machine" className="text-faint hover:text-ember-500 transition">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={lbl}>Name</span>
                  <input value={m.name} onChange={(e) => updateMachine(m.key, { name: e.target.value })} placeholder={def.label} className={field} />
                </label>
                <label className="block">
                  <span className={lbl}>Type</span>
                  <select value={m.driver} onChange={(e) => updateMachine(m.key, { driver: e.target.value, cfg: {} })} className={field}>
                    {BRIDGE_DRIVERS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
                {def.fields.map((f) => (
                  <label key={f.key} className="block">
                    <span className={lbl}>{f.label}{f.optional ? "" : " *"}</span>
                    <input value={m.cfg[f.key] ?? ""} onChange={(e) => setField(m.key, f.key, e.target.value)} placeholder={f.placeholder} className={field} />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        <button type="button" onClick={() => setMachines((ms) => [...ms, newMachine()])} className="text-xs text-accent hover:underline">+ Add another machine</button>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
        <button type="button" onClick={() => create.mutate()} disabled={create.isPending || !connected || missing.length > 0}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          title={!connected ? "Start the bridge first" : missing.length ? `Fill in: ${missing.join(", ")}` : ""}>
          {create.isPending ? "Adding…" : machines.length > 1 ? `Add ${machines.length} machines` : "Add this machine"}
        </button>
      </div>
    </div>
  );
}

// The connection's printers, rendered INLINE as a children list (expanded under
// the connection row) — not a modal. Lists each farm printer + a link-to-machine
// picker so a job linked to that machine routes to its printer automatically.
// Machines live in INSTANCES — a workspace's printers are usually under a
// "3D Printers" instance, lasers under "Laser cutters", etc., not the default
// collection. So a link/route picker that reads only the default finds nothing
// ("no matches"). This gathers machines across EVERY instance of the machines
// module (+ the default), tagging each with its instance for clarity.
type LinkableMachine = { id: string; name: string; instLabel: string | null; image: string | null };
async function fetchAllMachines(slug: string): Promise<{ items: LinkableMachine[] }> {
  let insts: { instance_name: string; display_name: string; is_default: boolean }[] = [];
  try {
    insts = (await api.listInstances(slug, "machines")).items.map((i) => ({ instance_name: i.instance_name, display_name: i.display_name, is_default: i.is_default }));
  } catch {
    /* module may be single-instance — fall back to the default collection */
  }
  const sources: { name: string | undefined; label: string | null }[] = insts.length
    ? insts.map((i) => ({ name: i.is_default ? undefined : i.instance_name, label: i.is_default ? null : i.display_name }))
    : [{ name: undefined, label: null }];
  const lists = await Promise.all(
    sources.map((s) =>
      api.listMachines(slug, s.name).then((r) => r.items.map((m) => ({ id: m.id, name: m.name, instLabel: s.label, image: m.image_path ?? null }))).catch(() => [] as LinkableMachine[]),
    ),
  );
  const seen = new Set<string>();
  const items: LinkableMachine[] = [];
  for (const m of lists.flat()) if (!seen.has(m.id)) { seen.add(m.id); items.push(m); }
  return { items };
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
      {printers.isError && <div className="text-xs text-ember-500 py-1">Couldn't reach the farm — test the connection.</div>}
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
                placeholder="— link to machine —"
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
        Link a farm printer to one of your machines — a job linked to that machine then routes to its printer automatically.
      </p>
    </div>
  );
}

// ── Fleet view ────────────────────────────────────────────────────────────
// The live floor: every connection's machines + their state, with Cobblr's
// in-flight jobs overlaid. Polls every 12s. Coordinate-not-control — this only
// reads what each manager reports; it never drives hardware.

const KLASS_STYLE: Record<DigifabDeviceClass, { dot: string; text: string; ring: string }> = {
  printing: { dot: "bg-cobble-500", text: "text-cobble-700 dark:text-cobble-300", ring: "border-cobble-300 dark:border-cobble-700" },
  idle: { dot: "bg-moss-500", text: "text-moss-700 dark:text-moss-400", ring: "border-line dark:border-slate-700" },
  paused: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", ring: "border-amber-300 dark:border-amber-800" },
  complete: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", ring: "border-amber-300 dark:border-amber-800" },
  error: { dot: "bg-ember-500", text: "text-ember-600 dark:text-ember-500", ring: "border-ember-300 dark:border-ember-800" },
  offline: { dot: "bg-faint", text: "text-faint", ring: "border-line dark:border-slate-700" },
  unknown: { dot: "bg-faint", text: "text-muted", ring: "border-line dark:border-slate-700" },
};

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
        <div className="text-xs text-muted dark:text-slate-400 italic">No files yet. Upload a .3mf or .gcode — Cobblr pulls out the slicer's plate preview, and you can send it to any machine.</div>
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
                <option value="">— pick —</option>
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
              <option value="">— pick —</option>
              {poolList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="text-[11px] text-faint">Drips onto the next free printer in the pool.</span>
          </label>
        )}
        <p className="text-[11px] text-faint">Bambu over the cloud can't accept an arbitrary file — send works on FDM Monster / OctoPrint / Klipper / edge-bridge machines (Bambu LAN later).</p>
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
function FleetBatchBar({
  slug,
  devices,
  onDone,
  confirm,
  toast,
}: {
  slug: string;
  devices: Array<DigifabFleetDevice & { connId: string }>;
  onDone: () => void;
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  const pausable = devices.filter((d) => d.active_job?.status === "printing");
  const resumable = devices.filter((d) => d.active_job?.status === "paused");
  const stoppable = devices.filter((d) => d.active_job && ["printing", "paused", "sent"].includes(d.active_job.status));
  const clearable = devices.filter((d) => d.needs_attention);
  const run = async (label: string, items: Array<DigifabFleetDevice & { connId: string }>, fn: (d: DigifabFleetDevice & { connId: string }) => Promise<unknown>, destructive = false) => {
    const ok = await confirm({
      title: `${label} ${items.length} machine${items.length === 1 ? "" : "s"}?`,
      message: destructive ? "On a live farm this affects running prints." : "Applies to every selected machine that supports it.",
      confirmLabel: label,
      destructive,
    });
    if (!ok) return;
    setBusy(true);
    const results = await Promise.allSettled(items.map(fn));
    const failed = results.filter((r) => r.status === "rejected").length;
    toast[failed ? "info" : "success"](failed ? `${label}: ${items.length - failed} ok, ${failed} failed` : `${label}: done on ${items.length}`);
    setBusy(false);
    onDone();
  };
  const btn = "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition disabled:opacity-50";
  return (
    <div className="sticky bottom-3 z-10 flex items-center gap-2 rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 shadow-lg px-3 py-2">
      <span className="text-xs font-medium text-content dark:text-mortar-100">{devices.length} selected</span>
      {pausable.length + resumable.length + stoppable.length + clearable.length === 0 && (
        <span className="text-[11px] text-faint italic">no batch actions for this selection — select running or finished machines</span>
      )}
      <div className="flex-1" />
      {pausable.length > 0 && (
        <button disabled={busy} onClick={() => run("Pause", pausable, (d) => api.pauseDigifabJob(slug, d.active_job!.id))} className={btn + " border border-line dark:border-slate-600 hover:border-accent hover:text-accent"}>
          <Pause size={12} /> Pause {pausable.length}
        </button>
      )}
      {resumable.length > 0 && (
        <button disabled={busy} onClick={() => run("Resume", resumable, (d) => api.resumeDigifabJob(slug, d.active_job!.id))} className={btn + " border border-line dark:border-slate-600 hover:border-accent hover:text-accent"}>
          <Play size={12} /> Resume {resumable.length}
        </button>
      )}
      {stoppable.length > 0 && (
        <button disabled={busy} onClick={() => run("Stop", stoppable, (d) => api.cancelDigifabJob(slug, d.active_job!.id), true)} className={btn + " border border-line dark:border-slate-600 hover:border-ember-500 hover:text-ember-500"}>
          <Ban size={12} /> Stop {stoppable.length}
        </button>
      )}
      {clearable.length > 0 && (
        <button disabled={busy} onClick={() => run("Clear bed on", clearable, (d) => api.markDigifabDeviceReady(slug, d.connId, d.id, "good"))} className={btn + " bg-moss-600 hover:bg-moss-700 text-white"}>
          Clear {clearable.length} bed{clearable.length === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}


const DEVICE_DRAG_MIME = "application/x-cobblr-fleet-device";
const FLOOR_COLS = 6;

/** ⑦ The spatial floor — a fixed-column grid mirroring the physical shop.
 *  Active whenever any machine has a pinned position (or while arranging).
 *  Arrange mode: cells are drop targets, cards are draggable; drop on the
 *  "unplaced" shelf to unpin. Placed cards keep their cell outside arrange
 *  mode; unplaced ones flow on a shelf below the floor. */
function FloorGrid({
  slug,
  devices,
  arranging,
  renderCard,
}: {
  slug: string;
  devices: Array<DigifabFleetDevice & { connId: string }>;
  arranging: boolean;
  renderCard: (d: DigifabFleetDevice & { connId: string }, draggable: boolean) => ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const move = useMutation({
    mutationFn: ({ d, pos }: { d: DigifabFleetDevice & { connId: string }; pos: { x: number; y: number } | null }) =>
      api.setDigifabDevicePosition(slug, d.connId, d.id, pos),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't move the machine"),
  });
  const placed = devices.filter((d) => d.position);
  const unplaced = devices.filter((d) => !d.position);
  const rows = Math.max(2, ...placed.map((d) => (d.position!.y ?? 0) + 1)) + (arranging ? 1 : 0);
  const byCell = new Map(placed.map((d) => [`${d.position!.x},${d.position!.y}`, d]));
  const readKey = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(DEVICE_DRAG_MIME);
    if (!raw) return null;
    try { return JSON.parse(raw) as { connId: string; id: string }; } catch { return null; }
  };
  const findDev = (k: { connId: string; id: string } | null) => (k ? devices.find((d) => d.connId === k.connId && d.id === k.id) ?? null : null);
  return (
    <div className="space-y-2">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${FLOOR_COLS}, minmax(0, 1fr))` }}>
        {Array.from({ length: rows * FLOOR_COLS }, (_, i) => {
          const x = i % FLOOR_COLS;
          const y = Math.floor(i / FLOOR_COLS);
          const d = byCell.get(`${x},${y}`);
          return (
            <div
              key={`${x},${y}`}
              className={
                "min-h-[7rem] rounded-lg " +
                (arranging ? "border border-dashed border-line dark:border-slate-700 " : "") +
                (d ? "" : arranging ? "bg-subtle/40 dark:bg-slate-800/20" : "")
              }
              onDragOver={(e) => { if (arranging && e.dataTransfer.types.includes(DEVICE_DRAG_MIME)) e.preventDefault(); }}
              onDrop={(e) => {
                if (!arranging) return;
                e.preventDefault();
                const dev = findDev(readKey(e));
                if (dev) move.mutate({ d: dev, pos: { x, y } });
              }}
            >
              {d && renderCard(d, arranging)}
            </div>
          );
        })}
      </div>
      {(unplaced.length > 0 || arranging) && (
        <div
          className={"rounded-lg p-2 " + (arranging ? "border border-dashed border-amber-400/60 dark:border-amber-700/60" : "")}
          onDragOver={(e) => { if (arranging && e.dataTransfer.types.includes(DEVICE_DRAG_MIME)) e.preventDefault(); }}
          onDrop={(e) => {
            if (!arranging) return;
            e.preventDefault();
            const dev = findDev(readKey(e));
            if (dev) move.mutate({ d: dev, pos: null });
          }}
        >
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1.5">
            {arranging ? "Unplaced — drag onto the floor (drop here to unpin)" : "Unplaced"}
          </div>
          {unplaced.length === 0 ? (
            <div className="text-[11px] text-faint italic">everything is placed</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {unplaced.map((d) => renderCard(d, arranging))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Which operator bucket a device falls in — the Bambu-style "what do I do"
 *  grouping (see docs/design-decisions/digifab-farm-view-anatomy.md). */
function deviceBucket(d: DigifabFleetDevice): "working" | "needs" | "idle" | "off" {
  if (d.needs_attention || d.klass === "error" || d.klass === "complete") return "needs";
  // A device is WORKING when Cobblr has a live job on it, even if the manager's
  // state string reads "operational" mid-print (some managers do).
  if (d.klass === "printing" || d.klass === "paused" || (d.active_job && ["printing", "paused", "sent"].includes(d.active_job.status))) return "working";
  if (d.klass === "offline") return "off";
  return "idle";
}

export function FleetView({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fleet = useQuery({
    queryKey: ["digifab-fleet", slug],
    queryFn: () => api.getDigifabFleet(slug),
    enabled: !!slug,
    refetchInterval: 12_000,
    // Refetches keep showing the previous floor instead of blanking it.
    placeholderData: (prev) => prev,
  });
  // Operator bucket filter (All / Working / Needs you / Idle / Off) — the
  // summary counts double as clickable filters.
  const [bucket, setBucket] = useState<"all" | "working" | "needs" | "idle" | "off">("all");
  // View mode: Cards (default) / Compact (density for big farms) / Cameras
  // (an OctoFarm-style webcam wall). Persisted.
  const [mode, setMode] = useState<"cards" | "dense" | "cams">(() => {
    const m = localStorage.getItem("cobblr.fleet.mode");
    return m === "dense" || m === "cams" ? m : "cards";
  });
  const pickMode = (m: "cards" | "dense" | "cams") => { localStorage.setItem("cobblr.fleet.mode", m); setMode(m); };
  const dense = mode === "dense";
  // ⑦ Arrange mode: drag machines onto floor-grid cells (FDMM relocate mode).
  const [arranging, setArranging] = useState(false);
  // Batch mode: select tiles → one action bar (FDMM-style).
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set()); // `${connId}:${deviceId}`
  const toggleSel = (k: string) => setSel((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const invalidateFleet = () => void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] });
  const data = fleet.data;
  // First load: render the section FRAME immediately with skeleton cards — the
  // fleet aggregate can take a few seconds (it asks every manager), and having
  // the whole section pop in later reads as broken layout (the author).
  if (!data) {
    return (
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Fleet</h2>
          <span className="text-xs font-mono text-faint">{fleet.isError ? "couldn't reach the farm — retrying" : "checking your machines…"}</span>
          {!fleet.isError && <RefreshCw size={13} className="animate-spin text-faint" />}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-2.5 animate-pulse space-y-2">
              <div className="h-3.5 w-2/3 rounded bg-line dark:bg-slate-700" />
              <div className="h-2.5 w-1/2 rounded bg-line dark:bg-slate-700" />
              <div className="h-1 w-full rounded bg-line dark:bg-slate-700" />
            </div>
          ))}
        </div>
      </section>
    );
  }
  // Bucket counts over the whole floor — the chips both inform AND filter.
  const allDevs = data.connections.filter((c) => !c.error).flatMap((c) => c.devices);
  const nBucket = (b: "working" | "needs" | "idle" | "off") => allDevs.filter((d) => deviceBucket(d) === b).length;
  const chips: Array<{ key: typeof bucket; label: string; n: number; dot: string }> = [
    { key: "all", label: "All", n: allDevs.length, dot: "bg-line" },
    { key: "working", label: "Working", n: nBucket("working"), dot: "bg-cobble-500" },
    { key: "needs", label: "Needs you", n: nBucket("needs"), dot: "bg-amber-500" },
    { key: "idle", label: "Idle", n: nBucket("idle"), dot: "bg-moss-500" },
    { key: "off", label: "Off", n: nBucket("off"), dot: "bg-faint" },
  ];
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Fleet</h2>
        {/* Operator buckets — clickable filters, Bambu-style ("what do I do?"). */}
        <div className="flex items-center gap-1">
          {chips.map((c) => (
            (c.n > 0 || c.key === "all") && (
              <button
                key={c.key}
                type="button"
                onClick={() => setBucket(c.key)}
                className={
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] transition " +
                  (bucket === c.key
                    ? "bg-cobble-600 text-white"
                    : "border border-line dark:border-slate-600 text-muted hover:border-accent hover:text-accent")
                }
              >
                <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                {c.label} {c.n}
              </button>
            )
          ))}
        </div>
        <div className="flex-1" />
        {mode === "cards" && (
          <button
            type="button"
            onClick={() => setArranging((v) => !v)}
            className={"text-[11px] px-2 py-0.5 rounded border transition " + (arranging ? "border-cobble-500 text-accent" : "border-line dark:border-slate-600 text-muted hover:border-accent hover:text-accent")}
            title="Arrange machines on the floor (drag to a cell)"
          >
            {arranging ? "Done arranging" : "Arrange"}
          </button>
        )}
        <button
          type="button"
          onClick={() => { setSelecting((v) => !v); setSel(new Set()); }}
          className={"text-[11px] px-2 py-0.5 rounded border transition " + (selecting ? "border-cobble-500 text-accent" : "border-line dark:border-slate-600 text-muted hover:border-accent hover:text-accent")}
          title="Select machines for a batch action"
        >
          {selecting ? "Done" : "Select"}
        </button>
        <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden">
          {([["cards", "Cards"], ["dense", "Compact"], ["cams", "Cameras"]] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => pickMode(m)}
              className={"text-[11px] px-2 py-0.5 transition " + (mode === m ? "bg-cobble-600 text-white" : "text-muted hover:text-accent")}
              title={m === "cams" ? "Webcam wall — every machine's camera" : m === "dense" ? "Compact cards (fit more machines)" : "Full cards"}
            >
              {label}
            </button>
          ))}
        </div>
        {fleet.isFetching && <RefreshCw size={13} className="animate-spin text-faint" />}
      </div>
      {(() => {
        // Group machines by POOL (a pool reads as one farm even across
        // connections); unpooled machines fall back to their connection. A
        // dead manager keeps its own error row.
        type FDev = DigifabFleetDevice & { connLabel: string; connId: string; connType: string };
        const errored = data.connections.filter((c) => c.error);
        const allUnfiltered: FDev[] = data.connections
          .filter((c) => !c.error)
          .flatMap((c) => c.devices.map((d) => ({ ...d, connLabel: c.label, connId: c.connection_id, connType: c.type })));
        const all: FDev[] = allUnfiltered.filter((d) => bucket === "all" || deviceBucket(d) === bucket);
        // titleFor needs the counts regardless of layout path.
        const connDeviceCountEarly = new Map<string, number>();
        for (const d of allUnfiltered) connDeviceCountEarly.set(d.connId, (connDeviceCountEarly.get(d.connId) ?? 0) + 1);
        const manyConnsEarly = new Set(allUnfiltered.filter((d) => !d.pool_id).map((d) => d.connId)).size > 1;
        const titleForDev = (d: FDev): { title: string; sub: string | null } => {
          if (d.pool_id) return { title: d.name, sub: d.pool_name };
          if ((connDeviceCountEarly.get(d.connId) ?? 0) === 1 && d.connLabel && d.connLabel !== d.name) return { title: d.connLabel, sub: d.name };
          return { title: d.name, sub: manyConnsEarly ? d.connLabel : null };
        };
        // ⑦ SPATIAL FLOOR: active in Cards mode while arranging, or whenever any
        // machine has a pinned position. Replaces the pool/connection sections —
        // the floor mirrors the shop, badges carry the grouping.
        const spatial = mode === "cards" && (arranging || allUnfiltered.some((d) => d.position));
        if (spatial) {
          const floorDevs = arranging ? allUnfiltered : all;
          return (
            <>
              <FloorGrid
                slug={slug}
                devices={floorDevs}
                arranging={arranging}
                renderCard={(d, draggable) => {
                  const fd = d as FDev;
                  const t = titleForDev(fd);
                  const k = `${fd.connId}:${fd.id}`;
                  return (
                    <div
                      draggable={draggable}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DEVICE_DRAG_MIME, JSON.stringify({ connId: fd.connId, id: fd.id }));
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      className={draggable ? "cursor-grab active:cursor-grabbing" : ""}
                    >
                      <DeviceCard d={fd} connId={fd.connId} slug={slug} title={t.title} subtitle={t.sub} selecting={selecting} selected={sel.has(k)} onToggleSelect={() => toggleSel(k)} />
                    </div>
                  );
                }}
              />
              {errored.map((c) => (
                <div key={c.connection_id} className="flex items-center gap-1.5 text-xs text-ember-600 dark:text-ember-500">
                  <AlertTriangle size={13} className="shrink-0" /> {c.label} unreachable — {c.error}
                </div>
              ))}
              {selecting && sel.size > 0 && (
                <FleetBatchBar slug={slug} devices={all.filter((d) => sel.has(`${d.connId}:${d.id}`))} onDone={() => { setSel(new Set()); invalidateFleet(); }} confirm={confirm} toast={toast} />
              )}
            </>
          );
        }
        const pools = new Map<string, { name: string; devices: FDev[] }>();
        const unpooled = new Map<string, FDev[]>();
        for (const d of all) {
          if (d.pool_id) {
            const g = pools.get(d.pool_id) ?? { name: d.pool_name ?? "Pool", devices: [] };
            g.devices.push(d);
            pools.set(d.pool_id, g);
          } else {
            const arr = unpooled.get(d.connLabel) ?? [];
            arr.push(d);
            unpooled.set(d.connLabel, arr);
          }
        }
        // Farm-floor order: what's WORKING leads, dead metal trails.
        const RANK: Record<string, number> = { printing: 0, paused: 1, complete: 2, idle: 3, error: 4, unknown: 5, offline: 6 };
        const byActivity = (a: FDev, b: FDev) =>
          (a.needs_attention ? -1 : RANK[a.klass] ?? 9) - (b.needs_attention ? -1 : RANK[b.klass] ?? 9) || a.name.localeCompare(b.name);
        const sections: Array<{ key: string; label: string | null; isPool: boolean; devices: FDev[] }> = [];
        for (const [id, g] of pools) sections.push({ key: `pool:${id}`, label: g.name, isPool: true, devices: g.devices.sort(byActivity) });
        // Unpooled machines share ONE grid — a connection is plumbing, not a
        // section: three single-printer connections used to render as three
        // full-width rows of one lonely card each (the author). The connection identity
        // moves onto the card instead: a single-machine connection's LABEL is the
        // human name ("RailCore 300ZL — Justin"), so the card leads with it and
        // demotes the device name ("Klipper (192.168.1.128)") to a subtitle;
        // multi-machine connections keep the device name and note the connection.
        const connDeviceCount = new Map<string, number>();
        for (const d of all) connDeviceCount.set(d.connId, (connDeviceCount.get(d.connId) ?? 0) + 1);
        const flat: FDev[] = [...unpooled.values()].flat().sort(byActivity);
        if (flat.length > 0) sections.push({ key: "unpooled", label: pools.size > 0 ? "Machines" : null, isPool: false, devices: flat });
        const manyConns = new Set(flat.map((d) => d.connId)).size > 1;
        const titleFor = (d: FDev): { title: string; sub: string | null } => {
          if (d.pool_id) return { title: d.name, sub: null };
          if ((connDeviceCount.get(d.connId) ?? 0) === 1 && d.connLabel && d.connLabel !== d.name) {
            return { title: d.connLabel, sub: d.name };
          }
          return { title: d.name, sub: manyConns ? d.connLabel : null };
        };
        return (
          <>
            {sections.map((sec) => (
              <div key={sec.key} className="space-y-1.5">
                {sec.label && (
                  <div className="text-[11px] font-mono uppercase tracking-wider text-faint flex items-center gap-1.5">
                    {sec.isPool && <Layers size={11} className="text-accent" />}
                    {sec.label}
                    {sec.isPool && <span className="text-faint/70">· {sec.devices.length} machine{sec.devices.length === 1 ? "" : "s"}</span>}
                  </div>
                )}
                <div className={dense ? "grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-1.5" : mode === "cams" ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" : "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2"}>
                  {sec.devices.map((d) => {
                    const t = titleFor(d);
                    const k = `${d.connId}:${d.id}`;
                    return (
                      <DeviceCard
                        key={`${sec.key}:${k}`}
                        d={d}
                        connId={d.connId}
                        slug={slug}
                        title={t.title}
                        subtitle={t.sub}
                        dense={dense}
                        cams={mode === "cams"}
                        selecting={selecting}
                        selected={sel.has(k)}
                        onToggleSelect={() => toggleSel(k)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            {errored.map((c) => (
              <div key={c.connection_id} className="flex items-center gap-1.5 text-xs text-ember-600 dark:text-ember-500">
                <AlertTriangle size={13} className="shrink-0" /> {c.label} unreachable — {c.error}
              </div>
            ))}
            {sections.length === 0 && errored.length === 0 && (
              <div className="text-xs text-faint italic">{bucket === "all" ? "No machines reported." : "Nothing in this bucket right now."}</div>
            )}
            {selecting && sel.size > 0 && (
              <FleetBatchBar
                slug={slug}
                devices={all.filter((d) => sel.has(`${d.connId}:${d.id}`))}
                onDone={() => { setSel(new Set()); invalidateFleet(); }}
                confirm={confirm}
                toast={toast}
              />
            )}
          </>
        );
      })()}
    </section>
  );
}

// Cockpit: temps + the "set camera URL" affordance live on the device card.
function tempLabel(t: { actual: number; target?: number } | null | undefined): string | null {
  if (!t) return null;
  return t.target ? `${Math.round(t.actual)}/${Math.round(t.target)}°` : `${Math.round(t.actual)}°`;
}

/** Minutes → "13h 2m" / "45m" — readable remaining-time. */
function fmtRemaining(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// The relayed snapshot: auth-fetch the latest agent-pushed frame to a blob URL.
// `live` → refresh every few seconds (a near-live thumbnail while the printer
// works); otherwise fetch ONCE and freeze it — the last frame stays visible with
// no constant bandwidth on an idle bed.
function RelaySnapshot({ slug, connId, deviceId, name, live }: { slug: string; connId: string; deviceId: string; name: string; live: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    const tick = async () => {
      const next = await fetchAuthBlobUrl(api.digifabSnapshotPath(slug, connId, deviceId));
      if (!alive) { if (next) URL.revokeObjectURL(next); return; }
      if (next) { setUrl(next); if (current) URL.revokeObjectURL(current); current = next; }
    };
    void tick(); // always grab the latest stored frame once (even if stale)
    const id = live ? setInterval(tick, 5000) : null;
    return () => { alive = false; if (id) clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId, live]);
  if (!url) return null;
  return <img src={url} alt={`${name} camera`} className="mb-1.5 w-full h-24 object-cover rounded bg-black/30" />;
}

const LIBRARY_DRAG_MIME = "application/x-cobblr-library-item";

function RelaySnapshotFill({ slug, connId, deviceId, name, live }: { slug: string; connId: string; deviceId: string; name: string; live: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    const tick = async () => {
      const next = await fetchAuthBlobUrl(api.digifabSnapshotPath(slug, connId, deviceId));
      if (!alive) { if (next) URL.revokeObjectURL(next); return; }
      if (next) { setUrl(next); if (current) URL.revokeObjectURL(current); current = next; }
    };
    void tick();
    const id = live ? setInterval(tick, 5000) : null;
    return () => { alive = false; if (id) clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId, live]);
  if (!url) return <span className="flex flex-col items-center gap-1 text-faint text-[11px]"><Camera size={18} /> waiting for a frame…</span>;
  return <img src={url} alt={`${name} camera`} className="w-full h-full object-cover" />;
}

function DeviceCard({ d, connId, slug, title, subtitle, dense, cams, selecting, selected, onToggleSelect }: {
  d: DigifabFleetDevice; connId: string; slug: string; title?: string; subtitle?: string | null;
  /** Compact tile (farm-wall density). */
  dense?: boolean;
  /** Camera-wall tile: the webcam IS the card (OctoFarm camera view). */
  cams?: boolean;
  /** Batch mode: clicking the card toggles selection instead of opening it. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const st = KLASS_STYLE[d.klass];
  // Progress: a Cobblr job's (0–1) wins; otherwise the printer's own live percent
  // (already 0–100, e.g. a Bambu print started from its own slicer).
  const pct = d.active_job?.progress != null
    ? Math.round(d.active_job.progress * 100)
    : d.live?.progress != null ? Math.round(d.live.progress) : null;
  const invalidateFleet = () => void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] });
  const [camOpen, setCamOpen] = useState(false);
  const [camUrl, setCamUrl] = useState(d.camera_url ?? "");
  const ready = useMutation({
    mutationFn: (outcome: "good" | "scrapped") => api.markDigifabDeviceReady(slug, connId, d.id, outcome),
    onSuccess: (_r, outcome) => {
      toast.success(
        outcome === "scrapped"
          ? `${d.name} cleared — scrapped, filament & usage restored`
          : `${d.name} cleared — ready for the next job`,
      );
      invalidateFleet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const camera = useMutation({
    mutationFn: (url: string | null) => api.setDigifabDeviceCamera(slug, connId, d.id, url),
    onSuccess: () => { setCamOpen(false); toast.success("Camera updated"); invalidateFleet(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const ctrl = useMutation({
    mutationFn: (action: "pause" | "resume") =>
      action === "pause" ? api.pauseDigifabJob(slug, d.active_job!.id) : api.resumeDigifabJob(slug, d.active_job!.id),
    onSuccess: (_r, action) => { toast.success(action === "pause" ? "Paused" : "Resumed"); invalidateFleet(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const confirmStop = useConfirm();
  const stop = useMutation({
    mutationFn: () => api.cancelDigifabJob(slug, d.active_job!.id),
    onSuccess: (r) => {
      toast[r.remote_cancelled ? "success" : "info"](r.remote_cancelled ? "Stopped — told the printer to abort" : "Marked cancelled — stop it at the machine if it's still moving");
      invalidateFleet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const relay = useMutation({
    mutationFn: (enabled: boolean) => api.setDigifabDeviceSnapshotRelay(slug, connId, d.id, enabled),
    onSuccess: (_r, enabled) => { toast.success(enabled ? "Snapshot relay on" : "Snapshot relay off"); invalidateFleet(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // FDMM-signature interaction: drag a Library file onto the tile → queue + send
  // it to THIS printer (confirm-gated; a drop must never silently start a print).
  const [dropHover, setDropHover] = useState(false);
  const confirmDrop = useConfirm();
  const dropSend = useMutation({
    mutationFn: async (item: { name: string; file_id: string }) => {
      const job = await api.createDigifabJob(slug, { connection_id: connId, target_device: d.id, file_ref: item.name, file_id: item.file_id });
      return api.sendDigifabJob(slug, job.id);
    },
    onSuccess: () => { toast.success(`Sent to ${d.name} — printing`); invalidateFleet(); void qc.invalidateQueries({ queryKey: ["digifab-jobs", slug] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
    const raw = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
    if (!raw) return;
    let item: { name: string; file_id: string };
    try { item = JSON.parse(raw); } catch { return; }
    if (await confirmDrop({ title: `Print "${item.name}" on ${d.name}?`, message: "Uploads the file and starts the print on this machine now.", confirmLabel: "Print here", destructive: true })) {
      dropSend.mutate(item);
    }
  };

  // EXPERIMENTAL cloud control: publish a command to a Bambu over the pump's MQTT
  // (same broker the app uses). The printer may reject it (Authorization Control)
  // — so we lead with the harmless visible ones (light / nudge) to confirm it works.
  const [detailOpen, setDetailOpen] = useState(false);
  const att = d.needs_attention;
  const nozzle = tempLabel(d.temps?.nozzle);
  const bed = tempLabel(d.temps?.bed);
  const chamber = tempLabel(d.temps?.chamber);
  const job = d.active_job;
  // ETA: "~done 3:42 PM" from the driver-reported seconds remaining (Cobblr job)
  // or the printer's own remaining minutes (external print).
  const etaMin = job?.eta_sec != null ? Math.round(job.eta_sec / 60) : d.live?.remaining_min ?? null;
  const doneBy = etaMin != null && etaMin > 0 ? new Date(Date.now() + etaMin * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  // Blocking reason — say WHY a machine isn't doing anything (SimplyPrint's
  // strongest pattern). Attention has its own richer banner below.
  const blocked = !d.enabled ? "disabled — not taking jobs" : d.klass === "offline" ? "offline — check the machine" : d.klass === "error" && !att ? "error — see the manager" : null;
  const dragProps = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) { e.preventDefault(); setDropHover(true); } },
    onDragLeave: () => setDropHover(false),
    onDrop: (e: React.DragEvent) => void onDrop(e),
  };
  const rootCls = `relative rounded-lg border overflow-hidden ${dropHover ? "border-cobble-500 ring-2 ring-cobble-500/40" : att ? "border-amber-400 dark:border-amber-700" : st.ring} bg-subtle dark:bg-slate-800/50 ${d.enabled ? "" : "opacity-50"} ${selecting ? "cursor-pointer" : ""} ${selected ? "ring-2 ring-cobble-500" : ""}`;

  // Camera-wall tile — the feed is the card; status + progress ride as an
  // overlay strip. Streams/snapshots regardless of state (that's the point of
  // switching to this view). Clicking opens the cockpit.
  if (cams) {
    return (
      <div className={rootCls} {...dragProps} onClick={selecting ? onToggleSelect : undefined}>
        <div className={`h-1 ${att ? "bg-amber-500" : st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
        <button type="button" onClick={selecting ? undefined : () => setDetailOpen(true)} className="block w-full text-left">
          <div className="aspect-video bg-black/40 flex items-center justify-center overflow-hidden">
            {d.snapshot_relay ? (
              <RelaySnapshotFill slug={slug} connId={connId} deviceId={d.id} name={d.name} live={d.klass === "printing" || d.klass === "paused"} />
            ) : d.camera_url ? (
              <img src={d.camera_url} alt={`${d.name} camera`} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            ) : (
              <span className="flex flex-col items-center gap-1 text-faint text-[11px]"><Camera size={18} /> no camera</span>
            )}
          </div>
          <div className="px-2 py-1.5 flex items-center gap-2">
            {selecting && <input type="checkbox" checked={!!selected} readOnly className="shrink-0" />}
            <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
            <span className="text-xs font-medium text-content dark:text-mortar-100 truncate">{title ?? d.name}</span>
            <span className="flex-1" />
            {pct != null && <span className="text-[10px] font-mono text-faint shrink-0">{pct}%{doneBy ? ` · ~${doneBy}` : ""}</span>}
            {att && <span className="text-[10px] text-amber-600 shrink-0">clear bed</span>}
          </div>
        </button>
        {detailOpen && <PrinterDetailModal slug={slug} connId={connId} device={d} onClose={() => setDetailOpen(false)} />}
      </div>
    );
  }

  // Compact tile — farm-wall density: band, name, progress, ETA. Everything else
  // is one click away in the cockpit.
  if (dense) {
    return (
      <div className={rootCls} {...dragProps} onClick={selecting ? onToggleSelect : undefined}>
        <div className={`h-1 ${att ? "bg-amber-500" : st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
        <div className="p-1.5">
          <div className="flex items-center gap-1">
            {selecting && <input type="checkbox" checked={!!selected} readOnly className="shrink-0" />}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />
            <button type="button" onClick={(e) => { if (selecting) { e.stopPropagation(); onToggleSelect?.(); } else setDetailOpen(true); }} className="text-[11px] font-medium text-content dark:text-mortar-100 truncate hover:text-accent text-left flex-1 min-w-0" title={title ?? d.name}>
              {title ?? d.name}
            </button>
          </div>
          {pct != null ? (
            <>
              <div className="mt-1 h-1 rounded bg-line dark:bg-slate-700 overflow-hidden">
                <div className={`h-full ${job?.status === "paused" ? "bg-amber-500" : "bg-cobble-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[9px] font-mono text-faint mt-0.5 truncate">{pct}%{doneBy ? ` · ~${doneBy}` : ""}</div>
            </>
          ) : (
            <div className={`text-[9px] font-mono uppercase tracking-wider truncate ${st.text}`}>{att ? "clear bed" : blocked ?? d.state}</div>
          )}
        </div>
        {detailOpen && <PrinterDetailModal slug={slug} connId={connId} device={d} onClose={() => setDetailOpen(false)} />}
      </div>
    );
  }

  return (
    <div className={rootCls} {...dragProps} onClick={selecting ? onToggleSelect : undefined}>
      {/* Status band — the farm-floor read: color says state before text does. */}
      <div className={`h-1 ${att ? "bg-amber-500" : st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
      <div className="p-2.5">
      {selecting && (
        <div className="flex items-center gap-1.5 mb-1">
          <input type="checkbox" checked={!!selected} readOnly />
          <span className="text-[10px] text-faint">select</span>
        </div>
      )}
      {/* Cockpit camera. A relayed snapshot shows the last frame frozen and only
          live-refreshes while the printer is working (printing/paused) — no
          constant bandwidth on an idle bed, but the last image stays visible. A
          direct camera_url is a continuous MJPEG stream, so it's only embedded
          while working; otherwise it'd stream 24/7. Either way the live feed is
          one click away in the detail modal (mounts on open). */}
      {d.snapshot_relay ? (
        <RelaySnapshot
          slug={slug}
          connId={connId}
          deviceId={d.id}
          name={d.name}
          live={d.klass === "printing" || d.klass === "paused"}
        />
      ) : (d.klass === "printing" || d.klass === "paused") && d.camera_url ? (
        <img
          src={d.camera_url}
          alt={`${d.name} camera`}
          className="mb-1.5 w-full h-24 object-cover rounded bg-black/30"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
        <button type="button" onClick={(e) => { if (selecting) { e.stopPropagation(); onToggleSelect?.(); } else setDetailOpen(true); }} className="text-sm font-medium text-content dark:text-mortar-100 truncate hover:text-accent text-left" title={`${title ?? d.name} — open details`}>{title ?? d.name}</button>
        <div className="flex-1" />
        <button
          onClick={() => { setCamUrl(d.camera_url ?? ""); setCamOpen((o) => !o); }}
          title={d.camera_url ? "Edit camera URL" : "Add a camera URL"}
          className={`p-0.5 transition ${d.camera_url ? "text-accent" : "text-faint hover:text-accent"}`}
        >
          <Camera size={13} />
        </button>
      </div>
      {subtitle && <div className="text-[10px] text-faint truncate">{subtitle}</div>}
      <div className="flex items-center gap-2 mt-0.5">
        <span className={`text-[10px] font-mono uppercase tracking-wider ${st.text}`}>{d.state}</span>
        {d.stage && (
          <span className="text-[10px] font-medium text-accent truncate" title="current stage">{d.stage}</span>
        )}
        {(nozzle || bed || chamber) && (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-faint" title="nozzle / bed / chamber (actual/target °C)">
            <Thermometer size={10} />
            {nozzle && <span>N {nozzle}</span>}
            {bed && <span>B {bed}</span>}
            {chamber && <span>C {chamber}</span>}
          </span>
        )}
      </div>
      {blocked && <div className="mt-1 text-[10px] text-ember-600 dark:text-ember-500">{blocked}</div>}
      {/* Next up — what this machine will do next (queued to it or its pool). */}
      {d.next_job && !att && (
        <div className="mt-1 text-[10px] text-faint truncate" title={d.next_job.file_ref}>
          ⏭ next: <span className="text-muted dark:text-slate-400">{d.next_job.file_ref}</span>{d.next_job.pooled ? " · pool" : ""}
        </div>
      )}
      {camOpen && (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            value={camUrl}
            onChange={(e) => setCamUrl(e.target.value)}
            placeholder="http://…/webcam/?action=stream"
            className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <button onClick={() => camera.mutate(camUrl.trim() || null)} disabled={camera.isPending} className="text-[11px] rounded bg-cobble-600 hover:bg-cobble-700 text-white px-1.5 py-0.5 disabled:opacity-50">Save</button>
          {d.camera_url && <button onClick={() => camera.mutate(null)} disabled={camera.isPending} title="Remove" className="text-faint hover:text-ember-500 p-0.5"><X size={12} /></button>}
        </div>
      )}
      {camOpen && (
        // Snapshot relay (opt-in, OFF by default): pushes frames up so the feed
        // works for a REMOTE viewer (not on the printer's LAN). Costs bandwidth.
        <label className="mt-1 flex items-center gap-1.5 text-[10px] text-faint cursor-pointer">
          <input type="checkbox" checked={d.snapshot_relay} disabled={relay.isPending} onChange={(e) => relay.mutate(e.target.checked)} />
          Relay snapshots to cloud (for remote viewing){d.snapshot_relay && !d.snapshot_fresh ? " — waiting for the agent…" : ""}
        </label>
      )}
      {att && (
        // F-1: bed-clear gate. The printer finished/failed a print and won't take
        // new work until a human confirms the bed is clear.
        <div className="mt-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-1">
          <div className="text-[10px] text-amber-700 dark:text-amber-400 leading-tight">
            {att.reason === "print-failed" ? "Print failed — check the bed" : "Print done — clear the bed. Come out good?"}
          </div>
          {att.reason === "print-failed" ? (
            <button
              onClick={() => ready.mutate("good")}
              disabled={ready.isPending}
              className="mt-1 w-full text-[11px] rounded bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white py-0.5"
            >
              {ready.isPending ? "…" : "Cleared — ready"}
            </button>
          ) : (
            // F-13: the verdict. "Good" closes the linked task; "Scrapped" puts
            // the filament + machine usage back. Both clear the bed.
            <div className="mt-1 flex gap-1">
              <button
                onClick={() => ready.mutate("good")}
                disabled={ready.isPending}
                className="flex-1 text-[11px] rounded bg-moss-600 hover:bg-moss-700 disabled:opacity-50 text-white py-0.5"
              >
                Came out good
              </button>
              <button
                onClick={() => ready.mutate("scrapped")}
                disabled={ready.isPending}
                className="flex-1 text-[11px] rounded border border-amber-400 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-800 dark:text-amber-300 py-0.5"
              >
                Scrapped
              </button>
            </div>
          )}
        </div>
      )}
      {job && (
        <div className="mt-1.5">
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0 text-[11px] text-muted dark:text-slate-400 truncate" title={job.file_ref}>
              {job.file_ref}
            </div>
            {job.priority > 0 && (
              <span className={"text-[9px] font-mono uppercase px-1 rounded shrink-0 " + (job.priority >= 20 ? "bg-ember-500/15 text-ember-600" : "bg-amber-500/15 text-amber-600")}>
                {job.priority >= 20 ? "urgent" : "high"}
              </span>
            )}
            {job.max_attempts > 1 && (
              <span className="text-[9px] text-faint shrink-0" title={`auto-retry on fail (${job.attempts}/${job.max_attempts - 1} used)`}>↻{job.attempts}/{job.max_attempts - 1}</span>
            )}
            {/* Cockpit live-control: pause / resume the running print. */}
            {job.status === "printing" && (
              <button onClick={() => ctrl.mutate("pause")} disabled={ctrl.isPending} title="Pause print" className="text-faint hover:text-accent transition p-0.5 disabled:opacity-50">
                <Pause size={13} />
              </button>
            )}
            {job.status === "paused" && (
              <button onClick={() => ctrl.mutate("resume")} disabled={ctrl.isPending} title="Resume print" className="text-amber-600 hover:text-amber-700 transition p-0.5 disabled:opacity-50">
                <Play size={13} />
              </button>
            )}
            {(job.status === "printing" || job.status === "paused" || job.status === "sent") && (
              <button
                onClick={async () => {
                  if (await confirmStop({ title: `Stop the print on ${d.name}?`, message: "Cancels the job. Where the manager supports it the printer aborts; otherwise stop it at the machine.", confirmLabel: "Stop print", destructive: true })) stop.mutate();
                }}
                disabled={stop.isPending}
                title="Stop print"
                className="text-faint hover:text-ember-500 transition p-0.5 disabled:opacity-50"
              >
                <Ban size={13} />
              </button>
            )}
          </div>
          {job.status === "paused" && <div className="text-[10px] font-mono uppercase tracking-wider text-amber-600 mt-0.5">paused</div>}
          {pct != null && (
            <>
              <div className="mt-1 h-1 rounded bg-line dark:bg-slate-700 overflow-hidden">
                <div className={`h-full transition-[width] ${job.status === "paused" ? "bg-amber-500" : "bg-cobble-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10px] font-mono text-faint mt-0.5 flex gap-2">
                <span>{pct}%</span>
                {etaMin != null && etaMin > 0 && <span>{fmtRemaining(etaMin)} left</span>}
                {doneBy && <span>~done {doneBy}</span>}
              </div>
            </>
          )}
        </div>
      )}
      {/* A print Cobblr didn't start (e.g. straight from Bambu Studio) — show the
          printer's own live progress so the floor view isn't blank for it. */}
      {!job && pct != null && d.live && (
        <div className="mt-1.5">
          <div className="h-1 rounded bg-line dark:bg-slate-700 overflow-hidden">
            <div className="h-full transition-[width] bg-cobble-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[10px] font-mono text-faint mt-0.5 flex gap-2">
            <span>{pct}%</span>
            {d.live.layer_num != null && d.live.total_layers != null && <span>layer {d.live.layer_num}/{d.live.total_layers}</span>}
            {d.live.remaining_min != null && d.live.remaining_min > 0 && <span>{fmtRemaining(d.live.remaining_min)} left</span>}
          </div>
        </div>
      )}
      {/* Open the full printer modal — identity, live telemetry, controls,
          link-to-machine, and this printer's history, all in one place. */}
      <div className="mt-1.5 pt-1.5 border-t border-line dark:border-slate-700/60">
        <button type="button" onClick={() => setDetailOpen(true)} className="text-[10px] text-accent hover:underline flex items-center gap-1">
          <Sliders size={11} /> Details &amp; controls
        </button>
      </div>
      </div>
      {detailOpen && <PrinterDetailModal slug={slug} connId={connId} device={d} onClose={() => setDetailOpen(false)} />}
    </div>
  );
}

// Generic control panel — fetches the controls the driver DECLARES for this
// device and renders by kind (action buttons, a light toggle, a jog pad, number
// inputs), grouped. Only declared controls appear, so a printer shows exactly
// what it can do. Works across managers (Bambu cloud/LAN, Moonraker, OctoPrint,
// Duet, edge-bridge) — each declares its own set.
// A proper directional jog pad — an X/Y cross with Home in the middle and a
// separate Z column — instead of a flat row of X+/X−/Y+/Y− buttons. Renders only
// the axes the driver actually reports.
function JogPad({
  axes,
  step,
  steps,
  onStep,
  onJog,
  onHome,
  disabled,
}: {
  axes: string[];
  step: number;
  steps: number[];
  onStep: (s: number) => void;
  onJog: (axis: string, dist: number) => void;
  onHome?: () => void;
  disabled?: boolean;
}) {
  const has = (a: string) => axes.includes(a);
  const pad =
    "flex items-center justify-center rounded-md border border-line dark:border-slate-600 hover:border-accent hover:text-accent text-content dark:text-mortar-200 transition disabled:opacity-30 disabled:hover:border-line disabled:hover:text-content h-9 w-9 text-sm font-medium select-none";
  const cell = "flex items-center justify-center h-9 w-9";
  const btn = (label: string, axis: string, dist: number) => (
    <button type="button" disabled={disabled || !has(axis)} onClick={() => onJog(axis, dist)} className={pad} title={`${axis.toUpperCase()} ${dist > 0 ? "+" : "−"}${Math.abs(dist)}mm`}>
      {label}
    </button>
  );
  return (
    <div className="flex items-start gap-4">
      {/* X / Y cross */}
      <div className="grid grid-cols-3 grid-rows-3 gap-1">
        <div className={cell} />
        <div className={cell}>{btn("Y+", "y", step)}</div>
        <div className={cell} />
        <div className={cell}>{btn("X−", "x", -step)}</div>
        <div className={cell}>
          {onHome ? (
            <button type="button" disabled={disabled} onClick={onHome} className={pad} title="Home all axes">⌂</button>
          ) : (
            <span className="text-[9px] font-mono uppercase text-faint">X/Y</span>
          )}
        </div>
        <div className={cell}>{btn("X+", "x", step)}</div>
        <div className={cell} />
        <div className={cell}>{btn("Y−", "y", -step)}</div>
        <div className={cell} />
      </div>
      {/* Z column */}
      {has("z") && (
        <div className="flex flex-col items-center gap-1">
          {btn("Z+", "z", step)}
          <span className="text-[9px] font-mono uppercase text-faint">Z</span>
          {btn("Z−", "z", -step)}
        </div>
      )}
      {/* Step selector */}
      <div className="flex flex-col gap-1">
        <span className="text-[9px] font-mono uppercase text-faint">Step</span>
        {steps.map((sMm) => (
          <button
            key={sMm}
            type="button"
            onClick={() => onStep(sMm)}
            className={
              "px-2 py-1 rounded text-xs border transition " +
              (step === sMm ? "bg-cobble-600 text-white border-cobble-600" : "border-line dark:border-slate-600 text-muted hover:border-accent")
            }
          >
            {sMm}mm
          </button>
        ))}
      </div>
    </div>
  );
}

function ControlsPanel({ slug, connId, deviceId, name, telemetry, lanActive }: { slug: string; connId: string; deviceId: string; name: string; telemetry?: DigifabDeviceDetail["telemetry"] | null; lanActive?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [jogStep, setJogStep] = useState(10);
  const [nums, setNums] = useState<Record<string, string>>({});
  // Map a temperature control to its live actual/target so the input reflects
  // reality (pre-filled to the current target — so it "persists" across reopen)
  // and shows actual → target next to it.
  const tempFor = (id: string): { actual: number | null; target: number | null } | null => {
    if (!telemetry) return null;
    if (id === "nozzle_temp") return { actual: telemetry.nozzle, target: telemetry.nozzle_target };
    if (id === "bed_temp") return { actual: telemetry.bed, target: telemetry.bed_target };
    return null;
  };
  const ctrls = useQuery({ queryKey: ["digifab-controls", slug, connId, deviceId], queryFn: () => api.getDigifabControls(slug, connId, deviceId) });
  const run = useMutation({
    mutationFn: ({ id, params }: { id: string; params?: Record<string, unknown> }) => api.runDigifabControl(slug, connId, deviceId, id, params),
    onSuccess: () => toast.success("Sent — watch the printer"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't send"),
  });
  const controls = ctrls.data?.controls ?? [];
  const doRun = async (c: typeof controls[number], params?: Record<string, unknown>) => {
    if (c.destructive && !(await confirm({ title: `${c.label} — ${name}?`, message: "This affects the running print.", confirmLabel: c.label, destructive: true }))) return;
    run.mutate({ id: c.id, params });
  };
  const groups: { key: string; label: string }[] = [
    { key: "print", label: "Print" }, { key: "motion", label: "Motion" }, { key: "temperature", label: "Temperature" }, { key: "accessory", label: "Accessory" },
  ];
  const btn = "text-xs px-2 py-1 rounded border border-line dark:border-slate-600 hover:border-accent disabled:opacity-50";
  return (
    <>
      {ctrls.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : controls.length === 0 ? (
        <div className="text-sm text-muted dark:text-slate-400 italic">This printer reports no live controls.</div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const cs = controls.filter((c) => (c.group ?? "accessory") === g.key);
            if (cs.length === 0) return null;
            const jog = cs.find((c) => c.kind === "jog");
            const homeAction = g.key === "motion" ? cs.find((c) => c.kind === "action") : undefined;
            return (
              <div key={g.key}>
                <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1.5">{g.label}</div>
                {/* Motion renders as a directional jog pad; Home rides inside it. */}
                {g.key === "motion" && jog ? (
                  <JogPad
                    axes={jog.axes ?? ["z"]}
                    step={jogStep}
                    steps={jog.steps ?? [1, 10, 100]}
                    onStep={setJogStep}
                    onJog={(axis, dist) => doRun(jog, { axis, dist })}
                    onHome={homeAction ? () => doRun(homeAction) : undefined}
                    disabled={run.isPending}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {cs.map((c) =>
                      c.kind === "action" ? (
                        <button key={c.id} type="button" onClick={() => doRun(c)} disabled={run.isPending} className={c.destructive ? "text-xs px-2.5 py-1.5 rounded border border-ember-400 text-ember-600 hover:bg-ember-50 dark:hover:bg-ember-950/30 disabled:opacity-50" : btn}>{c.label}</button>
                      ) : c.kind === "toggle" ? (
                        <span key={c.id} className="inline-flex items-center gap-1 text-xs">
                          <span className="text-muted dark:text-slate-400">{c.label}</span>
                          <button type="button" onClick={() => doRun(c, { on: true })} disabled={run.isPending} className={btn}>on</button>
                          <button type="button" onClick={() => doRun(c, { on: false })} disabled={run.isPending} className={btn}>off</button>
                        </span>
                      ) : c.kind === "jog" ? null : (
                        (() => {
                          const tm = tempFor(c.id);
                          return (
                            <div key={c.id} className="flex items-center gap-1.5">
                              <span className="text-xs text-muted dark:text-slate-400">{c.label}</span>
                              {tm && (
                                <span className="text-[11px] font-mono text-faint">
                                  {tm.actual != null ? `${Math.round(tm.actual)}°` : "—"} live · {tm.target ? `${Math.round(tm.target)}°` : "off"} set
                                </span>
                              )}
                              <input
                                value={nums[c.id] ?? (tm && tm.target != null ? String(Math.round(tm.target)) : "")}
                                onChange={(e) => setNums((nv) => ({ ...nv, [c.id]: e.target.value }))}
                                placeholder={c.unit}
                                className="input !py-0.5 !text-xs !w-16"
                              />
                              <button type="button" onClick={() => doRun(c, { value: Number(nums[c.id] ?? (tm?.target ?? 0)) || 0 })} disabled={run.isPending} className={btn}>Set</button>
                            </div>
                          );
                        })()
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[10px] text-faint">{lanActive ? "Commands route over your LAN bridge." : "Some printers reject third-party commands (e.g. Bambu Authorization Control). If nothing happens, that printer needs LAN control."}</p>
        </div>
      )}
    </>
  );
}

// Printer file timestamp (rr_filelist `date`, the machine's local time, no TZ) →
// a compact "26 Feb 2023" plus a relative hint for recent files.
function fmtFileDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 0) return date;
  if (days === 0) return `Today · ${date}`;
  if (days === 1) return `Yesterday · ${date}`;
  if (days < 30) return `${days}d ago · ${date}`;
  return date;
}

// Seconds → "2h 5m" / "45m". Shared by the job panel + per-file estimates.
function fmtDuration(s?: number): string | null {
  if (s == null || !Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Live print progress (Duet & any bridge that reports job): a bar + layer / time.
function JobPanel({ job }: { job: { fractionPrinted?: number; currentLayer?: number; timeLeftSec?: number; durationSec?: number } }) {
  const pct = job.fractionPrinted != null ? Math.round(job.fractionPrinted * 100) : null;
  return (
    <div className="space-y-1.5">
      {pct != null && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 rounded-full bg-subtle dark:bg-slate-800 overflow-hidden">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-mono text-content dark:text-mortar-100 shrink-0">{pct}%</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-faint">
        {job.currentLayer != null && <span>Layer {job.currentLayer}</span>}
        {fmtDuration(job.timeLeftSec) && <span>{fmtDuration(job.timeLeftSec)} left</span>}
        {fmtDuration(job.durationSec) && <span>{fmtDuration(job.durationSec)} elapsed</span>}
      </div>
    </div>
  );
}

// One file row. The slicer preview + estimate (fileInfo) load LAZILY — only once
// the row scrolls into view (IntersectionObserver) — and are hard-cached (30 min,
// immutable per file) both here and server-side, so the bridge is hit at most once
// per file the user actually looks at. NEVER eager-fetches the whole list.
function FileRow({
  slug, connId, deviceId, file, printing, onPrint, onZoom, fmtSize, printed,
}: {
  slug: string; connId: string; deviceId: string;
  file: { name: string; size?: number; modified?: string };
  printing: string | null;
  onPrint: (name: string) => void;
  onZoom?: (src: string) => void;
  fmtSize: (b?: number) => string;
  /** When this SD file matches a recent print, when + how it went. */
  printed?: { at: string; status: string } | null;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } },
      { root: el.closest("ul"), rootMargin: "150px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  const fq = useQuery({
    queryKey: ["digifab-fileinfo", slug, connId, deviceId, file.name],
    queryFn: () => api.getDigifabFileInfo(slug, connId, deviceId, file.name),
    enabled: visible,
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000, // keep the (heavy) thumbnail in memory across reopens — no re-fetch
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const fi: DigifabFileInfo | null = fq.data?.info ?? null;
  const thumb = fi?.thumbnail;
  return (
    <li ref={ref} className="px-2 py-1 text-xs">
      <div className="flex items-center gap-2">
        <div className="w-10 h-10 shrink-0 rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 overflow-hidden flex items-center justify-center">
          {thumb ? (
            <img src={thumb} alt="" className="w-full h-full object-contain cursor-zoom-in" onClick={() => onZoom?.(thumb)} />
          ) : (
            <span className="text-faint text-[9px]">{visible && fq.isFetching ? "…" : ""}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <button type="button" onClick={() => setExpanded((v) => !v)} className="block w-full truncate text-left text-content dark:text-mortar-100 hover:text-accent" title="Show print estimate">
            {file.name}
          </button>
          {file.modified && <div className="text-faint text-[10px]">{fmtFileDate(file.modified)}</div>}
        </div>
        {printed && (
          <span
            className={"shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded " + (printed.status === "completed" ? "text-moss-600 bg-moss-500/10" : "text-ember-600 bg-ember-500/10")}
            title={`Last printed ${new Date(printed.at).toLocaleString()} — ${printed.status}`}
          >
            {printed.status === "completed" ? "✓" : "✗"} {new Date(printed.at).toLocaleDateString()}
          </span>
        )}
        {file.size != null && <span className="text-faint font-mono shrink-0">{fmtSize(file.size)}</span>}
        <button type="button" onClick={() => onPrint(file.name)} disabled={printing === file.name} className="shrink-0 text-accent hover:underline disabled:opacity-50">
          {printing === file.name ? "Sending…" : "Print"}
        </button>
      </div>
      {expanded && (
        <div className="mt-1 pl-12 text-[11px] text-faint">
          {fq.isLoading ? (
            "Reading slicer info…"
          ) : !fi ? (
            "No slicer estimate in this file."
          ) : (
            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
              {fmtDuration(fi.printTimeSec) && <span>⏱ {fmtDuration(fi.printTimeSec)}</span>}
              {fi.filamentMm != null && <span>🧵 {(fi.filamentMm / 1000).toFixed(1)} m</span>}
              {fi.numLayers != null && <span>{fi.numLayers} layers</span>}
              {fi.height != null && <span>{fi.height} mm tall</span>}
              {fi.generatedBy && <span className="opacity-70">· {fi.generatedBy.split(/\s+/)[0]}</span>}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

// The gcode files already on the printer's storage. CACHED — the list is fetched
// once (5-min cache) and NEVER polled; each row's preview + estimate load lazily
// on scroll (see FileRow). The Refresh button forces a live re-read of the list.
/** Normalize a file/print name for matching: basename, extensions off, spaces
 *  collapsed, lowercase. "cache/Split .3mf" ↔ "Split" both → "split". */
function normPrintName(n: string): string {
  return n
    .replace(/^.*[\\/]/, "")
    .replace(/\.(gcode\.3mf|gcode|3mf|bgcode|stl|step)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function FilesPanel({ slug, connId, deviceId, onZoom, history, onOpenPrint, onReprint }: {
  slug: string; connId: string; deviceId: string; onZoom?: (src: string) => void;
  /** Recent prints on THIS device — rolled into the same surface: matching SD
   *  files get a printed-on chip; prints with no SD file left get a tail row. */
  history?: DigifabHistory["recent"];
  onOpenPrint?: (r: DigifabHistory["recent"][number]) => void;
  onReprint?: (r: DigifabHistory["recent"][number]) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [refreshing, setRefreshing] = useState(false);
  const [printing, setPrinting] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["digifab-files", slug, connId, deviceId],
    queryFn: () => api.getDigifabFiles(slug, connId, deviceId),
    staleTime: 15 * 60_000,
    gcTime: 15 * 60_000, // keep across modal close/reopen → no refetch within the window
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const files = q.data?.files ?? [];
  const [sort, setSort] = useState<"recent" | "oldest" | "name" | "size">("recent");
  const sorted = useMemo(() => {
    const t = (m?: string) => (m ? new Date(m).getTime() || 0 : 0);
    return [...files].sort((a, b) => {
      switch (sort) {
        case "name": return a.name.localeCompare(b.name, undefined, { numeric: true });
        case "size": return (b.size ?? 0) - (a.size ?? 0);
        case "oldest": return t(a.modified) - t(b.modified);
        default: return t(b.modified) - t(a.modified); // recent
      }
    });
  }, [files, sort]);
  const doPrint = async (name: string) => {
    if (!(await confirm({ title: `Print "${name}"?`, message: "This starts the print on the printer now.", confirmLabel: "Print" }))) return;
    setPrinting(name);
    try {
      await api.printDigifabFile(slug, connId, deviceId, name);
      toast.success(`Sent "${name}" — the print is starting.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the print");
    } finally {
      setPrinting(null);
    }
  };
  const fmtSize = (b?: number) =>
    b == null ? "" : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`;
  // Join history ↔ SD files by normalized name (containment either way, guarded
  // by length so "a" can't match everything). Matched prints annotate their file
  // row; unmatched ones become the "no longer on the card" tail below.
  const hist = history ?? [];
  const { printedFor, unmatched } = useMemo(() => {
    const printedFor = new Map<string, { at: string; status: string }>();
    const used = new Set<string>();
    for (const f of files) {
      const nf = normPrintName(f.name);
      if (nf.length < 4) continue;
      const m = hist.find((h) => {
        if (used.has(h.id)) return false;
        const nh = normPrintName(h.sub_label || h.file_ref);
        const nh2 = normPrintName(h.file_ref);
        const hit = (x: string) => x.length >= 4 && (nf.includes(x) || x.includes(nf));
        return hit(nh) || hit(nh2);
      });
      if (m) { printedFor.set(f.name, { at: m.at, status: m.status }); used.add(m.id); }
    }
    return { printedFor, unmatched: hist.filter((h) => !used.has(h.id)) };
  }, [files, hist]);
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(["digifab-files", slug, connId, deviceId], await api.getDigifabFiles(slug, connId, deviceId, true));
    } catch {
      /* keep the existing list on a failed refresh */
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted dark:text-slate-400">
          {q.isLoading ? "Loading…" : `${files.length} file${files.length === 1 ? "" : "s"}`}
          {q.data?.cached ? " · cached" : ""}
        </span>
        <button type="button" onClick={refresh} disabled={refreshing || q.isLoading} className="text-accent hover:underline disabled:opacity-50">
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {files.length > 1 && (
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="ml-auto bg-transparent text-muted dark:text-slate-400 border border-line dark:border-slate-700 rounded px-1 py-0.5 text-[11px]"
            title="Sort files"
          >
            <option value="recent">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
            <option value="size">Largest first</option>
          </select>
        )}
      </div>
      {!q.isLoading && files.length === 0 ? (
        <div className="text-xs text-muted dark:text-slate-400 italic">No files reported (this printer may not list them).</div>
      ) : (
        <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded max-h-72 overflow-y-auto">
          {sorted.map((f) => (
            <FileRow key={f.name} slug={slug} connId={connId} deviceId={deviceId} file={f} printing={printing} onPrint={doPrint} onZoom={onZoom} fmtSize={fmtSize} printed={printedFor.get(f.name)} />
          ))}
        </ul>
      )}
      {unmatched.length > 0 && (
        <>
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint pt-1">
            Printed before — file no longer on the printer
          </div>
          <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded max-h-48 overflow-y-auto">
            {unmatched.map((r) => (
              <li key={r.id} className="px-2 py-1 text-xs flex items-center gap-2">
                {r.cover ? (
                  <img src={r.cover} alt="" loading="lazy" className="w-10 h-10 rounded object-cover bg-subtle shrink-0 border border-line dark:border-slate-700" />
                ) : (
                  <span className={"w-10 h-10 rounded shrink-0 flex items-center justify-center border border-line dark:border-slate-700 " + (r.status === "completed" ? "bg-moss-500/10" : "bg-ember-500/10")}>
                    <span className={"w-1.5 h-1.5 rounded-full " + (r.status === "completed" ? "bg-moss-500" : "bg-ember-500")} />
                  </span>
                )}
                <button type="button" onClick={() => onOpenPrint?.(r)} className="flex-1 min-w-0 text-left hover:text-accent">
                  <span className="block truncate text-content dark:text-mortar-100">{r.file_ref}</span>
                  <span className="block truncate text-faint text-[10px]">{r.sub_label && r.sub_label !== r.file_ref ? r.sub_label + " · " : ""}{new Date(r.at).toLocaleDateString()}</span>
                </button>
                {onReprint && isReprintable(r) && (
                  <button type="button" onClick={() => onReprint(r)} className="shrink-0 text-accent hover:underline">
                    Print again
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// A full-screen image viewer — click anywhere to close. Portals to body so the
// header's backdrop-blur can't trap it.
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-6 cursor-zoom-out" onClick={onClose}>
      <img src={src} alt="" className="max-w-full max-h-full object-contain rounded shadow-2xl" />
    </div>,
    document.body,
  );
}

// Live LAN camera — the Bambu chamber camera, grabbed frame-by-frame over the
// bridge (one JPEG every ~3s; a refreshing still, not a stream).
function LanCameraView({ slug, connId, deviceId, name, onZoom }: { slug: string; connId: string; deviceId: string; name: string; onZoom?: (src: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    // Instant: show the last cached frame (server-cached on the previous grab) so
    // there's no "connecting" gap on open; the live poll below replaces it the
    // moment a fresh frame decodes.
    void fetchAuthBlobUrl(api.digifabSnapshotPath(slug, connId, deviceId)).then((cached) => {
      if (!alive) { if (cached) URL.revokeObjectURL(cached); return; }
      if (cached && !current) { setUrl(cached); current = cached; }
      else if (cached) URL.revokeObjectURL(cached);
    });
    const tick = async () => {
      const next = await fetchAuthBlobUrl(api.digifabCameraPath(slug, connId, deviceId));
      if (!alive) { if (next) URL.revokeObjectURL(next); return; }
      if (!next) { if (!current) setFailed(true); return; }
      // Double-buffer: decode the new frame OFF-SCREEN, then swap. Swapping the
      // <img> src directly let it flash empty between frames — the refresh
      // flicker. We only show the new blob once it's fully decoded.
      const probe = new Image();
      probe.onload = () => {
        if (!alive) { URL.revokeObjectURL(next); return; }
        setUrl(next); setFailed(false);
        if (current) URL.revokeObjectURL(current);
        current = next;
      };
      probe.onerror = () => { URL.revokeObjectURL(next); if (!current) setFailed(true); };
      probe.src = next;
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId]);
  if (failed && !url) return <div className="text-[11px] text-faint italic">Camera not reachable over LAN yet (bridge online + LAN access on the printer?).</div>;
  if (!url) return <div className="text-[11px] text-faint">Connecting to the camera…</div>;
  return <img src={url} alt={`${name} camera`} className="w-full max-h-72 object-contain rounded bg-black/30 cursor-zoom-in" onClick={() => onZoom?.(url)} />;
}

// Per-printer Bambu LAN access (hybrid). Cloud keeps doing telemetry; enabling
// LAN here routes file-push + control through your on-site bridge. Bambu-only.
function LanAccessPanel({ slug, connId, deviceId, lan }: { slug: string; connId: string; deviceId: string; lan?: { applicable: boolean; configured: boolean; host?: string; mode?: "cloud" | "prefer_lan" | "lan_only" } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  // The corner shows a tiny affordance; the actual config (mode picker / setup /
  // remove) opens in a roomy modal — cramming the mode cards into the narrow
  // header column looked bad.
  const [open, setOpen] = useState(false);
  const inval = () => void qc.invalidateQueries({ queryKey: ["digifab-device-detail", slug, connId, deviceId] });
  const save = useMutation({
    mutationFn: () => api.setBambuLan(slug, connId, deviceId, { host: host.trim(), access_code: code.trim() }),
    onSuccess: () => { toast.success("LAN access saved"); setCode(""); inval(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save LAN access"),
  });
  const clear = useMutation({
    mutationFn: () => api.clearBambuLan(slug, connId, deviceId),
    onSuccess: () => { toast.success("LAN access removed"); setOpen(false); inval(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove LAN access"),
  });
  const setMode = useMutation({
    mutationFn: (mode: "cloud" | "prefer_lan" | "lan_only") => api.setBambuLan(slug, connId, deviceId, { mode }),
    onSuccess: () => { toast.success("Mode updated"); setOpen(false); inval(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't update mode"),
  });
  const MODES: { key: "cloud" | "prefer_lan" | "lan_only"; label: string; desc: string }[] = [
    { key: "cloud", label: "All cloud", desc: "Status, control & history via Bambu's cloud. Works anywhere; no bridge." },
    { key: "prefer_lan", label: "Prefer LAN", desc: "Status, control & file-push over your LAN/bridge; cloud fills in print-history names. Cloud is the fallback." },
    { key: "lan_only", label: "LAN only", desc: "Everything local, cloud off — no internet needed, max privacy. You lose cloud-only print-history names/covers." },
  ];
  if (!lan?.applicable) return null;
  const field = "px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const modeLabel = MODES.find((m) => m.key === (lan.mode ?? "cloud"))?.label ?? "All cloud";

  return (
    <>
      {/* Tiny corner affordance — opens the roomy config modal. */}
      {lan.configured ? (
        <button type="button" onClick={() => setOpen(true)} title="LAN access settings" className="flex items-center gap-1.5 text-faint hover:text-content dark:hover:text-mortar-100 transition">
          <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
          <span className="text-content dark:text-mortar-200">{modeLabel}</span>
          <Sliders size={11} />
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1 text-accent hover:underline">
          <Wifi size={11} /> Set up LAN access
        </button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="LAN access" subtitle="file-push + control via your bridge" size="sm">
        {lan.configured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
              <span className="text-content dark:text-mortar-100">Connected via <span className="font-mono">{lan.host}</span></span>
              <div className="flex-1" />
              <button type="button" onClick={() => clear.mutate()} disabled={clear.isPending} className="text-faint hover:text-ember-500">Remove</button>
            </div>
            <div className="space-y-1.5">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMode.mutate(m.key)}
                  disabled={setMode.isPending || lan.mode === m.key}
                  className={"w-full text-left rounded border px-3 py-2 " + (lan.mode === m.key ? "border-accent bg-accent/5" : "border-line dark:border-slate-700 hover:border-accent/50")}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className={"w-3.5 h-3.5 rounded-full border shrink-0 " + (lan.mode === m.key ? "border-accent bg-accent" : "border-line dark:border-slate-600")} />
                    <span className="text-content dark:text-mortar-100 font-medium">{m.label}</span>
                  </div>
                  <div className="text-faint text-xs pl-[1.375rem] mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-1.5">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Printer IP — 192.168.1.x" className={field + " flex-1"} />
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code" className={field + " w-32"} />
              <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !host.trim() || !code.trim()} className="px-2.5 py-1 text-xs rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">{save.isPending ? "…" : "Enable"}</button>
            </div>
            <span className="text-[11px] text-faint">On the printer: Settings → network for its IP + Access Code. Needs your edge bridge online on the same LAN.</span>
          </div>
        )}
      </Modal>
    </>
  );
}

// A temperature read-out: the LIVE value on top, the SET target below, each
// labelled so there's no "which number is which" ambiguity (no bare arrow). The
// "live"/"set" tags only show when there's a target to disambiguate against
// (chamber has none → just the current reading).
function TempStat({ label, actual, target }: { label: string; actual: number | null | undefined; target?: number | null }) {
  return (
    <div className="rounded border border-line dark:border-slate-700 p-1.5">
      <div className="text-faint text-[10px]">{label}</div>
      <div className="text-content dark:text-mortar-100 leading-tight">
        {actual == null ? "—" : `${Math.round(actual)}°`}
        {actual != null && target != null && <span className="text-faint text-[10px] ml-1">live</span>}
      </div>
      {target != null && target > 0 && (
        <div className="text-faint leading-tight">{Math.round(target)}° <span className="text-[10px]">set</span></div>
      )}
    </div>
  );
}

// The full printer modal — identity + image, live telemetry (temps/AMS/light/
// firmware), controls, link-to-machine, and THIS printer's history, in one place.
function PrinterDetailModal({ slug, connId, device, onClose }: { slug: string; connId: string; device: DigifabFleetDevice; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [printOpen, setPrintOpen] = useState<DigifabHistory["recent"][number] | null>(null);
  const [linkEdit, setLinkEdit] = useState(false);
  const detail = useQuery({ queryKey: ["digifab-device-detail", slug, connId, device.id], queryFn: () => api.getDigifabDeviceDetail(slug, connId, device.id), refetchInterval: 10_000 });
  const machines = useQuery({ queryKey: ["digifab-all-machines", slug], queryFn: () => fetchAllMachines(slug) });
  const links = useQuery({ queryKey: ["digifab-links", slug], queryFn: () => api.listDigifabLinks(slug) });
  const history = useQuery({ queryKey: ["digifab-history", slug, 365], queryFn: () => api.getDigifabHistory(slug, 365) });
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["digifab-links", slug] }); void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] }); };
  const link = useMutation({
    mutationFn: async (m: LinkableMachine | null): Promise<void> => {
      const cur = (links.data?.items ?? []).find((l) => l.connection_id === connId && l.remote_device_id === device.id);
      if (!m) { if (cur) await api.deleteDigifabLink(slug, cur.id); return; }
      await api.createDigifabLink(slug, { connection_id: connId, remote_device_id: device.id, remote_device_name: device.name, machine_id: m.id, machine_label: m.name });
    },
    onSuccess: () => { toast.success("Updated machine link"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't update link"),
  });

  // "Print again" — clone the source job + send. Only history rows backed by a
  // Cobblr job can be cloned; Bambu cloud tasks (id "task:…") are view-only.
  const reprint = useMutation({
    mutationFn: (jobId: string) => api.reprintDigifabJob(slug, jobId),
    onSuccess: (r) => {
      toast[r.sent === false && !r.pooled ? "info" : "success"](
        r.pooled ? "Queued to the pool — auto-assigns to a free printer" : r.sent ? "Sent — printing again" : `Queued — send it from the print queue${r.reason ? ` (${r.reason})` : ""}`,
      );
      void qc.invalidateQueries({ queryKey: ["digifab-jobs", slug] });
      void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't reprint"),
  });
  const askReprint = async (r: DigifabHistory["recent"][number]) => {
    const ok = await confirm({
      title: `Print "${r.file_ref}" again?`,
      message: "Clones the original job — same file, routing, material and build — and sends it to the printer. On a live farm this physically starts the print.",
      confirmLabel: "Print again",
      destructive: true,
    });
    if (ok) reprint.mutate(r.id);
  };

  const t = detail.data?.telemetry;
  const machineList = machines.data?.items ?? [];
  const linkedId = device.linked_machine_id;
  const linkedMachine = machineList.find((m) => m.id === linkedId) ?? null;
  const machineImg = useImageSrc(linkedMachine?.image ? (/^https?:/i.test(linkedMachine.image) ? linkedMachine.image : api.fileRawUrl(slug, linkedMachine.image)) : null);
  // Match by device IDENTITY when the row carries it (Cobblr jobs), falling back
  // to display name (Bambu cloud tasks only have names). Fixes the audit B2.6
  // hole where raw device ids / renames silently orphaned a printer's history.
  const mine = (history.data?.recent ?? [])
    .filter((r) => (r.device_id ? r.connection_id === connId && r.device_id === device.id : r.device === device.name))
    .slice(0, 24); // enough to annotate the file list + a meaningful history tail
  const lbl = "text-[10px] font-mono uppercase tracking-widest text-faint";

  return (
    <>
      <Modal open onClose={onClose} title={device.name} size="xl">
        {/* Cockpit: a wide two-column dashboard. LEFT = watch (camera + progress +
            live temps + filament); RIGHT = do (controls + files). Everything the
            operator needs is on one screen — secondary detail (recent prints) is a
            collapsible so the default view fits without scrolling. */}
        <div className="space-y-3">
          {/* Header strip — status pills + machine link + LAN, all on one wrapping row. */}
          <div className="flex flex-wrap items-center gap-2 text-xs pb-2 border-b border-line dark:border-slate-800">
            <span className="px-1.5 py-0.5 rounded bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100">{device.state}</span>
            {device.pool_name && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">{device.pool_name}</span>}
            {!device.enabled && <span className="px-1.5 py-0.5 rounded bg-ember-500/10 text-ember-600">disabled</span>}
            {t?.firmware_update && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">firmware update</span>}
            {t && t.hms_count > 0 && <span className="px-1.5 py-0.5 rounded bg-ember-500/15 text-ember-600">{t.hms_count} alert{t.hms_count > 1 ? "s" : ""}</span>}
            {t && (t.nozzle_diameter || t.nozzle_type) && <span className="text-faint">Nozzle {t.nozzle_diameter}mm {t.nozzle_type?.replace(/_/g, " ")}</span>}
            {t?.wifi && <span className="text-faint">Wi-Fi {t.wifi}</span>}
            <div className="flex-1 min-w-[8rem]" />
            <div className="text-muted dark:text-slate-400">
              {linkedMachine ? <>Linked to <span className="text-accent">{linkedMachine.name}{linkedMachine.instLabel ? ` · ${linkedMachine.instLabel}` : ""}</span></> : <span className="text-faint italic">Not linked to a machine</span>}
              <button type="button" onClick={() => setLinkEdit((v) => !v)} className="text-accent hover:underline ml-1.5">{linkEdit ? "close" : linkedMachine ? "change" : "link"}</button>
            </div>
          </div>
          {linkEdit && (
            <Combobox
              value={linkedId ?? ""}
              allowClear
              placeholder="— link to a machine —"
              options={machineList.map((m) => ({ value: m.id, label: m.instLabel ? `${m.name} · ${m.instLabel}` : m.name }))}
              onChange={(id) => { link.mutate(id ? (machineList.find((m) => m.id === id) ?? null) : null); setLinkEdit(false); }}
            />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* LEFT — watch. */}
            <div className="space-y-3 min-w-0">
              {detail.data?.lan?.camera ? (
                <LanCameraView slug={slug} connId={connId} deviceId={device.id} name={device.name} onZoom={setLightbox} />
              ) : machineImg ? (
                <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 overflow-hidden aspect-video">
                  <img src={machineImg} alt={device.name} className="w-full h-full object-cover cursor-zoom-in" onClick={() => setLightbox(machineImg)} />
                </div>
              ) : null}
              {detail.data?.job && (
                <div>
                  <div className={lbl + " mb-1"}>Printing</div>
                  <JobPanel job={detail.data.job} />
                </div>
              )}
              {t && (
                <div>
                  <div className={lbl + " mb-1"}>Live</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <TempStat label="Nozzle" actual={t.nozzle} target={t.nozzle_target} />
                    <TempStat label="Bed" actual={t.bed} target={t.bed_target} />
                    <TempStat label="Chamber" actual={t.chamber} />
                  </div>
                  {t.ams.length > 0 && (
                    <div className="mt-2">
                      <div className={lbl + " mb-1"}>Filament (AMS)</div>
                      <div className="flex flex-wrap gap-1.5">
                        {t.ams.map((s) => (
                          <span key={s.id} className="inline-flex items-center gap-1.5 text-[11px] rounded border border-line dark:border-slate-700 px-1.5 py-0.5">
                            <span className="w-3 h-3 rounded-full border border-black/20" style={{ backgroundColor: s.color ?? "transparent" }} />
                            <span className="text-content dark:text-mortar-100">{s.type ?? "?"}</span>
                            {s.remain != null && s.remain > 0 && <span className="text-faint">{s.remain}%</span>}
                            {s.id === "ext" && <span className="text-faint text-[10px]">ext</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {detail.data && detail.data.live === false && <div className="text-[11px] text-faint italic">No live cloud telemetry for this printer.</div>}
              {detail.data?.lan?.applicable && (
                <LanAccessPanel slug={slug} connId={connId} deviceId={device.id} lan={detail.data?.lan} />
              )}
            </div>

            {/* RIGHT — do. */}
            <div className="space-y-3 min-w-0">
              <div>
                <div className={lbl + " mb-1.5"}>Controls</div>
                <ControlsPanel slug={slug} connId={connId} deviceId={device.id} name={device.name} telemetry={t} lanActive={!!detail.data?.lan?.configured && detail.data?.lan?.mode !== "cloud"} />
              </div>
            </div>
          </div>

          {/* ON THIS PRINTER — first-class, FULL-WIDTH below the watch/do columns.
              ONE rolled-together surface (the author: the separate Files + Recent-prints
              sections read as two things when they answer the same question —
              "what can I print / print again?"): the SD-card files (each with a
              printed-on chip when a recent print matches by name, and a Print
              button), plus a tail of prints whose file is no longer on the card
              (view detail; Print-again when a Cobblr job backs it). */}
          <div className="pt-3 border-t border-line dark:border-slate-800">
            <div className={lbl + " mb-1.5"}>On {device.name} — files &amp; prints</div>
            <FilesPanel
              slug={slug}
              connId={connId}
              deviceId={device.id}
              onZoom={setLightbox}
              history={mine}
              onOpenPrint={setPrintOpen}
              onReprint={(r) => void askReprint(r)}
            />
          </div>
        </div>
      </Modal>
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {printOpen && <PrintDetailModal item={printOpen} onClose={() => setPrintOpen(null)} onZoom={setLightbox} onReprint={(r) => { setPrintOpen(null); void askReprint(r); }} />}
    </>
  );
}

// A single print's detail — large cover (click to zoom) + the metadata.
function PrintDetailModal({ item, onClose, onZoom, onReprint }: { item: DigifabHistory["recent"][number]; onClose: () => void; onZoom?: (src: string) => void; onReprint?: (r: DigifabHistory["recent"][number]) => void }) {
  const durMin = item.duration_s ? Math.round(item.duration_s / 60) : 0;
  const dur = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : durMin > 0 ? `${durMin}m` : null;
  const row = (k: string, v: ReactNode) => (v ? <div className="flex justify-between gap-3 text-xs py-1 border-b border-line dark:border-slate-800 last:border-0"><span className="text-faint">{k}</span><span className="text-content dark:text-mortar-100 text-right">{v}</span></div> : null);
  return (
    <Modal open onClose={onClose} title={item.file_ref} size="md">
      <div className="space-y-3">
        {item.cover && (
          <img src={item.cover} alt="" className="w-full max-h-72 object-contain rounded bg-subtle dark:bg-slate-800 cursor-zoom-in" onClick={() => onZoom?.(item.cover!)} />
        )}
        <div>
          {row("Status", <span className={item.status === "completed" ? "text-moss-600" : item.status === "failed" ? "text-ember-600" : ""}>{item.status}</span>)}
          {row("Profile", item.sub_label)}
          {row("Printer", item.device)}
          {row("Filament", item.filament_g != null ? `${Math.round(item.filament_g)} g` : null)}
          {row("Print time", dur)}
          {row("When", new Date(item.at).toLocaleString())}
        </div>
        {onReprint && isReprintable(item) && (
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => onReprint(item)}
              className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
            >
              <RefreshCw size={13} /> Print again
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Pools ──────────────────────────────────────────────────────────────────
// A pool is a Cobblr-native set of machines (possibly across connections) you
// queue jobs onto; the assignment worker drips queued pool jobs onto free
// members. This is how you aggregate a pile of individual printers into one
// farm — the FDM-Monster-replacement core.

// F-10 — add several machines to a pool at once (building a 50-member pool one
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
          No pools. A pool is a set of machines you queue jobs onto — Cobblr drips each job onto the next free one. Great for running many printers as one farm.
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
              <b className="text-content dark:text-mortar-100">Connect to each printer directly</b> — recreate every printer as its own Cobblr
              connection (OctoPrint, Klipper, … matched per printer) and pool them. Drops FDM Monster from the path.
            </span>
          </label>
          <label className="flex items-start gap-2 text-[13px] cursor-pointer">
            <input type="radio" checked={mode === "mirror"} onChange={() => setMode("mirror")} className="mt-0.5" />
            <span>
              <b className="text-content dark:text-mortar-100">Keep FDM Monster, mirror its printers</b> — add one FDM Monster connection and a
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

  const rows = useMemo(() => parseBulk(text), [text]);

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
        printers: rows.map((r) => ({ name: r.name, url: r.url, api_key: r.apiKey, type: detected[r.url] ?? undefined })),
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
          Paste a list of printer URLs — Cobblr makes one direct connection per line and (optionally) groups them into a pool.
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
          <span className={lbl}>Printers — one per line</span>
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
                    {det === undefined ? (
                      <span className="text-[10px] font-mono text-faint shrink-0">{firmwareLabel(defaultType)}</span>
                    ) : det ? (
                      <span className="text-[10px] font-mono text-moss-600 dark:text-moss-400 shrink-0">✓ {firmwareLabel(det)}</span>
                    ) : (
                      <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400 shrink-0" title="not detected — default applies">? {firmwareLabel(defaultType)}</span>
                    )}
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
