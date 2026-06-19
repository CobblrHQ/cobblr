// /configuration/digifab — Digital Fabrication. Manage connections to the
// software that runs your machines (FDM Monster, OctoPrint, …): add one,
// test it, list its printers, link printers to machines, and run the job
// queue. Sending a file to be made is a deliberate action — the Send
// button is behind an explicit confirm. We send files, never drive hardware.

import { useState, useMemo, useEffect, useRef } from "react";
import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wifi, Printer, RefreshCw, Send, ListChecks, Boxes, AlertTriangle, Layers, X, ListPlus, Ban, Camera, Pause, Play, Thermometer } from "lucide-react";
import { ApiError, api, fetchAuthBlobUrl, type DigifabConnection, type DigifabJob, type DigifabFleetDevice, type DigifabDeviceClass } from "../lib/api";
import { BambuConnectWizard } from "../components/BambuConnectWizard";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { Combobox } from "../components/Combobox";

export function DigifabPage() {
  usePageTitle("Digital Fabrication");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [driversOpen, setDriversOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [printersFor, setPrintersFor] = useState<DigifabConnection | null>(null);

  const list = useQuery({
    queryKey: ["digifab-connections", activeSlug],
    queryFn: () => api.listDigifabConnections(activeSlug),
    enabled: !!activeSlug,
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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Digital Fabrication</h1>
        <span className="text-sm text-muted dark:text-slate-400">{items.length} connection{items.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
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
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Add connection
        </button>
      </div>

      <p className="text-sm text-muted dark:text-slate-400">
        Connect to the software that runs your machines — FDM Monster, OctoPrint, and friends. Send a file to be made, map its
        printers to your machines, then queue and send print jobs that track to completion.
      </p>

      {items.length > 0 && <FleetView slug={activeSlug} />}
      {items.length > 0 && <PoolsSection slug={activeSlug} />}

      <h2 className="text-sm font-semibold text-content dark:text-mortar-100 pt-2">Connections</h2>
      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No connections yet. Add one to point Cobblr at your machine manager.
        </div>
      )}

      <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {items.map((c) => (
          <li key={c.id} className="px-3 py-2.5 flex items-center gap-3">
            <Printer size={16} className="text-faint shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content dark:text-mortar-100 truncate flex items-center gap-2">
                {c.label}
                <span className="text-[10px] font-mono uppercase tracking-wider text-faint">{c.type}</span>
                {c.capabilities?.routing && (
                  <span className="text-[10px] font-mono text-moss-600 dark:text-moss-400">routing</span>
                )}
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
              onClick={() => setPrintersFor(c)}
              title="List printers"
              className="text-faint hover:text-accent transition p-1.5"
            >
              <Printer size={15} />
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove "${c.label}"?`,
                  message: "Deletes the connection + its stored credentials. Print history isn't sent anywhere.",
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
          </li>
        ))}
      </ul>

      {items.length > 0 && <PrintQueueSection connections={items} />}

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
      {printersFor && <PrintersModal connection={printersFor} onClose={() => setPrintersFor(null)} />}
      {driversOpen && <DriversModal onClose={() => setDriversOpen(false)} />}
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
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["digifab-drivers", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
  };
  const install = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifest);
      } catch {
        throw new ApiError(400, "bad_json", "Manifest isn't valid JSON");
      }
      return api.installDigifabDriver(activeSlug, parsed);
    },
    onSuccess: (d) => {
      toast.success(`Installed "${d.name}"`);
      setManifest("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
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
        install your own by pasting a declarative manifest — no deploy. Installed drivers appear in
        the <span className="font-medium">Add connection</span> dropdown.
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

      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Install a declarative driver</div>
      <textarea
        value={manifest}
        onChange={(e) => setManifest(e.target.value)}
        rows={8}
        placeholder={'{\n  "id": "octoprint",\n  "name": "OctoPrint",\n  "auth": { "kind": "header", "header": "X-Api-Key", "from": "apiKey" },\n  "test": { "method": "GET", "path": "/api/version" },\n  ...\n}'}
        className={field}
      />
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Close</button>
        <button
          onClick={() => install.mutate()}
          disabled={install.isPending || !manifest.trim()}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          {install.isPending ? "Installing…" : "Install driver"}
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
const canSend = (j: DigifabJob) => j.status === "queued" && !j.remote_job_id && !j.target_pool;
const canPoll = (j: DigifabJob) => !!j.remote_job_id && !TERMINAL_JOB(j.status);
const canCancel = (j: DigifabJob) => !TERMINAL_JOB(j.status);
// Safe to delete from the queue only when it's not physically on a printer.
const canDelete = (j: DigifabJob) => j.status !== "sent" && j.status !== "printing";
// F-14: a job that matched 0 or many printers can be re-pointed at a specific one.
const canAssign = (j: DigifabJob) => j.status === "awaiting-assignment" && !!j.connection_id;

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

function PrintQueueSection({ connections }: { connections: DigifabConnection[] }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [newOpen, setNewOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set()); // F-10: bulk selection

  // F-5: paginated (no silent 200-cap) + F-8: live — refetch every 5s while any
  // job is non-terminal, so pool auto-assignment and print progress update on
  // their own (the server worker advances them; the UI just needs to re-read).
  const jobs = useInfiniteQuery({
    queryKey: ["digifab-jobs", activeSlug],
    queryFn: ({ pageParam }) => api.listDigifabJobs(activeSlug, { limit: 50, cursor: pageParam }),
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

  const items = jobs.data?.pages.flatMap((p) => p.items) ?? [];

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
      <div className="flex items-center gap-3 border-b border-line dark:border-slate-700 pb-2">
        {items.length > 0 && (
          <input type="checkbox" checked={allChecked} onChange={toggleAll} title="Select all" className="shrink-0" />
        )}
        <ListChecks size={16} className="text-accent" />
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Print queue</h2>
        <span className="text-[11px] text-faint">{items.length} job{items.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
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

      {jobs.isLoading && <div className="text-sm text-muted">Loading queue…</div>}
      {items.length === 0 && !jobs.isLoading && (
        <div className="text-[13px] text-muted dark:text-slate-400 italic">
          No jobs queued. Create one — then <span className="font-medium">Send</span> it to the farm when you're ready.
        </div>
      )}

      <ul className="divide-y divide-line dark:divide-slate-800">
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
            <li key={jb.id} className="py-2.5 flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={sel.has(jb.id)}
                onChange={() => toggleSel(jb.id)}
                className="shrink-0"
                title="Select"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] text-content dark:text-mortar-100 truncate">{jb.file_ref}</span>
                  <span className={"text-[10px] px-1.5 py-0.5 rounded font-medium " + (JOB_STATUS_STYLE[jb.status] ?? "text-muted bg-subtle")}>
                    {jb.status}
                  </span>
                  {jb.status === "printing" && jb.progress != null && (
                    <span className="text-[11px] text-accent">{Math.round(jb.progress * 100)}%</span>
                  )}
                </div>
                <div className="text-[11px] text-faint truncate">
                  {conn?.label ?? "—"} · {target}
                  {jb.error && <span className="text-ember-500"> · {jb.error}</span>}
                </div>
              </div>
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
    </section>
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

  const machines = useQuery({
    queryKey: ["machines", activeSlug],
    queryFn: () => api.listMachines(activeSlug),
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
        file_id: fileId || null,
        linked_machine_id: routeBy === "machine" ? machineId || null : null,
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
        <label className="block">
          <span className={lbl}>Route by</span>
          <select value={routeBy} onChange={(e) => setRouteBy(e.target.value as typeof routeBy)} className={field}>
            <option value="file">File routing (from the filename)</option>
            <option value="machine">A linked machine</option>
            <option value="printer">A specific printer</option>
            <option value="tag">A tag (printer group)</option>
            <option value="pool">A pool (auto-assign to a free printer)</option>
          </select>
        </label>
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
              options={machineList.map((m) => ({ value: m.id, label: m.name }))}
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

function CreateConnectionModal({
  types,
  onClose,
  onCreated,
}: {
  types: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [type, setType] = useState(types[0] ?? "fdm_monster");
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
    onSuccess: () => {
      toast.success("Connection added");
      onCreated();
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
          <BambuConnectWizard onConnected={() => onCreated()} onCancel={onClose} />
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

function PrintersModal({ connection, onClose }: { connection: DigifabConnection; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const printers = useQuery({
    queryKey: ["digifab-printers", activeSlug, connection.id],
    queryFn: () => api.listDigifabDevices(activeSlug, connection.id),
  });
  const machines = useQuery({
    queryKey: ["machines", activeSlug],
    queryFn: () => api.listMachines(activeSlug),
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
    <Modal open onClose={onClose} title={`${connection.label} — printers`} size="md">
      {printers.isLoading && <div className="text-sm text-muted">Loading printers…</div>}
      {printers.isError && <div className="text-sm text-ember-500">Couldn't reach the farm — test the connection.</div>}
      {!printers.isLoading && !printers.isError && items.length === 0 && (
        <div className="text-sm text-muted italic">No printers reported.</div>
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
                options={machineList.map((m) => ({ value: m.id, label: m.name }))}
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
      <p className="mt-3 text-[11px] text-faint">
        Link a farm printer to one of your machines — a job linked to that machine then routes to its printer automatically.
      </p>
    </Modal>
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

function FleetStat({ dot, n, label }: { dot: string; n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {n} {label}
    </span>
  );
}

function FleetView({ slug }: { slug: string }) {
  const fleet = useQuery({
    queryKey: ["digifab-fleet", slug],
    queryFn: () => api.getDigifabFleet(slug),
    enabled: !!slug,
    refetchInterval: 12_000,
  });
  const data = fleet.data;
  if (!data) return null;
  const s = data.summary;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Fleet</h2>
        <div className="flex items-center gap-3 text-xs font-mono text-muted dark:text-slate-400">
          <span>{s.devices} machine{s.devices === 1 ? "" : "s"}</span>
          {s.printing > 0 && <FleetStat dot="bg-cobble-500" n={s.printing} label="printing" />}
          {s.idle > 0 && <FleetStat dot="bg-moss-500" n={s.idle} label="idle" />}
          {s.error > 0 && <FleetStat dot="bg-ember-500" n={s.error} label="error" />}
          {s.offline > 0 && <FleetStat dot="bg-faint" n={s.offline} label="offline" />}
          {s.needs_attention > 0 && <FleetStat dot="bg-amber-500" n={s.needs_attention} label="need clearing" />}
        </div>
        <div className="flex-1" />
        {fleet.isFetching && <RefreshCw size={13} className="animate-spin text-faint" />}
      </div>
      {(() => {
        // Group machines by POOL (a pool reads as one farm even across
        // connections); unpooled machines fall back to their connection. A
        // dead manager keeps its own error row.
        type FDev = DigifabFleetDevice & { connLabel: string; connId: string };
        const errored = data.connections.filter((c) => c.error);
        const all: FDev[] = data.connections
          .filter((c) => !c.error)
          .flatMap((c) => c.devices.map((d) => ({ ...d, connLabel: c.label, connId: c.connection_id })));
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
        const sections: Array<{ key: string; label: string | null; isPool: boolean; devices: FDev[] }> = [];
        for (const [id, g] of pools) sections.push({ key: `pool:${id}`, label: g.name, isPool: true, devices: g.devices });
        const showConn = unpooled.size > 1 || pools.size > 0;
        for (const [label, devs] of unpooled) sections.push({ key: `conn:${label}`, label: showConn ? label : null, isPool: false, devices: devs });
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
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {sec.devices.map((d) => (
                    <DeviceCard key={`${sec.key}:${d.id}`} d={d} connId={d.connId} slug={slug} />
                  ))}
                </div>
              </div>
            ))}
            {errored.map((c) => (
              <div key={c.connection_id} className="flex items-center gap-1.5 text-xs text-ember-600 dark:text-ember-500">
                <AlertTriangle size={13} className="shrink-0" /> {c.label} unreachable — {c.error}
              </div>
            ))}
            {sections.length === 0 && errored.length === 0 && (
              <div className="text-xs text-faint italic">No machines reported.</div>
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

// The relayed snapshot: auth-fetch the latest agent-pushed frame to a blob URL
// and refresh it every few seconds (a near-live thumbnail for remote viewers).
function RelaySnapshot({ slug, connId, deviceId, name }: { slug: string; connId: string; deviceId: string; name: string }) {
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
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId]);
  if (!url) return null;
  return <img src={url} alt={`${name} camera`} className="mb-1.5 w-full h-24 object-cover rounded bg-black/30" />;
}

function DeviceCard({ d, connId, slug }: { d: DigifabFleetDevice; connId: string; slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const st = KLASS_STYLE[d.klass];
  const pct = d.active_job?.progress != null ? Math.round(d.active_job.progress * 100) : null;
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
  const relay = useMutation({
    mutationFn: (enabled: boolean) => api.setDigifabDeviceSnapshotRelay(slug, connId, d.id, enabled),
    onSuccess: (_r, enabled) => { toast.success(enabled ? "Snapshot relay on" : "Snapshot relay off"); invalidateFleet(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const att = d.needs_attention;
  const nozzle = tempLabel(d.temps?.nozzle);
  const bed = tempLabel(d.temps?.bed);
  const chamber = tempLabel(d.temps?.chamber);
  const job = d.active_job;
  return (
    <div className={`rounded-lg border ${att ? "border-amber-400 dark:border-amber-700" : st.ring} bg-subtle dark:bg-slate-800/50 p-2.5 ${d.enabled ? "" : "opacity-50"}`}>
      {/* Cockpit: a live camera feed. When the snapshot relay is on + a fresh
          agent-pushed frame exists, show that (remote-viewable, auth-fetched);
          otherwise embed the LAN camera stream directly. */}
      {d.snapshot_relay && d.snapshot_fresh ? (
        <RelaySnapshot slug={slug} connId={connId} deviceId={d.id} name={d.name} />
      ) : d.camera_url ? (
        <img
          src={d.camera_url}
          alt={`${d.name} camera`}
          className="mb-1.5 w-full h-24 object-cover rounded bg-black/30"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
        <div className="text-sm font-medium text-content dark:text-mortar-100 truncate" title={d.name}>{d.name}</div>
        <div className="flex-1" />
        <button
          onClick={() => { setCamUrl(d.camera_url ?? ""); setCamOpen((o) => !o); }}
          title={d.camera_url ? "Edit camera URL" : "Add a camera URL"}
          className={`p-0.5 transition ${d.camera_url ? "text-accent" : "text-faint hover:text-accent"}`}
        >
          <Camera size={13} />
        </button>
      </div>
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
          </div>
          {job.status === "paused" && <div className="text-[10px] font-mono uppercase tracking-wider text-amber-600 mt-0.5">paused</div>}
          {pct != null && (
            <>
              <div className="mt-1 h-1 rounded bg-line dark:bg-slate-700 overflow-hidden">
                <div className={`h-full transition-[width] ${job.status === "paused" ? "bg-amber-500" : "bg-cobble-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10px] font-mono text-faint mt-0.5">{pct}%</div>
            </>
          )}
        </div>
      )}
    </div>
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
                    <input type="checkbox" checked={sel.has(key)} onChange={() => toggle(key)} />
                    <span className="truncate">{d.name}</span>
                    <span className="text-[10px] text-faint truncate ml-auto">{d.connLabel}</span>
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
      <div className="flex items-center gap-3 border-b border-line dark:border-slate-700 pb-2">
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
            className="px-2 py-1 text-xs border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 w-40"
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
